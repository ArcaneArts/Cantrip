use anyhow::{Context, Result};

use crate::database::Database;

pub struct Migration {
    pub name: &'static str,
    pub when: i64,
    pub hash: &'static str,
    pub sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// Keep Drizzle's journal and original migration bytes; no second schema ledger.
pub async fn migrate(database: &Database) -> Result<usize> {
    database.transaction(|transaction| Box::pin(async move {
        transaction.execute("SELECT pg_advisory_xact_lock(4310, 1)").await?;
        transaction.execute("CREATE SCHEMA IF NOT EXISTS drizzle;
            CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
                id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
            )").await?;
        let prior = transaction.query("SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1", &[]).await?;
        let latest = prior.first().map(|row| row.get::<i64>(0)).transpose()?;
        let mut applied = 0;
        for migration in MIGRATIONS {
            if latest.is_some_and(|when| when >= migration.when) { continue; }
            for statement in migration.sql.split("--> statement-breakpoint") {
                if !statement.trim().is_empty() {
                    transaction.execute(statement).await.with_context(|| format!("apply migration {}", migration.name))?;
                }
            }
            transaction.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", &[&migration.hash, &migration.when]).await?;
            applied += 1;
        }
        Ok(applied)
    })).await
}
