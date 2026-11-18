//! Existing account-backed ChatGPT discovery over the owned native runtime.
mod auth;
mod quota;

use crate::{
    codex::{
        managed::{Launch, Profile, Runtime, Worker},
        private_inference::{Context, Hooks},
    },
    encryption::Service,
    http::checked,
    protected_secrets::open_runtime_provider,
    provider_access::{Access, Account, Lease, RequestError},
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, coercion, value::json};
pub use quota::snapshot as quota_snapshot;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);

pub const COMMAND: &str = "model.chatgpt.catalog";

const PROVIDER_CONFIG: &[&str] = &[
    "web_search=\"disabled\"",
    "features.fast_mode=false",
    "agents.enabled=true",
    "features.multi_agent=false",
    "features.multi_agent_v2.enabled=true",
    "features.multi_agent_v2.tool_namespace=\"cantrip_agents\"",
    "model_provider=\"openai\"",
];

#[derive(Clone)]
pub struct Catalog {
    codex: Worker,
    access: Access,
    encryption: Arc<Service>,
    data: PathBuf,
    skill_root: Option<PathBuf>,
    codex_version: Value,
}

impl Catalog {
    pub fn new(
        codex: Worker,
        access: Access,
        encryption: Arc<Service>,
        data: PathBuf,
        skill_root: Option<PathBuf>,
        codex_version: Value,
    ) -> Self {
        Self {
            codex,
            access,
            encryption,
            data,
            skill_root,
            codex_version,
        }
    }

    pub fn execute(&self, command: Value) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let provider = open_runtime_provider(&this.encryption, &command["provider"])?;
            let account = Account {
                provider: field(&provider, "id")?,
                id: field(&provider, "accountId")?,
            };
            let home = field(&provider, "credentialHomeKey")?;
            let id = JsString::new(
                "catalog:"
                    .encode_utf16()
                    .chain(home.units().iter().copied())
                    .collect(),
            );
            let mut profile = Profile::new(id, account_home(&this.data, &home));
            profile.account_scope = Some((account.provider.clone(), account.id.clone()));
            profile.provider_arguments = PROVIDER_CONFIG
                .iter()
                .map(|value| (*value).into())
                .collect();
            profile.extra_skill_roots.extend(this.skill_root);
            if let Some(secret) = provider["apiKey"].as_js_string() {
                profile.diagnostic_policy.secrets.push(secret.clone());
            }
            let runtime = this
                .codex
                .launch(Launch {
                    profile,
                    private_inference: Hooks {
                        overlay: Arc::new(|_| Context::default()),
                        provider: Arc::new(move || Some(provider.clone())),
                        before_inference: None,
                    },
                    on_revoked: None,
                    prepare_home: None,
                    external_auth: Some(Arc::new(auth::Auth::new(account, this.access))),
                    observe: Arc::new(|_| Ok(())),
                })
                .await?;
            inventory(&runtime, &this.codex_version).await
        })
    }
}

pub fn account_home(data: &Path, key: &JsString) -> PathBuf {
    let hash = Sha256::digest(key.lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    data.join("codex-accounts").join(hash)
}

pub fn global_skill_root(cwd: &Path, environment: &cantrip_config::Environment) -> Option<PathBuf> {
    let configured = environment
        .iter()
        .find(|(key, _)| {
            if cfg!(windows) {
                key.eq_ignore_ascii_case("CODEX_HOME")
            } else {
                key.as_str() == "CODEX_HOME"
            }
        })
        .map(|(_, value)| cantrip_wire::text::trim(value))
        .filter(|home| !home.is_empty());
    configured
        .map(|home| cantrip_config::resolve(cwd, Path::new(home)))
        .or_else(|| std::env::home_dir().map(|home| home.join(".codex")))
        .map(|home| home.join("skills"))
}

pub async fn inventory(runtime: &Runtime, codex_version: &Value) -> Result<Value> {
    let mut models = Vec::new();
    let mut cursors = HashSet::new();
    let mut cursor = Value::Null;
    loop {
        let page = call(
            runtime,
            "model/list",
            Some(json!({"cursor":cursor,"includeHidden":true,"limit":100})),
        )
        .await?;
        if page["data"].as_array().is_none() {
            bail!("Codex model/list returned an invalid model page.");
        }
        let page_models = cantrip_protocol::parse_property(
            "chatGptModelInventorySchema",
            "models",
            &page["data"],
        )
        .map_err(cantrip_protocol::response::response_error)?;
        models.extend_from_slice(page_models.as_array().unwrap());
        cursor = page["nextCursor"].clone();
        if coercion::truthy(Some(&cursor)) && !cursors.insert(cursor.stringify()) {
            bail!("Codex model/list repeated a pagination cursor.");
        }
        if models.len() >= 1000 || !coercion::truthy(Some(&cursor)) {
            break;
        }
    }

    let quota = match quota_read(runtime).await {
        Ok(value) if !value.is_null() => quota_snapshot(
            &value,
            &crate::version::value()["version"],
            codex_version,
            &uuid::Uuid::new_v4().to_string(),
            &quota::now(),
        )
        .unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let weekly = quota["windows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["isWeeklyProjection"] == true))
        .map_or(
            Value::Null,
            |row| json!({"resetsAt":row["resetsAt"],"usedPercent":row["usedPercent"]}),
        );
    checked(
        "chatGptModelInventorySchema",
        &json!({"models":models, "observedAt":quota::now(), "weeklyUsage":weekly, "quotaSnapshot":quota}),
    )
}

async fn quota_read(runtime: &Runtime) -> Result<Value> {
    let first = call(runtime, "account/rateLimits/read", None).await;
    if !first.as_ref().is_err_and(auth::expired) {
        return first;
    }
    runtime.reauthenticate_external().await?;
    call(runtime, "account/rateLimits/read", None)
        .await
        .map_err(|error| {
            if auth::expired(&error) {
                auth::reauth_required()
            } else {
                error
            }
        })
}

async fn call(runtime: &Runtime, method: &str, params: Option<Value>) -> Result<Value> {
    Ok(runtime
        .request(method.into(), params, Some(RPC_TIMEOUT), None)
        .await?
        .unwrap_or(Value::Null))
}

fn field(provider: &Value, key: &str) -> Result<JsString> {
    provider[key]
        .as_js_string()
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| anyhow!("Worker command does not contain a ChatGPT {key}."))
}
