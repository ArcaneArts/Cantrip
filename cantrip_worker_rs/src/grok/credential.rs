use super::http::{Http, access_token, weekly_usage};
use crate::{
    provider_access::{json_body, jwt_claims},
    provider_credentials::{discard, read},
};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{JsString, Value, value::json};
use reqwest::StatusCode;
use std::{io::Write, path::Path, time::Duration};
use tokio::time::Instant;

const EARLY_REFRESH_MS: f64 = 5.0 * 60_000.0;
const CACHE: Duration = Duration::from_secs(30);
pub(super) const FILE: &str = "grok-auth.json";

#[derive(Default)]
pub(super) struct Credential {
    loaded: bool,
    value: Option<Value>,
    profile_at: Option<Instant>,
    quota: Option<(Instant, Value)>,
}

impl Credential {
    pub(super) async fn load(&mut self, home: &Path) -> Result<Option<Value>> {
        if self.loaded {
            return Ok(self.value.clone());
        }
        self.loaded = true;
        let stored = read(&home.join(FILE))
            .await
            .map_err(|_| anyhow!("Stored Grok credentials are invalid."))?;
        if stored.is_null() {
            return Ok(None);
        }
        if stored["version"] != json!(1)
            || !stored["accessToken"].is_string()
            || !stored["userId"].is_string()
        {
            bail!("Stored Grok credentials are invalid.");
        }
        self.value = Some(json!({
            "version":1,"accessToken":stored["accessToken"],"userId":stored["userId"],
            "email":stored["email"].as_js_string(),"planType":stored["planType"].as_js_string(),
            "expiresAt":stored["expiresAt"].as_f64(), "refreshToken":stored["refreshToken"].as_js_string()
        }));
        Ok(self.value.clone())
    }

    pub(super) async fn accept(&mut self, http: &Http, home: &Path, payload: &Value) -> Result<()> {
        let credential = from_tokens(payload, &Value::Null)?;
        self.save(home, credential.clone()).await?;
        self.quota = None;
        self.enrich(http, home, credential).await;
        Ok(())
    }

