//! Worker policy ported from config.ts. Caller supplies host inputs explicitly;
//! no server configuration or database bootstrap is imported.
use crate::{
    credentials,
    installation::{self, Installation},
};
use anyhow::{Result, bail};
use cantrip_config::{Environment, resolve};
use cantrip_wire::{JsString, text::trim};
use std::path::{Path, PathBuf};

pub struct Config {
    pub codex_installation: Installation,
    pub data_directory: PathBuf,
    pub name: String,
    pub server_url: String,
    pub enrollment_code: Option<String>,
    pub replacement: Option<Replacement>,
    pub token: String,
    pub token_source: &'static str,
    pub worker_id: JsString,
}

pub struct Replacement {
    pub worker_id: String,
    pub credential: String,
}

pub struct Host<'a> {
    pub cwd: &'a Path,
    pub worker_root: &'a Path,
    pub platform: &'a str,
    pub architecture: &'a str,
    pub hostname: &'a str,
}

fn nonempty(environment: &Environment, name: &str) -> Option<String> {
    environment
        .get(name)
        .map(|v| trim(v))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

pub fn data_directory(environment: &Environment, cwd: &Path) -> PathBuf {
    resolve(
        cwd,
        Path::new(
            environment
                .get("CANTRIP_WORKER_DATA_DIR")
                .map(String::as_str)
                .unwrap_or("../.cantrip/dev/worker"),
        ),
    )
}

pub fn read(environment: &Environment, host: &Host<'_>) -> Result<Config> {
    let codex_installation = installation::discover(
        host.worker_root,
        host.platform,
        host.architecture,
        environment.get("CANTRIP_CODEX_BIN").map(String::as_str),
    );
    let raw = environment
        .get("CANTRIP_SERVER_URL")
        .map(String::as_str)
        .unwrap_or("http://127.0.0.1:4310");
    let server_url = raw.strip_suffix('/').unwrap_or(raw).to_owned();
    let parsed = url::Url::parse(&server_url).map_err(|_| anyhow::anyhow!("Invalid URL"))?;
    if !["http", "https"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some_and(|v| !v.is_empty())
        || parsed.path() != "/"
        || parsed.query().is_some_and(|v| !v.is_empty())
        || parsed.fragment().is_some_and(|v| !v.is_empty())
    {
        bail!("CANTRIP_SERVER_URL must be an HTTP(S) origin without a path or credentials.");
    }
    let data_directory = data_directory(environment, host.cwd);
    let enrollment_code = nonempty(environment, "CANTRIP_WORKER_ENROLLMENT_CODE");
    let replaces_id = nonempty(environment, "CANTRIP_WORKER_REPLACES_ID");
    let replaces_credential = nonempty(environment, "CANTRIP_WORKER_REPLACES_CREDENTIAL");
    if replaces_id.is_some() != replaces_credential.is_some() {
        bail!(
            "CANTRIP_WORKER_REPLACES_ID and CANTRIP_WORKER_REPLACES_CREDENTIAL must be configured together."
        );
    }
    if (replaces_id.is_some() || replaces_credential.is_some()) && enrollment_code.is_none() {
        bail!("Worker replacement requires an enrollment code.");
    }
    if replaces_credential
        .as_deref()
        .is_some_and(|v| !credentials::valid_token(v, "ctwk_", 43))
    {
        bail!("CANTRIP_WORKER_REPLACES_CREDENTIAL is malformed.");
    }
    let environment_credential = nonempty(environment, "CANTRIP_WORKER_CREDENTIAL");
    let legacy_token = nonempty(environment, "CANTRIP_WORKER_TOKEN");
    let development = environment
        .get("CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP")
        .is_some_and(|v| v == "true");
    if [&enrollment_code, &environment_credential, &legacy_token]
        .iter()
        .filter(|v| v.is_some())
        .count()
        > 1
    {
        bail!(
            "Configure only one worker authentication method: enrollment code, worker credential, or development token."
        );
    }
    if enrollment_code
        .as_deref()
        .is_some_and(|v| !credentials::valid_token(v, "ctwl_", 32))
    {
        bail!("CANTRIP_WORKER_ENROLLMENT_CODE is malformed.");
    }
    if environment_credential
        .as_deref()
        .is_some_and(|v| !credentials::valid_token(v, "ctwk_", 43))
    {
        bail!("CANTRIP_WORKER_CREDENTIAL is malformed.");
    }
    let explicit_id = nonempty(environment, "CANTRIP_WORKER_ID");
    if environment_credential.is_some() && explicit_id.is_none() {
        bail!(
            "CANTRIP_WORKER_ID is required with CANTRIP_WORKER_CREDENTIAL because credentials are bound to an immutable worker identity."
        );
    }
    let loopback = parsed
        .host_str()
        .is_some_and(|v| ["127.0.0.1", "localhost", "::1", "[::1]"].contains(&v));
    if (legacy_token.is_some() || development) && (!development || !loopback) {
        bail!("The legacy worker token is restricted to explicit loopback development bootstrap.");
    }
    let stored = if environment_credential.is_some() || legacy_token.is_some() {
        None
    } else {
        credentials::load(&data_directory, &server_url)?
    };
    let pending = if stored.is_some() {
        None
    } else {
        enrollment_code
    };
    let token = environment_credential
        .clone()
        .or_else(|| legacy_token.clone())
        .or_else(|| stored.as_ref().map(|v| v.credential.clone()))
        .unwrap_or_else(|| {
            if development {
                "cantrip-local-development".into()
            } else {
                String::new()
            }
        });
    if token.is_empty() && pending.is_none() {
        bail!(
            "This worker is not enrolled. Set CANTRIP_WORKER_ENROLLMENT_CODE once, or configure CANTRIP_WORKER_CREDENTIAL with its bound CANTRIP_WORKER_ID."
        );
    }
    let worker_id = if let Some(id) = explicit_id {
        id.into()
    } else if let Some(stored) = stored {
        stored.worker_id
    } else if development {
        format!("local-{}", host.hostname).into()
    } else {
        credentials::identity(&data_directory)?
    };
    let token_source = if pending.is_some() {
        "enrollment"
    } else if environment_credential.is_some() {
        "environment"
    } else if legacy_token.is_some() || development {
        "development"
    } else {
        "persisted"
    };
    Ok(Config {
        codex_installation,
        data_directory,
        enrollment_code: pending,
        name: environment
            .get("CANTRIP_WORKER_NAME")
            .cloned()
            .unwrap_or_else(|| "Local Worker".into()),
        replacement: replaces_id
            .zip(replaces_credential)
            .map(|(worker_id, credential)| Replacement {
                worker_id,
                credential,
            }),
        server_url,
        token,
        token_source,
        worker_id,
    })
}
