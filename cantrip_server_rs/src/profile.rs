//! Durable database selection for an installation. This is configuration, not
//! a database-capability probe: the selected backend performs the actual open.
mod bundle;
mod files;
mod publish;
use crate::config::{DatabaseMode, Environment, ServerConfig};
use anyhow::{Result, anyhow};
pub use bundle::{Bundle, ProfileReceipt, RestoreStage, export_profile, pack_profile};
pub fn publish_directory(source: &Path, destination: &Path) -> Result<()> {
    let source = std::path::absolute(source)?;
    let destination = std::path::absolute(destination)?;
    publish::directory(&source, &destination)
        .map_err(|e| failure(e.into(), "publishing the converted profile"))
}
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

const DATABASE_FILE: &str = "server-database.json";

pub struct ProfileFailure {
    phase: &'static str,
    pub io_kind: Option<std::io::ErrorKind>,
    original: anyhow::Error,
}
impl ProfileFailure {
    pub fn original(&self) -> &anyhow::Error {
        &self.original
    }
}
impl std::fmt::Display for ProfileFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Profile transfer failed during {}", self.phase)?;
        if let Some(kind) = self.io_kind {
            write!(f, " ({kind:?})")?;
        }
        Ok(())
    }
}
impl std::fmt::Debug for ProfileFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for ProfileFailure {}
fn failure(error: anyhow::Error, phase: &'static str) -> anyhow::Error {
    let io_kind = error.chain().find_map(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind)
    });
    ProfileFailure {
        phase,
        io_kind,
        original: error,
    }
    .into()
}

// Deliberately no Debug: a configured PostgreSQL URL can contain credentials.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseProfile {
    version: u8,
    database_mode: DatabaseMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    database_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    postgres_bin_directory: Option<PathBuf>,
}

/// Explicit backend configuration wins as a whole, including the existing
/// DATABASE_URL selection rule. An empty URL does not select external storage.
/// Never inspect PostgreSQL metadata to decide whether the backend may open.
pub fn apply_database(environment: &mut Environment, cwd: &Path) -> Result<()> {
    if environment.contains_key("CANTRIP_DATABASE_MODE")
        || environment
            .get("DATABASE_URL")
            .is_some_and(|v| !crate::text::trim(v).is_empty())
    {
        return Ok(());
    }
    let root = ServerConfig::data_directory(environment, cwd);
    let bytes = match std::fs::read(root.join(DATABASE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(anyhow!("Cannot read the stored database configuration.")),
    };
    // Do not render parser errors or the file: they can contain a private URL.
    let profile: DatabaseProfile = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow!("The stored database configuration is invalid."))?;
    anyhow::ensure!(
        profile.version == 1,
        "The stored database configuration version is unsupported."
    );
    let mode = match profile.database_mode {
        DatabaseMode::Pglite => "pglite",
        DatabaseMode::BundledPostgres => "bundled-postgres",
        DatabaseMode::Postgres => "postgres",
    };
    environment.insert("CANTRIP_DATABASE_MODE".into(), mode.into());
    if let Some(url) = profile.database_url {
        // A nonempty explicit URL already returned above. Empty template/env
        // values are omitted configuration, so retain the stored connection.
        environment.insert("DATABASE_URL".into(), url);
    }
    if let Some(directory) = profile.postgres_bin_directory {
        let directory = directory
            .to_str()
            .ok_or_else(|| anyhow!("Stored PostgreSQL path must be UTF-8."))?;
        environment
            .entry("CANTRIP_POSTGRES_BIN_DIR".into())
            .or_insert_with(|| directory.into());
    }
    Ok(())
}

/// Persist only after the caller has successfully opened/migrated the selected
/// backend. Offline export never calls this. Replacement is private and atomic.
pub fn remember_database(config: &ServerConfig) -> Result<()> {
    let root = &config.data_directory;
    let mut directories = std::fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directories.mode(0o700);
    }
    directories
        .create(root)
        .map_err(|_| anyhow!("Cannot create the database configuration directory."))?;
    let profile = DatabaseProfile {
        version: 1,
        database_mode: config.database_mode,
        database_url: if config.database_mode == DatabaseMode::Postgres {
            config.database_url.clone()
        } else {
            None
        },
        postgres_bin_directory: config.postgres_bin_directory.clone(),
    };
    let mut bytes = serde_json::to_vec(&profile)?;
    bytes.push(b'\n');
    let mut pending = tempfile::Builder::new()
        .prefix(".cantrip-database-")
        .tempfile_in(root)
        .map_err(|_| anyhow!("Cannot stage the database configuration."))?;
    pending
        .write_all(&bytes)
        .and_then(|_| pending.as_file().sync_all())
        .map_err(|_| anyhow!("Cannot write the database configuration."))?;
    pending
        .persist(root.join(DATABASE_FILE))
        .map_err(|_| anyhow!("Cannot publish the database configuration."))?;
    #[cfg(unix)]
    std::fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| anyhow!("Cannot sync the database configuration directory."))?;
    Ok(())
}
