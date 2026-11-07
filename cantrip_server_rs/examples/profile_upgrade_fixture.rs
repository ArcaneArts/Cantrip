//! Deliberately corrupt one disposable migration journal after a real engine
//! open. This test-only executable is never included in a distribution.
use anyhow::{Context, Result};
use cantrip_server::database::Database;
#[tokio::main]
async fn main() -> Result<()> {
    let root = std::path::PathBuf::from(
        std::env::args_os()
            .nth(1)
            .context("disposable profile root")?,
    );
    let database = Database::pglite(&root.join("server-db")).await?;
    database.execute("ALTER TABLE drizzle.__drizzle_migrations RENAME COLUMN created_at TO unavailable_created_at").await?;
    database.close().await?;
    println!(
        "{}",
        serde_json::json!({"event":"profile.fixture.migration-journal.corrupted"})
    );
    Ok(())
}
