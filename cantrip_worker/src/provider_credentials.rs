//! Worker-owned credential migration and local account retirement.
use crate::{
    codex::{account_auth, catalog::account_home, discovery, managed::Worker},
    encryption::Service,
    http::checked,
    protected_secrets::{protect_provider_credential, provider_subject_blind_index},
    provider_access::{Access, Account, jwt_claims},
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{fs, io::AsyncReadExt};

const CAPTURE: &str = "provider.auth.legacy.capture";
const PURGE: &str = "provider.auth.legacy.purge";
const CLEAR: &str = "provider.auth.account.clear";
const MAX_BYTES: u64 = 4 * 1024 * 1024;

pub fn supports(command: &str) -> bool {
    matches!(command, CAPTURE | PURGE | CLEAR)
}

#[derive(Clone)]
pub struct Commands {
    codex: Worker,
    account_auth: account_auth::Commands,
    grok_auth: crate::grok::Commands,
    access: Access,
    encryption: Arc<Service>,
    data: PathBuf,
    chatgpt_portable: bool,
}

impl Commands {
    pub fn new(
        codex: Worker,
        account_auth: account_auth::Commands,
        grok_auth: crate::grok::Commands,
        access: Access,
        encryption: Arc<Service>,
        data: PathBuf,
        compatibility: &Value,
    ) -> Self {
        Self {
            codex,
            account_auth,
            grok_auth,
            access,
            encryption,
            data,
            chatgpt_portable: compatibility["version"]["semantic"]
                .as_js_string()
                .is_some_and(discovery::tested)
                && compatibility["initialize"]["experimentalApi"] == true
                && discovery::methods_available(compatibility, &[json!("account/login/start")]),
        }
    }

    pub fn execute(&self, command: Value) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let name = command["type"].as_str().unwrap_or_default();
            let identity = |field: &str| {
                command[field]
                    .as_js_string()
                    .cloned()
                    .ok_or_else(|| anyhow!("Provider credential command is missing {field}."))
            };
            let account = Account {
                provider: identity("providerId")?,
                id: identity("providerAccountId")?,
            };
            let kind = match command["providerKind"].as_str() {
                Some("chatgpt") => Kind::ChatGpt,
                Some("grok") => Kind::Grok,
                _ => bail!("Unsupported legacy provider credential kind."),
            };
            let home = account_home(&this.data, &identity("credentialHomeKey")?);
            let file = home.join(kind.filename());
            if name == CAPTURE {
                let result = match capture(&file, kind).await {
                    Captured::Missing => json!({"status":"missing"}),
                    Captured::Malformed => json!({"status":"malformed"}),
                    Captured::Available(credential) => {
                        let mut result = protect_provider_credential(
                            &this.encryption,
                            &json!(account.id),
                            &credential,
                        )?;
                        result["status"] = json!("available");
                        result["portableAuth"] = json!(kind == Kind::Grok || this.chatgpt_portable);
                        result
                    }
                };
                return checked("providerLegacyCredentialCaptureResultSchema", &result);
            }
            let scope = (account.provider.clone(), account.id.clone());
            let clear = match name {
                CLEAR => true,
                PURGE => false,
                _ => bail!("Unsupported provider credential command."),
            };
            this.codex
                .with_retired_account(home.clone(), scope, move |retired| {
                    Box::pin(async move {
                        let pause = this.access.pause(account);
                        let (retired, ()) = tokio::join!(retired, pause.drain());
                        retired?;
                        match kind {
                            Kind::ChatGpt => this.account_auth.retire(&home, clear).await?,
                            Kind::Grok => this.grok_auth.retire(&home, clear).await?,
                        }
                        if clear {
                            discard(&file).await?;
                            return Ok(json!({"accepted":true}));
                        }
                        let expected = &command["expectedSubjectBlindIndex"];
                        let purged =
                            if let Captured::Available(credential) = capture(&file, kind).await {
                                let blind =
                                    provider_subject_blind_index(&this.encryption, &credential)?;
                                if *expected != blind.as_str() {
                                    bail!("Worker provider identity changed before purge.");
                                }
                                discard(&file).await?;
                                true
                            } else {
                                false
                            };
                        checked(
                            "providerLegacyCredentialPurgeResultSchema",
                            &json!({
                                "purged":purged,
                                "serverCredentialRevision":command["serverCredentialRevision"],
                                "subjectBlindIndex":expected
                            }),
                        )
                    })
                })
                .await
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    ChatGpt,
    Grok,
}

impl Kind {
    fn filename(self) -> &'static str {
        match self {
            Self::ChatGpt => "auth.json",
            Self::Grok => "grok-auth.json",
        }
    }
}

