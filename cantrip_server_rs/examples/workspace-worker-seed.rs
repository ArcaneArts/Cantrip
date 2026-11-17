//! Development-only setup of an already-attached workspace in an owned stopped
//! profile. No production endpoints or fake worker handlers are installed.
use anyhow::{Context, Result};
use cantrip_server::{
    database::Database, migrations::migrate, projects::workspaces::WorkspaceRepository, wire::Value,
};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::Arc,
};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .context("Owned fixture data directory")?,
    );
    let mut input = String::new();
    BufReader::new(os_pipe::dup_stdin()?).read_line(&mut input)?;
    let mut diagnostics = os_pipe::dup_stderr()?;
    writeln!(diagnostics, "workspace seed opening stopped profile")?;
    let input: Value = serde_json::from_str(&input)?;
    let database = Arc::new(Database::pglite(&directory.join("server-db")).await?);
    writeln!(diagnostics, "workspace seed database opened")?;
    migrate(&database).await?;
    let owner = input["owner"].as_str().context("Fixture owner")?;
    database.query("INSERT INTO account_encryption_profiles(owner_id,format_version,active_master_key_revision) VALUES($1,1,1) ON CONFLICT(owner_id) DO NOTHING",&[&owner]).await?;
    WorkspaceRepository::new(database.clone())
        .create(owner, &input["workspace"], true)
        .await?;
    database.close().await?;
    Ok(())
}
