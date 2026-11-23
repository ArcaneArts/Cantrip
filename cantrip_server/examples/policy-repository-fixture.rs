//! Disposable IPC adapter of native policy persistence, never a production route.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository,
    database::Database,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    policies::{
        self,
        repository::{PolicyConflict, PolicyRepository, PolicyScopeNotFound},
    },
};
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
async fn operation(repo: &PolicyRepository, r: &Value) -> Result<Value> {
    Ok(match text(r, "op")? {
        "sql" => {
            repo.database.execute(text(r, "sql")?).await?;
            Value::Null
        }
        "query-json" => repo
            .database
            .query(text(r, "sql")?, &[])
            .await?
            .first()
            .context("JSON query")?
            .get(0)?,
        "templates" => policies::templates(),
        "template" => policies::template(text(r, "key")?).unwrap_or(Value::Null),
        "list" => repo.list(text(r, "owner")?).await?,
        "get" => repo
            .get(text(r, "owner")?, text(r, "policy")?)
            .await?
            .unwrap_or(Value::Null),
        "bootstrap" => repo.bootstrap(text(r, "owner")?, &r["input"]).await?,
        "create" => repo.create(text(r, "owner")?, &r["input"]).await?,
        "update" => repo
            .update(text(r, "owner")?, text(r, "policy")?, &r["input"])
            .await?
            .unwrap_or(Value::Null),
        "delete" => json!(
            repo.delete(
                text(r, "owner")?,
                text(r, "policy")?,
                r["version"].as_i64().context("version")?
            )
            .await?
        ),
        "order" => repo.reorder(text(r, "owner")?, &r["input"]).await?,
        "replace" => json!(
            repo.replace_assignments(
                text(r, "owner")?,
                r["workspace"] == true,
                text(r, "scope")?,
                &r["input"]
            )
            .await?
        ),
        "assignments" => repo
            .list_assignments(text(r, "owner")?, r["workspace"] == true, text(r, "scope")?)
            .await?
            .unwrap_or(Value::Null),
        "effective" => repo
            .resolve_effective(text(r, "owner")?, text(r, "project")?)
            .await?
            .unwrap_or(Value::Null),
        "standalone" => repo.resolve_standalone(text(r, "owner")?).await?,
        _ => anyhow::bail!("Unknown policy fixture operation"),
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
    let repo = PolicyRepository::new(database.clone());
    writeln!(
        output,
        "\n{}",
        json!({"event":"server.listening","origin":"policy-repository-fixture"})
    )?;
    output.flush()?;
    for line in io::BufReader::new(input).lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let result = operation(&repo, &request).await;
        let mut reply = json!({"id":request["id"],"rejected":result.is_err()});
        match result {
            Ok(value) => reply["value"] = value,
            Err(error) => {
                reply["diagnostic"] = json!(error.to_string());
                if let Some(conflict) = error.downcast_ref::<PolicyConflict>() {
                    reply["code"] = json!(conflict.code);
                } else if error.is::<PolicyScopeNotFound>() {
                    reply["code"] = json!("scope-not-found");
                }
            }
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
