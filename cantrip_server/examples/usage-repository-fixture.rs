//! Disposable repository IPC adapter. This is not a production entrypoint.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository,
    database::Database,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    usage::{FlushBatch, HistoryOptions, repository::UsageRepository},
};
use chrono::{DateTime, Utc};
use clap::Parser;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::Arc,
};
#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value = "pglite")]
    database: String,
}
fn text<'a>(request: &'a Value, key: &str) -> Result<&'a str> {
    request[key].as_str().context("fixture string")
}
fn date(request: &Value, key: &str) -> Result<DateTime<Utc>> {
    Ok(text(request, key)?.parse()?)
}
async fn operation(repo: &UsageRepository, request: &Value) -> Result<Value> {
    Ok(match text(request, "op")? {
        "sql" => {
            repo.database.execute(text(request, "sql")?).await?;
            Value::Null
        }
        "query-json" => repo
            .database
            .query(text(request, "sql")?, &[])
            .await?
            .first()
            .context("fixture JSON query")?
            .get(0)?,
        "measure" => serde_json::to_value(repo.measure_storage().await?)?,
        "current" => serde_json::to_value(repo.current_storage(text(request, "owner")?).await?)?,
        "storage-history" => serde_json::to_value(
            repo.storage_history(
                text(request, "owner")?,
                date(request, "from")?,
                date(request, "to")?,
                request["resolution"] == "hour",
            )
            .await?,
        )?,
        "bandwidth-history" => serde_json::to_value(
            repo.bandwidth_history(
                text(request, "owner")?,
                date(request, "from")?,
                date(request, "to")?,
                request["resolution"] == "hour",
            )
            .await?,
        )?,
        "flush" => serde_json::to_value(
            repo.flush_bandwidth(serde_json::from_value::<FlushBatch>(
                request["batch"].clone(),
            )?)
            .await?,
        )?,
        "acquire" => json!(
            repo.acquire_lease(
                text(request, "key")?,
                text(request, "holder")?,
                date(request, "now")?,
                request["leaseMs"].as_i64().context("fixture lease")?
            )
            .await?
        ),
        "release" => {
            repo.release_lease(text(request, "key")?, text(request, "holder")?)
                .await?;
            Value::Null
        }
        "reconcile" => serde_json::to_value(
            repo.reconcile_storage(text(request, "holder")?, date(request, "measuredAt")?)
                .await?,
        )?,
        "maintenance" => serde_json::to_value(
            repo.maintain_history(
                text(request, "holder")?,
                date(request, "now")?,
                serde_json::from_value::<HistoryOptions>(request["options"].clone())?,
            )
            .await?,
        )?,
        "totals" => serde_json::to_value(repo.operational_totals().await?)?,
        _ => anyhow::bail!("Unknown usage fixture operation"),
    })
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    if cantrip_server::managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
    let args = Arguments::parse();
    let root = PathBuf::from(std::env::var("CANTRIP_DATA_DIR")?);
    let input = os_pipe::dup_stdin()?;
    let mut output = os_pipe::dup_stdout()?;
    let mut managed = None;
    let database = Arc::new(match args.database.as_str() {
        "pglite" => Database::pglite(&root.join("server-db")).await?,
        "postgres" => Database::postgres_url(&std::env::var("DATABASE_URL")?).await?,
        "bundled-postgres" => {
            let runtime = ManagedPostgres::start(
                &root.join("postgres"),
                &PathBuf::from(std::env::var("CANTRIP_POSTGRES_BIN_DIR")?),
            )
            .await?;
            let db = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            db
        }
        _ => anyhow::bail!("Unknown fixture database"),
    });
    migrate(&database).await?;
    AuthRepository::new(database.clone()).local_user().await?;
    let repo = UsageRepository::new(database.clone());
    writeln!(
        output,
        "\n{}",
        json!({"event":"server.listening","origin":"usage-repository-fixture"})
    )?;
    output.flush()?;
    for line in io::BufReader::new(input).lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let result = operation(&repo, &request).await;
        let mut reply = json!({"id":request["id"],"rejected":result.is_err()});
        match result {
            Ok(value) => reply["value"] = value,
            Err(error) => reply["diagnostic"] = json!(error.to_string()),
        };
        writeln!(output, "\n{reply}")?;
        output.flush()?;
    }
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
