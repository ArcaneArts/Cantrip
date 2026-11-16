use anyhow::{Result, anyhow};
use cantrip_crypto::{HpkeKeyPair, Zeroizing, checked, decode, encode};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const FILENAME: &str = "worker-encryption-key.json";

#[derive(Debug)]
pub struct IdentityError {
    pub code: &'static str,
    message: &'static str,
}
impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for IdentityError {}
fn error(code: &'static str, message: &'static str) -> anyhow::Error {
    IdentityError { code, message }.into()
}
fn corrupt(message: &'static str) -> anyhow::Error {
    error("corrupt-key-record", message)
}

/// Endpoint private key plus persisted bindings/high-water revisions. No Debug
/// or serializer can accidentally expose this object's private key to a log.
/// Stored bindings are not proof of current server authorization.
pub struct Identity {
    pathname: PathBuf,
    server_url: String,
    worker_id: JsString,
    principal_id: String,
    keys: HpkeKeyPair,
    owner_id: Value,
    server_id: Value,
    accepted_revisions: Value,
}
impl Identity {
    pub fn open(
        directory: &Path,
        server_url: &str,
        worker_id: &JsString,
        allow_loopback_port_change: bool,
    ) -> Result<Self> {
        let server_url = canonical_url(server_url, allow_loopback_port_change)?;
        let pathname = directory.join(FILENAME);
        // Read the actual record; absence creates it. Other read/parse failures
        // never cause regeneration or overwrite an existing private key.
        let input = match fs::read(&pathname) {
            Ok(bytes) => Some(Zeroizing::new(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(corrupt("The stored worker encryption key is invalid.")),
        };
        let Some(input) = input else {
            let identity = Self {
                pathname,
                server_url,
                worker_id: worker_id.clone(),
                principal_id: uuid::Uuid::new_v4().to_string(),
                keys: HpkeKeyPair::generate(),
                owner_id: Value::Null,
                server_id: Value::Null,
                accepted_revisions: json!({}),
            };
            identity.write_binding(
                &identity.owner_id,
                &identity.server_id,
                &identity.accepted_revisions,
            )?;
            return Ok(identity);
        };
        let text = Zeroizing::new(String::from_utf8_lossy(&input).into_owned());
        let record = parse_json_text(&text)
            .map_err(|_| corrupt("The stored worker encryption key is invalid."))?;
        if !matches!(record, Value::Object(_) | Value::Array(_)) {
            return Err(corrupt("The stored worker encryption key is invalid."));
        }
        let public = checked("encryptionPublicKeySchema", &record["publicKey"])
            .map_err(|_| corrupt("The stored worker encryption public key is invalid."))?;
        let principal = record["principalId"]
            .as_str()
            .filter(|v| v.len() == 36)
            .and_then(|v| uuid::Uuid::parse_str(v).ok());
        let valid_principal = principal.is_some_and(|v| {
            v.get_version() == Some(uuid::Version::Random)
                && v.get_variant() == uuid::Variant::RFC4122
        });
        if !(record["version"] == 1 || record["version"] == 2)
            || !valid_principal
            || !record["privateKey"].is_string()
            || !record
                .get("ownerId")
                .is_some_and(|v| v.is_null() || v.is_string())
            || !matches!(
                record.get("acceptedRevisions"),
                Some(Value::Object(_) | Value::Array(_))
            )
        {
            return Err(corrupt("The stored worker encryption key is invalid."));
        }
        let stored = record[if record["version"] == 1 {
            "serverId"
        } else {
            "serverUrl"
        }]
        .as_str()
        .ok_or_else(|| corrupt("The stored worker encryption server transport is invalid."))?;
        let stored = canonical_url(stored, allow_loopback_port_change)
            .map_err(|_| corrupt("The stored worker encryption server identity is invalid."))?;
        let transition = !allow_loopback_port_change && portless_transition(&stored, &server_url);
        if (!transition && stored != server_url) || record["workerId"] != json!(worker_id) {
            return Err(error(
                "identity-mismatch",
                "The stored worker encryption key belongs to another server or worker identity.",
            ));
        }
        let server_id = if record["version"] == 1 {
            Value::Null
        } else {
            let value = record.get("serverId").ok_or_else(|| {
                corrupt("The stored worker encryption logical server identity is invalid.")
            })?;
            if !value.is_null()
                && cantrip_protocol::parse_property(
                    "workerEncryptionBootstrapResultSchema",
                    "serverId",
                    value,
                )
                .is_err()
            {
                return Err(corrupt(
                    "The stored worker encryption logical server identity is invalid.",
                ));
            }
            value.clone()
        };
        private_permissions(&pathname)?;
        let private = Zeroizing::new(decode(record["privateKey"].as_str().unwrap())?);
        let keys = HpkeKeyPair::import(&private, &public)
            .map_err(|_| corrupt("The stored worker encryption keypair does not match."))?;
        let mut accepted_revisions = json!({});
        let entries: Vec<(JsString, Value)> = match &record["acceptedRevisions"] {
            Value::Object(fields) => fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            Value::Array(values) => values
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string().into(), v.clone()))
                .collect(),
            _ => unreachable!(),
        };
        for (component, revision) in entries {
            // Preserve Node's stored safe-integer acceptance, including values
            // beyond the current transported revision range. Never lower it.
            checked(
                "workerEncryptionComponentScopeSchema",
                &json!(component.clone()),
            )?;
            if !revision
                .as_u64()
                .is_some_and(|v| (1..=9_007_199_254_740_991).contains(&v))
            {
                return Err(corrupt(
                    "The stored worker encryption revision state is invalid.",
                ));
            }
            if let Value::Object(fields) = &mut accepted_revisions {
                fields.insert(component, revision);
            }
        }
        Ok(Self {
            pathname,
            server_url,
            worker_id: worker_id.clone(),
            principal_id: record["principalId"].as_str().unwrap().to_owned(),
            keys,
            owner_id: record["ownerId"].clone(),
            server_id,
            accepted_revisions,
        })
    }
    pub fn registration(&self) -> Value {
        json!({"principalId":self.principal_id,"publicKey":self.keys.public_key()})
    }
    pub fn key_pair(&self) -> &HpkeKeyPair {
        &self.keys
    }
    pub fn bound_owner(&self) -> &Value {
        &self.owner_id
    }
    pub fn bound_server(&self) -> &Value {
        &self.server_id
    }
    pub fn accepted_revisions(&self) -> &Value {
        &self.accepted_revisions
    }
    /// Only the authenticated bootstrap service may authorize a new binding.
    /// Publication succeeds before this object's accepted state changes.
    pub fn persist_binding(
        &mut self,
        owner: &Value,
        server: &Value,
        revisions: &Value,
    ) -> Result<()> {
        self.write_binding(owner, server, revisions)?;
        self.owner_id = owner.clone();
        self.server_id = server.clone();
        self.accepted_revisions = revisions.clone();
        Ok(())
    }
    fn write_binding(&self, owner: &Value, server: &Value, revisions: &Value) -> Result<()> {
        let private = self.keys.private_key();
        let record = json!({"version":2,"serverUrl":self.server_url,"serverId":server,"ownerId":owner,"workerId":self.worker_id,"principalId":self.principal_id,"publicKey":self.keys.public_key(),"privateKey":encode(&private),"acceptedRevisions":revisions});
        let text = Zeroizing::new(format!("{}\n", record.stringify_pretty()));
        fs::create_dir_all(self.pathname.parent().unwrap())?;
        let temporary = self.pathname.with_file_name(format!(
            "{FILENAME}.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        // A failed exclusive open owns no path and must not remove it.
        let mut file = cantrip_host::files::open_private(&temporary)?;
        let result = (|| -> Result<()> {
            private_permissions(&temporary)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.pathname)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}
fn private_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn loopback(url: &url::Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    )
}
fn canonical_url(input: &str, allow_port_change: bool) -> Result<String> {
    let mut url = url::Url::parse(input).map_err(|_| {
        error(
            "identity-mismatch",
            "Worker encryption requires an HTTP(S) server origin.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some_and(|s| !s.is_empty())
        || !matches!(url.path(), "" | "/")
        || url.query().is_some_and(|s| !s.is_empty())
        || url.fragment().is_some_and(|s| !s.is_empty())
    {
        return Err(error(
            "identity-mismatch",
            "Worker encryption requires an HTTP(S) server origin.",
        ));
    }
    if allow_port_change && loopback(&url) {
        url.set_port(None)
            .map_err(|_| anyhow!("Invalid worker server port."))?;
    }
    Ok(url.origin().ascii_serialization())
}
fn portless_transition(stored: &str, expected: &str) -> bool {
    let (Ok(stored), Ok(expected)) = (url::Url::parse(stored), url::Url::parse(expected)) else {
        return false;
    };
    loopback(&stored)
        && stored.scheme() == expected.scheme()
        && stored.host() == expected.host()
        && stored.port().is_none()
        && expected.port().is_some()
}
