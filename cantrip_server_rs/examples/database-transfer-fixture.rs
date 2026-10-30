//! Disposable logical-transfer probe. Never shipped as a server runtime.
use anyhow::{Context, Result};
use cantrip_server::{
    config::DatabaseMode, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate,
};
use clap::Parser;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Parser)]
struct Arguments {
    #[arg(long)]
    directory: PathBuf,
    #[arg(long, default_value = "pglite")]
    database: DatabaseMode,
    #[arg(long)]
    sql: Option<PathBuf>,
    #[arg(long)]
    no_migrate: bool,
}
fn identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
#[tokio::main]
async fn main() -> Result<()> {
    if cantrip_server::managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
    let arguments = Arguments::parse();
    let mut managed = None;
    let database = match arguments.database {
        DatabaseMode::Pglite => Database::pglite(&arguments.directory).await?,
        DatabaseMode::Postgres => Database::postgres_url(&std::env::var("DATABASE_URL")?).await?,
        DatabaseMode::BundledPostgres => {
            managed = Some(
                ManagedPostgres::start(
                    &arguments.directory,
                    &PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?),
                )
                .await?,
            );
            Database::postgres(managed.as_ref().unwrap().configuration()).await?
        }
    };
    if let Some(path) = arguments.sql {
        let sql = std::fs::read_to_string(path)?;
        database
            .transaction(|transaction| Box::pin(async move { transaction.execute(&sql).await }))
            .await?;
    }
    let migrations = if arguments.no_migrate {
        0
    } else {
        migrate(&database).await?
    };
    let version: String = database.query("SELECT version()", &[]).await?[0].get(0)?;
    database.execute("SET TIME ZONE 'UTC'").await?;
    let tables = database.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename", &[]).await?;
    let mut snapshot: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for table in tables {
        let schema: String = table.get(0)?;
        let name: String = table.get(1)?;
        let qualified = format!("{}.{}", identifier(&schema), identifier(&name));
        let rows = database
            .query(&format!("SELECT to_jsonb(t)::text FROM {qualified} t"), &[])
            .await?;
        let mut rows = rows
            .iter()
            .map(|row| row.get(0))
            .collect::<Result<Vec<String>>>()?;
        rows.sort();
        snapshot.insert(format!("{schema}.{name}"), rows);
    }
    let sequences = database.query("SELECT sequence_schema,sequence_name FROM information_schema.sequences WHERE sequence_schema IN ('public','drizzle') ORDER BY sequence_schema,sequence_name", &[]).await?;
    let mut sequence_snapshot: BTreeMap<String, Value> = BTreeMap::new();
    for sequence in sequences {
        let schema: String = sequence.get(0)?;
        let name: String = sequence.get(1)?;
        let qualified = format!("{}.{}", identifier(&schema), identifier(&name));
        let row = database
            .query(
                &format!("SELECT last_value::text,is_called FROM {qualified}"),
                &[],
            )
            .await?;
        let row = row.first().context("sequence state")?;
        sequence_snapshot.insert(
            format!("{schema}.{name}"),
            json!({"value":row.get::<String>(0)?,"called":row.get::<bool>(1)?}),
        );
    }
    database.close().await?;
    if let Some(managed) = managed {
        managed.close().await?;
    }
    println!(
        "\n{}",
        json!({"version":version,"migrationsApplied":migrations,"tables":snapshot,"sequences":sequence_snapshot})
    );
    Ok(())
}
