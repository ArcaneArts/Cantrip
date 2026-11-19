//! Offline logical export of a PostgreSQL 18 PGlite profile through a private
//! PostgreSQL build that uses the legacy by-reference datum ABI.
use super::{failure, files, pack_profile};
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
    let password = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let credential = serde_json::to_vec(&serde_json::json!({
        "username":"postgres", "password":password,
    }))?;
    files::write_private(&root.join("credentials.json"), &credential)?;
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

async fn export(source: &Path, output: &Path, binaries: &Path) -> Result<()> {
    let parent = output
        .parent()
        .context("legacy export destination parent")?;
    let owner = tempfile::Builder::new()
        .prefix(".cantrip-legacy-postgres-")
        .tempdir_in(parent)?;
    let root = owner.path().join("postgres");
    let data = root.join("data");
    files::copy_profile(&source.join("server-db"), &data, owner.path())?;
    authenticate_copy(&root, &data, binaries).await?;

    let runtime = ManagedPostgres::start(&root, binaries).await?;
    let sql = owner.path().join("database.sql");
    let result = async {
        let database = Database::postgres(runtime.configuration()).await?;
        let dump =
            database_transfer::export_sql(&database, &sql, &binary(binaries, "pg_dump")).await;
        let closed = database.close().await;
        dump?;
        closed
    }
    .await;
    let stopped = runtime.close().await;
    result?;
    stopped?;
    pack_profile(source, &sql, DatabaseMode::Pglite, output)?;
    Ok(())
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
        result = export(&source, &output, &binaries) => {
            result.map_err(|error| failure(error, "exporting the legacy PGlite profile with native PostgreSQL"))
        }
    }
}
