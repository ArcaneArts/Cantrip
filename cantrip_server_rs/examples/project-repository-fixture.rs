//! Development-only disposable repository driver; never a distribution target.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate, projects::repository::ProjectRepository, wire::Value,
};
use clap::Parser;
use futures::FutureExt;
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
    if cantrip_server::managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
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
    let folders = cantrip_server::projects::folders::FolderRepository::new(database.clone());
    let placement =
        cantrip_server::projects::placement::PlacementRepository::new(database.clone())?;
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
            } else if request["op"] == "query-json" {
                let query = request["sql"]
                    .as_str()
                    .context("Fixture query")?
                    .trim_end_matches(';');
                let rows = database
                    .query(
                        &format!("SELECT result::text FROM ({query}) observation"),
                        &[],
                    )
                    .await?;
                rows.first()
                    .map(|row| Ok(serde_json::from_str::<Value>(&row.get::<String>(0)?)?))
                    .transpose()
                    .map(|value| value.unwrap_or(Value::Null))
            } else if request["op"] == "terminal-services" {
                let maintenance =
                    cantrip_server::workers::maintenance::Repository::new(database.clone());
                Ok(Value::Array(
                    maintenance
                        .list(
                            request["worker"].as_str().context("Service worker")?,
                            request["server"].as_str().context("Service server")?,
                        )
                        .await?,
                ))
            } else if request["op"] == "terminal-status" {
                let maintenance =
                    cantrip_server::workers::maintenance::Repository::new(database.clone());
                maintenance
                    .set_status(
                        request["terminal"].as_str().context("Terminal identity")?,
                        request["status"].as_str().context("Terminal status")?,
                    )
                    .await?;
                Ok(Value::Null)
            } else if request["op"]
                .as_str()
                .is_some_and(|s| s.starts_with("folder-"))
            {
                folder_operation(&folders, &request).boxed().await
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
            } else if request["op"] == "target-resolve" {
                let connected = |worker: &str| {
                    request["connected"]
                        .as_array()
                        .is_some_and(|workers| workers.iter().any(|w| w == worker))
                };
                cantrip_server::projects::targets::TargetRepository::new(database.clone())
                    .resolve(
                        request["owner"].as_str().context("Fixture owner")?,
                        request["project"].as_str().context("Fixture project")?,
                        &request["target"],
                        request["connected"]
                            .as_array()
                            .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                        request["allowUnavailable"].as_bool().unwrap_or(false),
                    )
                    .await
            } else if request["op"] == "catalog-repository" {
                let connected = |worker: &str| {
                    request["connected"]
                        .as_array()
                        .is_some_and(|workers| workers.iter().any(|w| w == worker))
                };
                Ok(
                    cantrip_server::projects::targets::TargetRepository::new(database.clone())
                        .catalog(
                            request["owner"].as_str().context("Fixture owner")?,
                            request["project"].as_str().context("Fixture project")?,
                            request["connected"]
                                .as_array()
                                .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                        )
                        .await?
                        .unwrap_or(Value::Null),
                )
            } else if request["op"] == "target-catalog" {
                let connected = |worker: &str| {
                    request["connected"]
                        .as_array()
                        .is_some_and(|workers| workers.iter().any(|w| w == worker))
                };
                cantrip_server::projects::targets::catalog::build(
                    &request["input"],
                    request["connected"]
                        .as_array()
                        .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                )
            } else if request["op"] == "placement" {
                let connected = |worker: &str| {
                    request["connected"]
                        .as_array()
                        .is_some_and(|workers| workers.iter().any(|w| w == worker))
                };
                placement
                    .resolve(
                        request["owner"].as_str().context("Fixture owner")?,
                        request["project"].as_str().context("Fixture project")?,
                        request["surface"].as_str().context("Fixture surface")?,
                        request.get("target").filter(|v| !v.is_null()),
                        request["connected"]
                            .as_array()
                            .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                        request["allowOffline"].as_bool().unwrap_or(false),
                    )
                    .await
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
            Err(error) => {
                reply["diagnostic"] = Value::String(error.to_string().into());
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::projects::folders::FolderError>()
                {
                    use cantrip_server::projects::folders::FolderError;
                    reply["folderError"] = Value::String(
                        match error {
                            FolderError::Workspace(_) => "ProjectWorkspaceInvariantError",
                            FolderError::Stale(_) => "ProjectFolderSetupJobStaleAttemptError",
                            FolderError::Conflict(_) => "ProjectFolderSetupJobConflictError",
                        }
                        .into(),
                    );
                }
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::projects::placement::Unavailable>()
                {
                    reply["code"] = Value::String(error.code.into());
                }
            }
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

async fn folder_operation(
    repo: &cantrip_server::projects::folders::FolderRepository,
    input: &Value,
) -> Result<Value> {
    let key = |name: &str| {
        input[name]
            .as_js_string()
            .map(|s| s.lossy().into_owned())
            .with_context(|| format!("Fixture {name}"))
    };
    let value = match input["op"].as_str().context("Fixture operation")? {
        "folder-default" => Value::object([(
            "id",
            repo.ensure_default_workspace(&key("owner")?).await?["id"].clone(),
        )]),
        "folder-storage" => repo
            .workspace_storage(&key("owner")?, &key("project")?)
            .await?
            .unwrap_or(Value::Null),
        "folder-create" => repo.create(&key("owner")?, &input["input"]).await?,
        "folder-get" => repo
            .get(&key("owner")?, &key("project")?)
            .await?
            .unwrap_or(Value::Null),
        "folder-claim" => repo.claim_next().await?.unwrap_or(Value::Null),
        "folder-renew" => Value::Bool(
            repo.renew(
                &key("job")?,
                &key("command")?,
                input["attempt"].as_f64().context("Fixture attempt")?,
            )
            .await?,
        ),
        "folder-settle" => {
            repo.settle(
                &key("job")?,
                &key("command")?,
                &key("state")?,
                &input["error"],
            )
            .await?
        }
        "folder-complete" => {
            repo.complete(&key("job")?, &key("command")?, &input["input"])
                .await?
        }
        "folder-retry" => repo
            .retry(&key("owner")?, &key("project")?, &input["revision"])
            .await?
            .unwrap_or(Value::Null),
        "folder-requeue" => Value::Number(repo.requeue_worker(&key("worker")?).await? as f64),
        "folder-recover" => {
            let at = if let Some(at) = input["at"].as_str() {
                chrono::DateTime::parse_from_rfc3339(at)?.to_utc()
            } else {
                chrono::DateTime::from_timestamp_millis(chrono::Utc::now().timestamp_millis())
                    .unwrap()
            };
            Value::Number(
                repo.recover(input["force"].as_bool().unwrap_or(true), at)
                    .await? as f64,
            )
        }
        _ => anyhow::bail!("Unknown folder fixture operation"),
    };
    Ok(value)
}