enum Captured {
    Missing,
    Malformed,
    Available(Value),
}

async fn capture(file: &Path, kind: Kind) -> Captured {
    let value = match read(file).await {
        Ok(value) if value.is_null() => return Captured::Missing,
        Ok(value) if value.is_object() => value,
        _ => return Captured::Malformed,
    };
    let credential = match kind {
        Kind::ChatGpt => chatgpt(&value),
        Kind::Grok => json!({
            "accessToken":value["accessToken"], "email":nullable(&value["email"]),
            "expiresAt":value["expiresAt"], "kind":"grok",
            "planType":nullable(&value["planType"]), "refreshToken":nullable(&value["refreshToken"]),
            "userId":value["userId"], "version":value["version"]
        }),
    };
    match checked("providerCredentialProtectedContentSchema", &credential) {
        Ok(credential) => Captured::Available(credential),
        Err(_) => Captured::Malformed,
    }
}

fn chatgpt(value: &Value) -> Value {
    let tokens = &value["tokens"];
    let access = nullable(&tokens["access_token"]);
    let id = nullable(&tokens["id_token"]);
    let claims = jwt_claims(id);
    let auth = &claims["https://api.openai.com/auth"];
    let profile = &claims["https://api.openai.com/profile"];
    let expires = jwt_claims(access)["exp"]
        .as_f64()
        .filter(|expiry| expiry.fract() == 0.0 && *expiry > 0.0)
        .map(|expiry| expiry * 1000.0)
        .filter(|milliseconds| *milliseconds <= 9_007_199_254_740_991.0);
    json!({
        "accessToken":access, "accountId":first_string(&tokens["account_id"], &auth["chatgpt_account_id"]),
        "email":first_string(&claims["email"], &profile["email"]), "expiresAt":expires,
        "idToken":id, "kind":"chatgpt", "planType":nullable(&auth["chatgpt_plan_type"]),
        "refreshToken":nullable(&tokens["refresh_token"]),
        "userId":first_string(&auth["chatgpt_user_id"], &auth["user_id"]), "version":1
    })
}

fn nullable(value: &Value) -> Option<&JsString> {
    value.as_js_string().filter(|string| !string.is_empty())
}

fn first_string<'a>(value: &'a Value, fallback: &'a Value) -> Option<&'a JsString> {
    nullable(value).or_else(|| nullable(fallback))
}

pub(crate) async fn read(file: &Path) -> Result<Value> {
    let metadata = match fs::symlink_metadata(file).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        bail!("Legacy provider credential is not a bounded regular file.");
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    // FILE_FLAG_OPEN_REPARSE_POINT prevents following a late symlink swap.
    #[cfg(windows)]
    options.custom_flags(0x0020_0000);
    let handle = options.open(file).await?;
    if !handle.metadata().await?.is_file() {
        bail!("Legacy provider credential is not a regular file.");
    }
    let mut data = Vec::new();
    handle.take(MAX_BYTES + 1).read_to_end(&mut data).await?;
    if data.len() as u64 > MAX_BYTES {
        bail!("Legacy provider credential exceeds its byte limit.");
    }
    parse_json_text(&String::from_utf8_lossy(&data))
        .map_err(|_| anyhow!("Legacy provider credential is malformed."))
}

pub(crate) async fn discard(file: &Path) -> Result<()> {
    match fs::remove_file(file).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
