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
    pub live: Arc<crate::live::LiveService>,
    pub usage: Arc<crate::usage::service::UsageService>,
    pub provider_accounts: Arc<crate::settings::account_service::AccountService>,
    pub provider_catalogs: Arc<crate::settings::catalog_runtime::CatalogRuntime>,
    pub mutation_audits: Arc<super::audit::AuditService>,
    pub project_replicas: Arc<crate::projects::replicas::service::ReplicaService>,
    pub github_conversion: Arc<crate::projects::github_conversion::service::ConversionService>,
    pub workspace_discovery: Arc<crate::projects::workspace_discovery::service::DiscoveryService>,
    pub folder_setup: Arc<crate::projects::folders::service::FolderService>,
    pub scratch_roots: Arc<crate::chats::roots::service::Service>,
    pub worker_maintenance: Arc<crate::workers::maintenance::Service>,
    pub worker_links: Arc<crate::worker_links::service::Service>,
    pub direct_attachments: Arc<crate::direct_attachments::Coordinator>,
    pub tunnel_leases: Arc<crate::tunnels::sweep::LeaseSweeper>,
    pub tunnel_runtime: Arc<crate::tunnels::runtime::Runtime>,
    pub project_shares: Arc<crate::project_shares::Service>,
    pub transport_metrics: Arc<crate::operations::TransportMetrics>,
    pub model_routing: Arc<crate::chats::routing::ModelRouting>,
    pub worktree_observations: Arc<crate::projects::observations::Service>,
    pub project_operations: Arc<crate::projects::coordinator::Coordinator>,
    pub worktrees: Arc<crate::projects::worktrees::Service>,
    pub run_configuration_observations: Arc<crate::run_configurations::observations::Service>,
    pub managed_console: Arc<crate::chats::managed_console::ManagedConsole>,
    pub logical_completion_delivery:
        Arc<crate::native_commands::runtime::logical_delivery::LogicalDelivery>,
    pub history_publication_delivery: Arc<crate::native_history::delivery::PublicationDelivery>,
    rate_limit: Mutex<AuthRateLimiter>,
}