    async fn save(&mut self, home: &Path, credential: Value) -> Result<()> {
        let body = credential.stringify() + "\n";
        let directory = home.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<()> {
            cantrip_host::files::secure_directory(&directory)?;
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
            temporary.write_all(body.as_bytes())?;
            temporary.as_file().sync_all()?;
            temporary.persist(directory.join(FILE))?;
            #[cfg(unix)]
            std::fs::File::open(&directory)?.sync_all()?;
            Ok(())
        })
        .await?
        .map_err(|_| anyhow!("Could not save Grok account credentials."))?;
        self.loaded = true;
        self.value = Some(credential);
        Ok(())
    }

    pub(super) async fn status(
        &mut self,
        http: &Http,
        home: &Path,
        login_error: &mut Option<String>,
    ) -> (Option<Value>, Value) {
        let previous = match self.load(home).await {
            Ok(value) => value,
            Err(error) => {
                *login_error = Some(error.to_string());
                None
            }
        };
        let Some(previous) = previous else {
            return (None, Value::Null);
        };
        let credential = match self.valid(http, home, false).await {
            Ok(credential) if self.profile_at.is_none_or(|at| at.elapsed() >= CACHE) => {
                Some(self.enrich(http, home, credential).await)
            }
            Ok(credential) => Some(credential),
            Err(error) => {
                *login_error = Some(error.to_string());
                unexpired(&previous, 0.0).then_some(previous)
            }
        };
        let weekly = if credential.is_some() {
            self.quota(http, home).await
        } else {
            Value::Null
        };
        (credential, weekly)
    }

    async fn enrich(&mut self, http: &Http, home: &Path, credential: Value) -> Value {
        self.profile_at = Some(Instant::now());
        let response = async {
            let response = http
                .subscription("user?include=subscription", &credential)
                .await?;
            if !response.status().is_success() {
                bail!("Grok profile request failed.");
            }
            json_body(response).await
        }
        .await;
        let Ok(profile) = response else {
            return credential;
        };
        let mut enriched = credential.clone();
        for (target, aliases) in [
            ("userId", &["userId", "user_id"][..]),
            ("email", &["email"][..]),
            ("planType", &["subscriptionTier", "subscription_tier"][..]),
        ] {
            if let Some(value) = aliases
                .iter()
                .filter_map(|key| profile[*key].as_js_string())
                .map(JsString::trim)
                .find(|text| !text.is_empty())
            {
                enriched[target] = json!(value);
            }
        }
        if enriched != credential && self.save(home, enriched.clone()).await.is_err() {
            return credential;
        }
        enriched
    }

    pub(super) async fn quota(&mut self, http: &Http, home: &Path) -> Value {
        if let Some((at, cached)) = &self.quota
            && at.elapsed() < CACHE
        {
            return cached.clone();
        }
        let result = async {
            let response = self.request(http, home, "billing?format=credits").await?;
            if !response.status().is_success() {
                bail!("Grok usage discovery failed.");
            }
            let usage = weekly_usage(&json_body(response).await?);
            if usage["resetsAt"].as_i64().is_some_and(|resets| resets < 0) {
                bail!("Grok usage discovery returned an invalid reset timestamp.");
            }
            Ok::<_, anyhow::Error>(usage)
        }
        .await;
        match result {
            Ok(value) => {
                self.quota = Some((Instant::now(), value.clone()));
                value
            }
            Err(_) => self
                .quota
                .as_ref()
                .map_or(Value::Null, |(_, saved)| saved.clone()),
        }
    }

    pub(super) async fn request(
        &mut self,
        http: &Http,
        home: &Path,
        resource: &str,
    ) -> Result<reqwest::Response> {
        let credential = self.valid(http, home, false).await?;
        let response = http.subscription(resource, &credential).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let renewed = self.valid(http, home, true).await?;
            return http.subscription(resource, &renewed).await;
        }
        Ok(response)
    }

    async fn valid(&mut self, http: &Http, home: &Path, force: bool) -> Result<Value> {
        let credential = self
            .load(home)
            .await?
            .ok_or_else(|| anyhow!("Grok account is not signed in."))?;
        if !force && unexpired(&credential, EARLY_REFRESH_MS) {
            return Ok(credential);
        }
        let token = credential["refreshToken"]
            .as_str()
            .filter(|token| !token.is_empty());
        let Some(token) = token else {
            if !force && unexpired(&credential, 0.0) {
                return Ok(credential);
            }
            bail!("Grok credentials cannot be refreshed. Sign in again.");
        };
        let result = self.refresh(http, home, token, &credential).await;
        if result.is_err()
            && !force
            && credential["expiresAt"].is_number()
            && unexpired(&credential, 0.0)
        {
            return Ok(credential);
        }
        result
    }

    async fn refresh(
        &mut self,
        http: &Http,
        home: &Path,
        token: &str,
        credential: &Value,
    ) -> Result<Value> {
        let (status, payload) = http.refresh(token).await?;
        if !status.is_success() || access_token(&payload).is_none() {
            if matches!(
                payload["error"].as_str(),
                Some("invalid_grant" | "invalid_token")
            ) {
                self.value = None;
                let _ = discard(&home.join(FILE)).await;
                bail!("Grok credentials cannot be refreshed. Sign in again.");
            }
            bail!("Grok token refresh failed.");
        }
        let refreshed = from_tokens(&payload, credential)?;
        self.save(home, refreshed.clone()).await?;
        Ok(refreshed)
    }
}

fn unexpired(value: &Value, buffer: f64) -> bool {
    value["expiresAt"]
        .as_f64()
        .is_none_or(|expires| expires > now() + buffer)
}

fn now() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

fn from_tokens(tokens: &Value, previous: &Value) -> Result<Value> {
    let access =
        access_token(tokens).ok_or_else(|| anyhow!("Grok returned an invalid access token."))?;
    let claims = jwt_claims(tokens["id_token"].as_js_string());
    let expires = tokens["expires_in"]
        .as_f64()
        .map(|seconds| now() + seconds * 1000.0)
        .or_else(|| previous["expiresAt"].as_f64());
    Ok(json!({
        "version":1,"accessToken":access,
        "refreshToken":tokens["refresh_token"].as_js_string().or_else(|| previous["refreshToken"].as_js_string()),
        "expiresAt":expires,
        "userId":claims["sub"].as_js_string().or_else(|| previous["userId"].as_js_string()).cloned().unwrap_or_else(|| "".into()),
        "email":claims["email"].as_js_string().or_else(|| previous["email"].as_js_string()),
        "planType":previous["planType"]
    }))
}
