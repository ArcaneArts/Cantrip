use super::{
    failure,
    files::{self, Entry},
    publish, remember_database,
};
use crate::{
    config::{DatabaseMode, Environment, ServerConfig},
    database::Database,
    database_transfer::{self, RestoreReceipt},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    bundle_id: Uuid,
    database_mode: DatabaseMode,
    sql_bytes: u64,
    sql_sha256: String,
    files: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReceipt {
    pub bundle_id: Uuid,
    pub manifest_sha256: String,
    pub database_mode: DatabaseMode,
    pub file_count: usize,
    pub file_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<RestoreReceipt>,
}
struct Stage {
    owner: TempDir,
    payload: PathBuf,
    destination: PathBuf,
}
impl Stage {
    fn new(destination: &Path) -> Result<Self> {
        let destination = std::path::absolute(destination)?;
        let parent = destination.parent().context("Profile destination parent")?;
        files::private_directory(parent)?;
        let owner = tempfile::Builder::new()
            .prefix(".cantrip-profile-")
            .tempdir_in(parent)?;
        // Set this before placing any profile assets or SQL in the directory;
        // the native database may have changed the process-wide umask.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(owner.path(), fs::Permissions::from_mode(0o700))?;
        }
        let payload = owner.path().join("profile");
        files::private_directory(&payload)?;
        Ok(Self {
            owner,
            payload,
            destination,
        })
    }
    fn publish(&self) -> Result<()> {
        publish::directory(&self.payload, &self.destination)?;
        Ok(())
    }
}
fn receipt(
    manifest: &Manifest,
    digest: String,
    mode: DatabaseMode,
    database: Option<RestoreReceipt>,
) -> Result<ProfileReceipt> {
    let file_bytes = manifest.files.iter().try_fold(0u64, |sum, e| {
        sum.checked_add(e.bytes)
            .context("Profile file byte count overflow")
    })?;
    Ok(ProfileReceipt {
        bundle_id: manifest.bundle_id,
        manifest_sha256: digest,
        database_mode: mode,
        file_count: manifest.files.iter().filter(|e| !e.directory).count(),
        file_bytes,
        database,
    })
}
fn finish_bundle(
    stage: Stage,
    source: &Path,
    mode: DatabaseMode,
    sql_bytes: u64,
    sql_sha256: String,
) -> Result<ProfileReceipt> {
    let assets = files::snapshot(source, &stage.payload.join("files"), stage.owner.path())?;
    let manifest = Manifest {
        version: 1,
        bundle_id: Uuid::new_v4(),
        database_mode: mode,
        sql_bytes,
        sql_sha256,
        files: assets,
    };
    let encoded = serde_json::to_vec(&manifest)?;
    files::write_private(&stage.payload.join("manifest.json"), &encoded)?;
    let result = receipt(
        &manifest,
        format!("{:x}", Sha256::digest(&encoded)),
        mode,
        None,
    )?;
    #[cfg(unix)]
    fs::File::open(&stage.payload)?.sync_all()?;
    stage.publish()?;
    Ok(result)
}
/// The source server is stopped. Its database is already open offline; no
/// identities, migrations or background services are started by this export.
pub async fn export_profile(
    database: &Database,
    config: &ServerConfig,
    output: &Path,
    pg_dump: &Path,
) -> Result<ProfileReceipt> {
    let result: Result<_> = async {
        let stage = Stage::new(output)?;
        let receipt =
            database_transfer::export_sql(database, &stage.payload.join("database.sql"), pg_dump)
                .await?;
        finish_bundle(
            stage,
            &config.data_directory,
            config.database_mode,
            receipt.bytes.try_into()?,
            receipt.sha256,
        )
    }
    .await;
    result.map_err(|e| failure(e, "exporting the profile"))
}
/// Package an existing trusted logical export with the stopped profile's files.
/// Used by the bounded legacy converter; this path opens no database.
pub fn pack_profile(
    source: &Path,
    sql: &Path,
    mode: DatabaseMode,
    output: &Path,
) -> Result<ProfileReceipt> {
    let result = (|| {
        let stage = Stage::new(output)?;
        let (bytes, digest) = files::digest_copy(sql, &stage.payload.join("database.sql"))?;
        finish_bundle(stage, source, mode, bytes, digest)
    })();
    result.map_err(|e| failure(e, "packing the logical profile"))
}
pub struct Bundle {
    root: PathBuf,
    manifest: Manifest,
    digest: String,
}
impl Bundle {
    pub fn open(root: &Path) -> Result<Self> {
        let result = (|| {
            let root = std::path::absolute(root)?;
            let bytes = fs::read(root.join("manifest.json"))?;
            let manifest: Manifest = serde_json::from_slice(&bytes)?;
            ensure!(manifest.version == 1, "Unsupported profile bundle version");
            Ok(Self {
                root,
                manifest,
                digest: format!("{:x}", Sha256::digest(&bytes)),
            })
        })();
        result.map_err(|e| failure(e, "reading the profile bundle"))
    }
    pub fn apply_database_defaults(&self, environment: &mut Environment) {
        if !environment.contains_key("CANTRIP_DATABASE_MODE")
            && environment
                .get("DATABASE_URL")
                .is_none_or(|v| crate::text::trim(v).is_empty())
        {
            let mode = match self.manifest.database_mode {
                DatabaseMode::Pglite => "pglite",
                DatabaseMode::BundledPostgres => "bundled-postgres",
                DatabaseMode::Postgres => "postgres",
            };
            environment.insert("CANTRIP_DATABASE_MODE".into(), mode.into());
        }
    }
    pub fn stage(self, destination: &Path) -> Result<RestoreStage> {
        let result = (|| {
            let stage = Stage::new(destination)?;
            files::restore(
                &self.root.join("files"),
                &stage.payload,
                &self.manifest.files,
            )?;
            let sql = stage.owner.path().join("database.sql");
            let (bytes, sha256) = files::digest_copy(&self.root.join("database.sql"), &sql)?;
            ensure!(
                bytes == self.manifest.sql_bytes && sha256 == self.manifest.sql_sha256,
                "Profile SQL checksum does not match its manifest"
            );
            Ok(RestoreStage {
                stage,
                bundle: self,
                sql,
            })
        })();
        result.map_err(|e| failure(e, "staging the profile files"))
    }
}
pub struct RestoreStage {
    stage: Stage,
    bundle: Bundle,
    sql: PathBuf,
}
impl RestoreStage {
    /// The bounded legacy importer needs these verified assets and SQL before
    /// it creates its JavaScript-hosted physical database in a private stage.
    pub fn materialize(self) -> Result<ProfileReceipt> {
        let result = (|| {
            files::digest_copy(
                &self.sql,
                &self.stage.payload.join("server-profile-import.sql"),
            )?;
            let result = receipt(
                &self.bundle.manifest,
                self.bundle.digest.clone(),
                self.bundle.manifest.database_mode,
                None,
            )?;
            self.stage.publish()?;
            Ok(result)
        })();
        result.map_err(|e| failure(e, "materializing the logical profile"))
    }
    pub fn data_directory(&self) -> &Path {
        &self.stage.payload
    }
    pub async fn restore(&self, database: &Database) -> Result<RestoreReceipt> {
        // Include the entire manifest digest in the durable operation key, so a
        // different file set cannot accidentally reuse a previous import.
        database_transfer::restore_profile_sql(
            database,
            &self.sql,
            format!(
                "profile-import:{}:{}",
                self.bundle.manifest.bundle_id, self.bundle.digest
            ),
        )
        .await
    }
    /// Database sessions and private postmasters must be closed before rename.
    pub fn publish(
        self,
        config: &ServerConfig,
        database: RestoreReceipt,
    ) -> Result<ProfileReceipt> {
        let result = (|| {
            remember_database(config)?;
            let result = receipt(
                &self.bundle.manifest,
                self.bundle.digest.clone(),
                config.database_mode,
                Some(database),
            )?;
            files::write_private(
                &self.stage.payload.join("server-profile-receipt.json"),
                &serde_json::to_vec(&result)?,
            )?;
            #[cfg(unix)]
            fs::File::open(&self.stage.payload)?.sync_all()?;
            self.stage.publish()?;
            Ok(result)
        })();
        result.map_err(|e| failure(e, "publishing the restored profile"))
    }
}
