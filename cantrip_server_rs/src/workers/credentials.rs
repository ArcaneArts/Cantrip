use super::{
    DEFAULT_CREDENTIAL_SCOPES,
    repository::{ActiveCredential, WorkerRepository},
};
use crate::{
    auth::{LOCAL_USER_ID, crypto},
    config::{AuthMode, BootstrapMode, DeploymentMode, ServerConfig},
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use uuid::Uuid;

pub struct WorkerAuthentication {
    pub credential: ActiveCredential,
    pub development: bool,
}
pub struct GeneratedCredential {
    pub credential: String,
    pub hash: String,
    pub id: String,
}

pub fn development_allowed(config: &ServerConfig) -> bool {
    config.deployment_mode == DeploymentMode::Local
        && config.auth_mode == AuthMode::None
        && ["127.0.0.1", "localhost", "::1"].contains(&config.host.as_str())
        && matches!(
            config.bootstrap_mode,
            BootstrapMode::PnpmDev | BootstrapMode::Tauri
        )
}
pub async fn authenticate(
    repository: &WorkerRepository,
    config: &ServerConfig,
    authorization: Option<&str>,
    worker: &str,
    scope: &str,
) -> Result<Option<WorkerAuthentication>> {
    let Some(secret) = authorization
        .and_then(|header| header.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty() && crate::text::length(s) <= 512)
    else {
        return Ok(None);
    };
    if development_allowed(config) && crypto::safe_secret_match(secret, &config.worker_token) {
        return Ok(Some(WorkerAuthentication {
            development: true,
            credential: ActiveCredential {
                id: "development-bootstrap".into(),
                owner_id: LOCAL_USER_ID.into(),
                worker_id: worker.into(),
                scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
            },
        }));
    }
    if worker.is_empty() {
        return Ok(None);
    }
    Ok(repository
        .authenticate(&crypto::hash_secret(secret), worker, scope)
        .await?
        .map(|credential| WorkerAuthentication {
            credential,
            development: false,
        }))
}
fn random<const N: usize>() -> Result<String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).context("Generate worker credential")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
pub fn enrollment_code() -> Result<(String, String)> {
    let code = format!("ctwl_{}", random::<24>()?);
    let hash = crypto::hash_secret(&code);
    Ok((code, hash))
}
pub fn credential() -> Result<GeneratedCredential> {
    let credential = format!("ctwk_{}", random::<32>()?);
    let hash = crypto::hash_secret(&credential);
    Ok(GeneratedCredential {
        credential,
        hash,
        id: Uuid::new_v4().to_string(),
    })
}