impl AuthService {
    pub async fn initialize(
        database: Arc<Database>,
        config: Arc<ServerConfig>,
    ) -> Result<Arc<Self>> {
        let repository = AuthRepository::new(database.clone());
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
        let surfaces = crate::remote_surfaces::Repository::new(database.clone());
        if let Some(local) = local_user.as_ref() {
            surfaces.ensure_browsers(&local.id).await?;
        }
        // This native runtime currently has one local coordinator. Shared
        // coordination must use its observed instance count before recovery.
        surfaces.reset_transient().await?;
        crate::tunnels::Repository::new(database.clone())
            .reset_transient()
            .await?;
        let normalized_admin = config
            .admin_email
            .as_ref()
            .map(|e| crypto::normalize_email(e));
        let cookies = CookiePolicy::new(&config)?;
        let rate_limit = Mutex::new(AuthRateLimiter::new(config.auth_rate_limit as usize));
        let usage = crate::usage::service::UsageService::new(database.clone(), &config)?;
        let recorder = Arc::downgrade(&usage);
        let workers = crate::workers::service::WorkerService::with_usage(
            repository.database.clone(),
            &config,
            Some(Arc::new(move |owner, ingress, bytes, notify| {
                if let Some(usage) = recorder.upgrade() {
                    usage.record(owner, "worker-control-websocket", ingress, bytes, 1, notify);
                }
            })),
        );
        let recorder = Arc::downgrade(&usage);
        let live = crate::live::LiveService::with_usage(
            database,
            &config,
            Some(Arc::new(move |owner, ingress, bytes, notify| {
                if let Some(usage) = recorder.upgrade() {
                    usage.record(owner, "client-live-websocket", ingress, bytes, 1, notify);
                }
            })),
        )?;
        let publisher = Arc::downgrade(&live);
        usage.invalidations.on_publish(Arc::new(move |owner| {
            if let Some(live) = publisher.upgrade() {
                live.invalidate_resource(owner, "account-resource-usage");
            }
        }));
        let publisher = Arc::downgrade(&live);
        workers.on_invalidation(Arc::new(move |event| {
            if let Some(live) = publisher.upgrade() {
                live.invalidate(&event.owner, event.resource, &event.entity);
            }
        }));
        let provider_catalogs = crate::settings::catalog_runtime::CatalogRuntime::new(
            crate::settings::repository::SettingsRepository::new(repository.database.clone()),
            workers.commands.clone(),
        )?;
        let provider_accounts = crate::settings::account_service::AccountService::new(
            crate::settings::repository::SettingsRepository::new(repository.database.clone()),
            workers.commands.clone(),
            live.clone(),
            provider_catalogs.clone(),
            workers.bridge.clone(),
        );
        let mutation_audits = super::audit::AuditService::new(repository.clone());
        let folder_setup = crate::projects::folders::service::FolderService::new(
            repository.database.clone(),
            workers.commands.clone(),
            workers.bridge.clone(),
            live.clone(),
        );
        folder_setup.start().await?;
        let worker_maintenance = crate::workers::maintenance::Service::new(
            repository.database.clone(),
            workers.bridge.clone(),
            workers.commands.clone(),
            live.clone(),
            server_id.clone(),
        );
        let worker_links = crate::worker_links::service::Service::new(
            server_id.clone(),
            &config,
            &workers,
            &usage,
        );
        let tunnel_repository = crate::tunnels::Repository::new(repository.database.clone());
        let tunnel_live = live.clone();
        let tunnel_observer: crate::direct_attachments::Observer = Arc::new(move |kind, event| {
            let repository = tunnel_repository.clone();
            let live = tunnel_live.clone();
            Box::pin(async move {
                let owner = event["ownerId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Direct tunnel owner"))?;
                let attachment = event["attachmentId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Direct tunnel attachment"))?;
                let capability = event["capabilityId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Direct tunnel capability"))?;
                let expires = event["leaseExpiresAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|v| v.with_timezone(&chrono::Utc));
                let changed = if kind == "renewed" {
                    repository
                        .renew_direct(owner, attachment, capability, expires)
                        .await?
                } else {
                    repository
                        .finalize_direct(owner, attachment, capability, expires)
                        .await?
                };
                if let Some(changed) = changed {
                    crate::tunnels::publish(&live, &changed);
                }
                Ok(())
            })
        });
        let direct_attachments = crate::direct_attachments::Coordinator::native(
            workers.commands.clone(),
            workers.bridge.clone(),
            crate::direct_attachments::Options {
                observer: Some(tunnel_observer),
                ..Default::default()
            },
        );
        let model_routing = crate::chats::routing::ModelRouting::new(
            repository.database.clone(),
            provider_catalogs.clone(),
            workers.bridge.clone(),
        );
        let publisher = Arc::downgrade(&live);
        let worktree_observations = crate::projects::observations::Service::new(
            repository.database.clone(),
            workers.bridge.clone(),
            workers.commands.clone(),
            &live,
        );
        let project_replicas = crate::projects::replicas::service::ReplicaService::new(
            repository.database.clone(),
            workers.commands.clone(),
            workers.bridge.clone(),
            live.clone(),
            worktree_observations.clone(),
        );
        project_replicas.start().await?;
        let github_conversion = crate::projects::github_conversion::service::ConversionService::new(
            repository.database.clone(),
            workers.commands.clone(),
            workers.bridge.clone(),
            live.clone(),
            worktree_observations.clone(),
        );
        github_conversion.start().await?;
        let workspace_discovery =
            crate::projects::workspace_discovery::service::DiscoveryService::new(
                repository.database.clone(),
                workers.commands.clone(),
                workers.bridge.clone(),
                live.clone(),
            );
        workspace_discovery.start().await?;
        let scratch_roots = crate::chats::roots::service::Service::new(
            repository.database.clone(),
            workers.clone(),
            live.clone(),
        );
        scratch_roots.start(true).await?;
        let observations = worktree_observations.clone();
        let project_operations =
            crate::projects::coordinator::Coordinator::new(Arc::new(move |owner, project| {
                if let Some(live) = publisher.upgrade() {
                    crate::projects::repository_operation::publish(
                        &live, owner, project, "worktree",
                    );
                }
                observations.schedule_project(owner.to_owned(), project.to_owned());
            }));
        let worktrees = crate::projects::worktrees::Service::new(
            repository.database.clone(),
            workers.bridge.clone(),
            workers.commands.clone(),
            project_operations.clone(),
        );
        let run_configuration_observations = crate::run_configurations::observations::Service::new(
            repository.database.clone(),
            workers.bridge.clone(),
            workers.commands.clone(),
            &live,
            worker_maintenance.clone(),
        );
        let managed_console = crate::chats::managed_console::ManagedConsole::new(
            repository.database.clone(),
            model_routing.clone(),
            workers.commands.clone(),
        );
        let logical_completion_delivery =
            crate::native_commands::runtime::logical_delivery::LogicalDelivery::new(
                repository.database.clone(),
                workers.commands.clone(),
            );
        let history_publication_delivery =
            crate::native_history::delivery::PublicationDelivery::new(
                repository.database.clone(),
                live.hub.clone(),
            );
        let quotas = workers.relay_quotas.clone();
        let broker = crate::tunnels::broker::Broker::new(crate::tunnels::broker::Options {
            consume: Arc::new(move |owner, worker, bytes| {
                quotas.consume_relay_at(
                    owner.as_str().expect("Tunnel owner"),
                    worker.as_str().expect("Tunnel worker"),
                    bytes as u64,
                    crate::auth::now().timestamp_millis(),
                )
            }),
            ..Default::default()
        });
        let publisher = Arc::downgrade(&live);
        let recorder = Arc::downgrade(&usage);
        let tunnel_runtime = crate::tunnels::runtime::Runtime::new(
            crate::tunnels::Repository::new(repository.database.clone()),
            workers.bridge.clone(),
            broker,
            Arc::new(move |change| {
                if let Some(live) = publisher.upgrade() {
                    crate::tunnels::publish(&live, &change);
                }
            }),
            Some(Arc::new(move |owner, channel, ingress, bytes| {
                if let Some(usage) = recorder.upgrade() {
                    usage.record(owner, channel, ingress, bytes, 1, true);
                }
            })),
            Default::default(),
        )?;
        let tunnel_leases = crate::tunnels::sweep::LeaseSweeper::start(
            crate::tunnels::Repository::new(repository.database.clone()),
            live.clone(),
            tunnel_runtime.clone(),
        );
        let project_shares = crate::project_shares::Service::new(
            repository.database.clone(),
            workers.commands.clone(),
            workers.bridge.clone(),
            live.clone(),
            worker_links.clone(),
        );
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
            live,
            usage,
            provider_accounts,
            provider_catalogs,
            mutation_audits,
            folder_setup,
            project_replicas,
            github_conversion,
            workspace_discovery,
            scratch_roots,
            worker_maintenance,
            worker_links,
            direct_attachments,
            tunnel_leases,
            tunnel_runtime,
            project_shares,
            transport_metrics: Arc::new(Default::default()),
            model_routing,
            managed_console,
            logical_completion_delivery,
            history_publication_delivery,
            project_operations,
            worktrees,
            run_configuration_observations,
            worktree_observations,
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
    pub async fn revoke(self: &Arc<Self>, id: &str, owner: bool, reason: &str) -> Result<usize> {
        let (service, id, reason) = (self.clone(), id.to_owned(), reason.to_owned());
        self.worker_links
            .local
            .owned(async move {
                let count = service.repository.revoke(&id, owner, &reason).await?;
                service
                    .apply_revocation(if owner {
                        Revocation::Owner(id)
                    } else {
                        Revocation::Session(Some(id))
                    })
                    .await;
                Ok(count)
            })
            .await
    }
    pub async fn revoke_connections(self: &Arc<Self>, revocation: Revocation) -> Result<()> {
        let service = self.clone();
        self.worker_links
            .local
            .owned(async move {
                service.apply_revocation(revocation).await;
                Ok(())
            })
            .await
    }
    async fn apply_revocation(&self, revocation: Revocation) {
        // Complete local socket side effects before the logout/revoke response.
        // The broadcast remains available to other asynchronous consumers.
        self.live.revoke_live(&revocation);
        match &revocation {
            Revocation::Owner(owner) => {
                self.direct_attachments
                    .revoke_scope(crate::direct_attachments::Scope::Owner(
                        crate::wire::Value::String(owner.clone().into()),
                    ))
                    .await;
                self.worker_links.revoke_owner(owner).await;
            }
            Revocation::Session(Some(session)) => {
                self.direct_attachments
                    .revoke_scope(crate::direct_attachments::Scope::Session(
                        crate::wire::Value::String(session.clone().into()),
                    ))
                    .await;
                self.worker_links.revoke_account(session).await;
            }
            Revocation::Session(None) => {}
        }
        self.live.close_revoked_sockets(&revocation);
        let _ = self.revocations.send(revocation);
    }
}
