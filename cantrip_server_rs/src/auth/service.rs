use super::{
    ActiveSession, SessionState, UserSummary,
    cookie::{CookiePolicy, cookie_value},
    crypto::{self, PasswordService},
    iso, now,
    rate_limit::AuthRateLimiter,
    repository::AuthRepository,
};
use crate::{
    config::{AuthMode, ServerConfig},
    database::Database,
};
use anyhow::Result;
use chrono::Duration;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, broadcast};

#[derive(Clone)]
pub enum Revocation {
    Session(Option<String>),
    Owner(String),
}

#[derive(Debug)]
pub struct ConflictingSessionCookies;
impl std::fmt::Display for ConflictingSessionCookies {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Conflicting Cantrip sessions were found. They were cleared; sign in again.")
    }
}
impl std::error::Error for ConflictingSessionCookies {}

#[derive(Clone)]
pub struct Principal {
    pub user: Option<UserSummary>,
    pub session_id: Option<String>,
}
impl Principal {
    pub fn authenticated(&self) -> bool {
        self.user.is_some()
    }
}

pub struct ResolvedSession {
    pub session: ActiveSession,
    pub csrf_token: String,
}
impl ResolvedSession {
    pub fn state(&self) -> SessionState {
        SessionState {
            current_user: Some(self.session.user.clone()),
            csrf_token: Some(self.csrf_token.clone()),
            expires_at: Some(iso(self.session.expires_at)),
        }
    }
}

pub struct AuthService {
    pub config: Arc<ServerConfig>,
    pub repository: AuthRepository,
    pub passwords: PasswordService,
    pub cookies: CookiePolicy,
    pub local_user: Option<UserSummary>,
    pub server_id: String,
    pub normalized_admin: Option<String>,
    pub registration: Mutex<()>,
    pub revocations: broadcast::Sender<Revocation>,
    pub workers: Arc<crate::workers::service::WorkerService>,
    rate_limit: Mutex<AuthRateLimiter>,
}

impl AuthService {
    pub async fn initialize(
        database: Arc<Database>,
        config: Arc<ServerConfig>,
    ) -> Result<Arc<Self>> {
        let repository = AuthRepository::new(database);
        // The existing connector always provisions the retained local identity,
        // including on an account server; only its principal is mode-dependent.
        let local = repository.local_user().await?;
        let passwords = PasswordService::default();
        repository
            .configured_administrator(&config, &passwords)
            .await?;
        let server_id = repository.server_id().await?;
        let local_user = if config.auth_mode == AuthMode::Accounts {
            None
        } else {
            repository.settings(&local.id).await?;
            Some(local)
        };
        let normalized_admin = config
            .admin_email
            .as_ref()
            .map(|e| crypto::normalize_email(e));
        let cookies = CookiePolicy::new(&config)?;
        let rate_limit = Mutex::new(AuthRateLimiter::new(config.auth_rate_limit as usize));
        let workers =
            crate::workers::service::WorkerService::new(repository.database.clone(), &config);
        Ok(Arc::new(Self {
            config,
            repository,
            passwords,
            cookies,
            local_user,
            server_id,
            normalized_admin,
            rate_limit,
            workers,
            registration: Mutex::new(()),
            revocations: broadcast::channel(256).0,
        }))
    }

    pub async fn resolve(&self, cookie: Option<&str>) -> Result<Option<ResolvedSession>> {
        let mut selected = HashMap::new();
        for name in [Some(self.cookies.name), self.cookies.partitioned_name]
            .into_iter()
            .flatten()
        {
            let Some(token) = cookie_value(cookie, name)
                .filter(|s| !s.is_empty() && crate::text::length(s) <= 512)
            else {
                continue;
            };
            if let Some(session) = self
                .repository
                .active_session(&crypto::hash_secret(&token))
                .await?
            {
                selected.insert(session.id.clone(), (session, token));
            }
        }
        if selected.len() > 1 {
            return Err(ConflictingSessionCookies.into());
        }
        let Some((mut session, token)) = selected.into_values().next() else {
            return Ok(None);
        };
        let csrf_token = crypto::csrf_token(&token);
        let hash = crypto::hash_secret(&csrf_token);
        if session.csrf_token_hash != hash {
            self.repository.rotate_csrf(&session.id, &hash).await?;
            session.csrf_token_hash = hash;
        }
        Ok(Some(ResolvedSession {
            session,
            csrf_token,
        }))
    }

    pub async fn principal(&self, cookie: Option<&str>) -> Result<Principal> {
        if self.config.auth_mode == AuthMode::None {
            return Ok(Principal {
                user: self.local_user.clone(),
                session_id: None,
            });
        }
        Ok(match self.resolve(cookie).await? {
            Some(resolved) => Principal {
                user: Some(resolved.session.user),
                session_id: Some(resolved.session.id),
            },
            None => Principal {
                user: None,
                session_id: None,
            },
        })
    }

    pub async fn create_session(
        &self,
        user: UserSummary,
        method: &str,
    ) -> Result<(Value, Vec<String>)> {
        let secret = crypto::session_secret()?;
        let expires = now() + Duration::seconds(self.cookies.ttl_seconds as i64);
        self.repository
            .create_session(&user.id, method, &secret, expires)
            .await?;
        Ok((
            json!({"currentUser":user,"csrfToken":secret.csrf_token,"expiresAt":iso(expires)}),
            self.cookies
                .headers(&secret.token, self.cookies.ttl_seconds),
        ))
    }
    pub async fn limited(&self, scope: &str, ip: &str, identity: &str) -> Option<u64> {
        self.rate_limit.lock().await.consume(
            &format!("{scope}:{ip}:{identity}"),
            now().timestamp_millis(),
        )
    }
    pub async fn revoke(&self, id: &str, owner: bool, reason: &str) -> Result<usize> {
        let count = self.repository.revoke(id, owner, reason).await?;
        let _ = self.revocations.send(if owner {
            Revocation::Owner(id.into())
        } else {
            Revocation::Session(Some(id.into()))
        });
        Ok(count)
    }
}
