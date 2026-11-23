//! Existing version-1 worker identity and server-bound credential files.
//! Deliberately no Debug implementation for records containing credentials.
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, coercion::truthy, parse_json_text, value::json};
use std::{fs, io::Write, path::Path};

pub struct Credential {
    pub credential: String,
    pub server_url: String,
    pub worker_id: JsString,
}

pub fn valid_token(value: &str, prefix: &str, length: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == length
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| parse_json_text(&String::from_utf8_lossy(&bytes)).ok())
        .unwrap_or(Value::Null)
}

pub fn load(data_directory: &Path, server_url: &str) -> Result<Option<Credential>> {
    let path = data_directory.join("worker-credential.json");
    // Preserve missing-file behavior; malformed, unreadable and foreign-server
    // records are not treated as an unenrolled profile.
    match fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => {}
    }
    let parsed = read_json(&path);
    let worker_id = parsed["workerId"]
        .as_js_string()
        .filter(|value| !value.is_empty());
    let credential = parsed["credential"]
        .as_str()
        .filter(|value| valid_token(value, "ctwk_", 43));
    if parsed["version"] != 1
        || parsed["serverUrl"] != server_url
        || worker_id.is_none()
        || credential.is_none()
    {
        bail!(
            "The stored worker credential is invalid or belongs to another server. Remove worker-credential.json or use the matching CANTRIP_WORKER_DATA_DIR."
        );
    }
    private_permissions(&path)?;
    Ok(Some(Credential {
        credential: credential.unwrap().into(),
        server_url: server_url.into(),
        worker_id: worker_id.unwrap().clone(),
    }))
}

pub fn identity(data_directory: &Path) -> Result<JsString> {
    fs::create_dir_all(data_directory)?;
    let path = data_directory.join("worker-identity.json");
    let parsed = read_json(&path);
    if parsed["version"] == 1
        && let Some(worker_id) = parsed["workerId"]
            .as_js_string()
            .filter(|value| !value.is_empty())
    {
        private_permissions(&path)?;
        return Ok(worker_id.clone());
    }
    if truthy(Some(&parsed)) {
        bail!("The stored worker identity is invalid.");
    }
    let worker_id: JsString = format!("worker-{}", uuid::Uuid::new_v4()).into();
    let record = json!({"version":1,"workerId":worker_id.clone()});
    // wx in the original: malformed existing files are never overwritten.
    let mut file = cantrip_host::files::open_private(&path)?;
    file.write_all(format!("{}\n", record.stringify_pretty()).as_bytes())?;
    Ok(worker_id)
}

pub fn save(data_directory: &Path, credential: &Credential) -> Result<()> {
    fs::create_dir_all(data_directory)?;
    let path = data_directory.join("worker-credential.json");
    let temporary =
        data_directory.join(format!("worker-credential.json.{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let record = json!({"version":1,"serverUrl":credential.server_url,"workerId":credential.worker_id,"credential":credential.credential});
    let mut file = options.open(&temporary)?;
    file.write_all(format!("{}\n", record.stringify_pretty()).as_bytes())?;
    drop(file);
    fs::rename(temporary, &path)?;
    private_permissions(&path)?;
    Ok(())
}

fn private_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}
