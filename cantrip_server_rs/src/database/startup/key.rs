//! Preserve the retained key file; never replace malformed existing metadata.
use crate::{
    config::{ConfigError, ServerConfig},
    wire::{self, Value},
};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
};

fn read(file: &Path) -> Result<()> {
    let bytes = fs::read(file)?;
    let parsed =
        wire::parse_json_text(&String::from_utf8_lossy(&bytes)).map_err(|message| ConfigError {
            name: "SyntaxError",
            message: message.lossy().into_owned(),
        })?;
    ensure!(
        matches!(parsed, Value::Object(_)),
        "Encrypted secret metadata is malformed."
    );
    ensure!(
        parsed["version"].as_f64() == Some(1.0)
            && parsed["id"].as_str() == Some("local-v1")
            && parsed["key"].as_js_string().is_some(),
        "Local secret encryption key file is malformed."
    );
    let key = parsed["key"].as_str().unwrap_or("");
    let decoded = STANDARD.decode(key).ok();
    ensure!(
        decoded
            .as_ref()
            .is_some_and(|bytes| bytes.len() == 32 && STANDARD.encode(bytes) == key),
        "Encrypted secret envelope is malformed."
    );
    Ok(())
}
pub(super) fn resolve(config: &ServerConfig) -> Result<()> {
    if config.secret_encryption.is_some() {
        return Ok(());
    }
    fs::create_dir_all(&config.data_directory)?;
    let file = config.data_directory.join("secret-encryption-key.json");
    match read(&file) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
            }
            return Ok(());
        }
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == ErrorKind::NotFound) => {}
        Err(error) => return Err(error),
    }
    let mut key = [0; 32];
    getrandom::fill(&mut key)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&file) {
        Ok(mut out) => writeln!(
            out,
            "{}",
            serde_json::json!({"id":"local-v1","key":STANDARD.encode(key),"version":1})
        )
        .map_err(Into::into),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => read(&file),
        Err(error) => Err(error.into()),
    }
}
