//! Offline logical transfer of a PostgreSQL 18 PGlite profile through a private
//! PostgreSQL build that uses the legacy by-reference datum ABI.
use super::{
    Bundle, ProfileReceipt,
    bundle::{Stage, finish_bundle},
    failure, files,
};
use crate::{
    config::DatabaseMode, database::Database, database_transfer, managed_postgres::ManagedPostgres,
};
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{io::AsyncWriteExt, process::Command};
use uuid::Uuid;

fn binary(directory: &Path, name: &str) -> PathBuf {
    directory.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

fn replace(path: &Path, contents: &[u8]) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(files::write_private(path, contents)?)
}

fn temporary_credentials(root: &Path) -> Result<String> {
    let password = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let credential = serde_json::to_vec(&serde_json::json!({
        "username":"postgres", "password":password,
    }))?;
    files::write_private(&root.join("credentials.json"), &credential)?;
    Ok(password)
}

async fn authenticate_copy(root: &Path, data: &Path, binaries: &Path) -> Result<()> {
    // Only standard, local PostgreSQL settings are inherited from the binary.
    // The copied profile can contain settings for a different operating system.
    replace(&data.join("postgresql.conf"), b"log_min_messages = fatal\n")?;
    replace(&data.join("postgresql.auto.conf"), b"")?;
    replace(&data.join("pg_ident.conf"), b"")?;
    replace(
        &data.join("pg_hba.conf"),
        b"host postgres postgres 127.0.0.1/32 scram-sha-256\n",
    )?;
    let password = temporary_credentials(root)?;
    let mut command = Command::new(binary(binaries, "postgres"));
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .args(["--single", "-D"])
        .arg(data)
        .arg("postgres")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("open private legacy PGlite copy")?;
    let mut input = child.stdin.take().context("legacy PostgreSQL stdin")?;
    // Only the generated hexadecimal secret enters SQL. The isolated loopback
    // connection below verifies the change by authenticating with this secret.
    input
        .write_all(format!("ALTER ROLE postgres PASSWORD '{password}';\n").as_bytes())
        .await?;
    drop(input);
    ensure!(
        child.wait().await?.success(),
        "Legacy PGlite copy could not be opened."
    );
    Ok(())
}

pub async fn export_legacy_profile(
    source: &Path,
    output: &Path,
    binaries: &Path,
) -> Result<ProfileReceipt> {
    let result = async {
        let stage = Stage::new(output)?;
        let root = stage.owner.path().join("postgres");
        let data = root.join("data");
        let sql = stage.payload.join("database.sql");
        files::copy_profile(&source.join("server-db"), &data, stage.owner.path())?;
        authenticate_copy(&root, &data, binaries).await?;

        let runtime = ManagedPostgres::start(&root, binaries).await?;
        let dump = async {
            let database = Database::postgres(runtime.configuration()).await?;
            let export =
                database_transfer::export_sql(&database, &sql, &binary(binaries, "pg_dump")).await;
            let closed = database.close().await;
            let export = export?;
            closed?;
            Ok::<_, anyhow::Error>(export)
        }
        .await;
        let stopped = runtime.close().await;
        let dump = dump?;
        stopped?;
        // Bundle snapshotting excludes this whole staging directory, even when
        // the operator exports into a subdirectory of the source.
        finish_bundle(
            stage,
            source,
            DatabaseMode::Pglite,
            dump.bytes.try_into()?,
            dump.sha256,
        )
    }
    .await;
    result.map_err(|e| failure(e, "exporting the legacy PGlite profile"))
}

async fn initialize(root: &Path, data: &Path, binaries: &Path) -> Result<()> {
    files::private_directory(root)?;
    let password = temporary_credentials(root)?;
    let password_file = root.join("init-password");
    files::write_private(&password_file, format!("{password}\n").as_bytes())?;
    let mut command = Command::new(binary(binaries, "initdb"));
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let status = command
        .args([
            "--no-instructions",
            "--encoding=UTF8",
            "--locale=C",
            "--lc-ctype=C.UTF-8",
            "--username=postgres",
            "--auth=scram-sha-256",
            "--pwfile",
        ])
        .arg(&password_file)
        .arg("-D")
        .arg(data)
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .context("initialize legacy PGlite cluster")?;
    fs::remove_file(password_file)?;
    ensure!(
        status.success(),
        "Could not initialize the legacy PGlite cluster."
    );
    Ok(())
}

pub async fn restore_legacy_profile(
    bundle: &Path,
    output: &Path,
    binaries: &Path,
) -> Result<ProfileReceipt> {
    let result = async {
        let stage = Bundle::open(bundle)?.stage(output)?;
        let root = stage.working_directory().join("postgres");
        let data = root.join("data");
        initialize(&root, &data, binaries).await?;
        let sql = tokio::fs::read_to_string(stage.verified_sql()).await?;
        let runtime = ManagedPostgres::start(&root, binaries).await?;
        let restored = async {
            let database = Database::postgres(runtime.configuration()).await?;
            let imported = database.transaction(|transaction| Box::pin(async move {
                transaction.execute(&sql).await?;
                // Query the actual cluster and a persisted expression created
                // in it. Stock PostgreSQL could restore every row but would
                // publish an unreadable legacy profile.
                transaction.execute(
                    "CREATE TEMP TABLE pg_temp.cantrip_legacy_format_probe (n int4 DEFAULT 16909060) ON COMMIT DROP"
                ).await?;
                let compatible: bool = transaction.query(
                    "SELECT NOT float8_pass_by_value AND default_char_signedness
                         AND max_data_alignment = 8 AND database_block_size = 8192
                         AND EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef
                           WHERE adrelid = 'pg_temp.cantrip_legacy_format_probe'::regclass
                             AND adbin::text LIKE '%:constvalue 4 [ 4 3 2 1 ]%')
                       FROM pg_catalog.pg_control_init()",
                    &[],
                ).await?[0].get(0)?;
                ensure!(compatible, "The initialized database uses a different PGlite format.");
                transaction.execute("ALTER ROLE postgres PASSWORD NULL").await?;
                Ok(())
            })).await;
            let closed = database.close().await;
            imported?;
            closed
        }.await;
        let stopped = runtime.close().await;
        restored?;
        stopped?;
        fs::rename(data, stage.data_directory().join("server-db"))?;
        stage.publish_legacy()
    }.await;
    result.map_err(|e| failure(e, "restoring the legacy PGlite profile"))
}

/// Internal child of an offline operation. Its owner retains the source lease
/// and pipe. Dropping conversion on EOF terminates the single-user child and
/// closes the pipe owning a private managed PostgreSQL postmaster.
pub(super) async fn run(source: &Path, output: &Path, binaries: &Path) -> Result<()> {
    let source = std::path::absolute(source)?;
    let output = std::path::absolute(output)?;
    let binaries = std::path::absolute(binaries)?;
    let owner = cantrip_host::process::pipe_closed(os_pipe::dup_stdin()?, "legacy-profile-owner")?;
    tokio::select! {
        biased;
        _ = owner => Ok(()),
        result = export_legacy_profile(&source, &output, &binaries) => result.map(|_| ()),
    }
}
