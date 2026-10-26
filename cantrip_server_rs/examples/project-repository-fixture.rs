//! Development-only disposable repository driver; never a distribution target.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate, projects::repository::ProjectRepository, wire::Value,
};
use clap::Parser;
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
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let root = PathBuf::from(std::env::var("CANTRIP_DATA_DIR")?);
    // Match the production launcher: native PostgreSQL redirects process stdio
    // during single-user startup, so retain the fixture's actual IPC pipes.
    let input = os_pipe::dup_stdin()?;
    let mut output = os_pipe::dup_stdout()?;
    let mut managed = None;
    eprintln!("project-fixture opening {}", arguments.database);
    let database = Arc::new(match arguments.database.as_str() {
        "pglite" => Database::pglite(&root.join("server-db")).await?,
        "postgres" => Database::postgres(&std::env::var("DATABASE_URL")?.parse()?).await?,
        "bundled-postgres" => {
            let runtime = ManagedPostgres::start(
                &root.join("postgres"),
                &PathBuf::from(std::env::var("CANTRIP_POSTGRES_BIN_DIR")?),
            )
            .await?;
            let database = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            database
        }
        _ => anyhow::bail!("Unknown fixture database"),
    });
    eprintln!("project-fixture database opened");
    migrate(&database).await?;
    eprintln!("project-fixture migrated");
    AuthRepository::new(database.clone()).local_user().await?;
    eprintln!("project-fixture identity ready");
    let repository = ProjectRepository::new(database.clone())?;
    let live = cantrip_server::live::repository::LiveRepository::new(database.clone())?;
    eprintln!("project-fixture repository ready");
    writeln!(
        output,
        "\n{}",
        serde_json::json!({"event":"server.listening","origin":"repository-fixture","locale":sys_locale::get_locale()})
    )?;
    output.flush()?;
    for line in io::BufReader::new(input).lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let outcome: Result<Value> = async {
            if request["op"] == "sql" {
                database
                    .execute(request["sql"].as_str().context("Fixture SQL")?)
                    .await?;
                Ok(Value::Null)
            } else if request["op"] == "transaction" {
                let statements = request["statements"]
                    .as_array()
                    .context("Fixture transaction statements")?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .context("Fixture statement")
                            .map(str::to_owned)
                    })
                    .collect::<Result<Vec<_>>>()?;
                database
                    .transaction(|transaction| {
                        Box::pin(async move {
                            for statement in statements {
                                transaction.execute(&statement).await?;
                            }
                            Ok(())
                        })
                    })
                    .await?;
                Ok(Value::Null)
            } else if request["op"] == "scope" {
                Ok(Value::Bool(
                    live.authorize(
                        request["owner"].as_str().context("Scope owner")?,
                        &request["scope"],
                    )
                    .await?,
                ))
            } else if request["op"] == "session-active" {
                Ok(Value::Bool(
                    live.session_active(
                        request["session"].as_str().context("Session identity")?,
                        request["owner"].as_str().context("Session owner")?,
                    )
                    .await?,
                ))
            } else {
                Ok(Value::Array(
                    repository
                        .list(request["owner"].as_str().context("Fixture owner")?)
                        .await?,
                ))
            }
        }
        .await;
        let mut reply: Value = serde_json::from_value(
            serde_json::json!({"id":request["id"],"rejected":outcome.is_err()}),
        )?;
        match outcome {
            Ok(value) => reply["value"] = value,
            Err(error) => reply["diagnostic"] = Value::String(error.to_string().into()),
        };
        writeln!(output, "\n{}", reply.stringify())?;
        output.flush()?;
    }
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
