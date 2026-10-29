//! Development-only disposable repository driver; never a distribution target.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate, projects::repository::ProjectRepository, wire::Value,
};
use clap::Parser;
#[path = "support/browsers.rs"]
mod browsers;
#[path = "support/chat_console.rs"]
mod chat_console;
#[path = "support/tunnels.rs"]
mod tunnels;
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
    let chats = cantrip_server::chats::Repository::new(database.clone());
    eprintln!("project-fixture repository ready");
    writeln!(
        output,
        "\n{}",
        serde_json::json!({"event":"server.listening","origin":"repository-fixture","locale":sys_locale::get_locale()})
    )?;
    output.flush()?;
    for line in io::BufReader::new(input).lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let console_trace = Arc::new(std::sync::Mutex::new(Vec::new()));
        let outcome: Result<Value> = async {
            if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("console-"))
            {
                let result =
                    chat_console::run(database.clone(), &request, console_trace.clone()).await?;
                Ok(Value::object([
                    ("result", result),
                    ("trace", Value::Array(console_trace.lock().unwrap().clone())),
                ]))
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("tunnel-"))
            {
                tunnels::run(database.clone(), &request).await
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("browser-"))
            {
                browsers::run(database.clone(), &request).await
            } else if request["op"] == "sql" {
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
            } else if request["op"] == "surface-context" {
                Ok(
                    cantrip_server::remote_surfaces::Repository::new(database.clone())
                        .context(
                            request["owner"].as_str().context("Surface owner")?,
                            &request["surface"]
                                .as_js_string()
                                .context("Surface ID")?
                                .lossy(),
                        )
                        .await?
                        .unwrap_or(Value::Null),
                )
            } else if request["op"] == "surface-status" {
                let id = request["surface"]
                    .as_js_string()
                    .context("Surface ID")?
                    .lossy();
                let status = request["status"]
                    .as_js_string()
                    .context("Surface status")?
                    .lossy();
                let error = request["error"]
                    .as_js_string()
                    .map(|v| v.lossy().into_owned());
                cantrip_server::remote_surfaces::Repository::new(database.clone())
                    .set_status(&id, &status, error.as_deref())
                    .await?;
                Ok(Value::Null)
            } else if request["op"] == "surface-reset" {
                cantrip_server::remote_surfaces::Repository::new(database.clone())
                    .reset_transient()
                    .await?;
                Ok(Value::Null)
            } else if request["op"] == "surface-ensure-browsers" {
                cantrip_server::remote_surfaces::Repository::new(database.clone())
                    .ensure_browsers(request["owner"].as_str().context("Surface owner")?)
                    .await?;
                Ok(Value::Null)
            } else if request["op"] == "chat-context" {
                let chat = request["chat"]
                    .as_js_string()
                    .context("Chat identity")?
                    .lossy();
                Ok(chats
                    .execution_context(request["owner"].as_str().context("Chat owner")?, &chat)
                    .await?
                    .unwrap_or(Value::Null))
            } else if request["op"] == "mcp-effective" {
                Ok(Value::Array(
                    chats
                        .effective_mcp_servers(
                            request["owner"].as_str().context("MCP owner")?,
                            request.get("project").and_then(Value::as_str),
                            request["worker"].as_str().context("MCP worker")?,
                            request
                                .get("audience")
                                .and_then(Value::as_str)
                                .unwrap_or("ide"),
                        )
                        .await?,
                ))
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
                .is_some_and(|op| op.starts_with("terminal-"))
            {
                let repo = cantrip_server::terminals::Repository::new(database.clone());
                let owner = request["owner"].as_str().context("Terminal owner")?;
                let terminal = request["terminal"]
                    .as_js_string()
                    .map(|s| s.lossy().into_owned())
                    .unwrap_or_default();
                match request["op"].as_str().unwrap() {
                    "terminal-list" => Ok(Value::Array(
                        repo.list(
                            owner,
                            request["project"].as_str().context("Terminal project")?,
                        )
                        .await?,
                    )),
                    "terminal-context" => {
                        Ok(repo.context(owner, &terminal).await?.unwrap_or(Value::Null))
                    }
                    "terminal-update" => Ok(repo
                        .update(owner, &terminal, &request["input"])
                        .await?
                        .unwrap_or(Value::Null)),
                    "terminal-worktree" => Ok(repo
                        .update_worktree(owner, &terminal, &request["input"])
                        .await?
                        .unwrap_or(Value::Null)),
                    "terminal-delete" => {
                        Ok(repo.delete(owner, &terminal).await?.unwrap_or(Value::Null))
                    }
                    "terminal-service" => Ok(repo
                        .configure_service(owner, &terminal, &request["input"])
                        .await?
                        .unwrap_or(Value::Null)),
                    "terminal-create" => {
                        let connected = |id: &str| {
                            request["connected"]
                                .as_array()
                                .is_some_and(|v| v.iter().any(|v| v == id))
                        };
                        Ok(repo
                            .create(
                                owner,
                                request["project"].as_str().context("Terminal project")?,
                                &request["input"],
                                Some(&connected),
                            )
                            .await?
                            .unwrap_or(Value::Null))
                    }
                    _ => anyhow::bail!("Unknown terminal operation"),
                }
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
            } else if request["op"] == "chat-model" {
                let reasoning = request.get("reasoningEffort").map(|v| v.as_str());
                Ok(chats
                    .select_model(
                        request["owner"].as_str().context("Chat owner")?,
                        request["chat"].as_str().context("Chat identity")?,
                        request["model"].as_str().context("Model identity")?,
                        reasoning,
                    )
                    .await?
                    .unwrap_or(Value::Null))
            } else if request["op"] == "chat-runtime" {
                let nullable = |key| request.get(key).and_then(Value::as_str).map(str::to_owned);
                chats
                    .update_runtime(cantrip_server::chats::RuntimeUpdate {
                        chat: request["chat"].as_str().context("Runtime chat")?.into(),
                        worker: request["worker"].as_str().context("Runtime worker")?.into(),
                        worktree: nullable("worktree"),
                        thread: nullable("thread"),
                        route: request["route"].as_str().context("Runtime route")?.into(),
                        status: request
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("ready")
                            .into(),
                        provider_account: request
                            .get("providerAccountId")
                            .map(|v| v.as_str().map(str::to_owned)),
                        scratch_root: nullable("scratchRoot"),
                    })
                    .await?;
                Ok(Value::Null)
            } else if request["op"] == "chat-guard" {
                let request = request.clone();
                database
                    .transaction(move |tx| {
                        Box::pin(async move {
                            use cantrip_server::chats::guard::{self, Access};
                            let chat = request["chat"].as_str().context("Guard chat")?;
                            guard::lock_chat(
                                tx,
                                request["owner"].as_str().context("Guard owner")?,
                                chat,
                            )
                            .await?;
                            guard::assert_runtime_writable(
                                tx,
                                chat,
                                request.get("generation").and_then(Value::as_str),
                                request.get("epoch").and_then(Value::as_str),
                                if request["access"] == "attach" {
                                    Access::Attach
                                } else {
                                    Access::Write
                                },
                            )
                            .await?;
                            Ok(Value::Null)
                        })
                    })
                    .await
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
                if request["op"]
                    .as_str()
                    .is_some_and(|op| op.starts_with("tunnel-") || op.starts_with("browser-"))
                {
                    for cause in error.chain() {
                        if let Some(pg) = cause.downcast_ref::<tokio_postgres::Error>()
                            && let Some(code) = pg.code()
                        {
                            reply["databaseCode"] = Value::String(code.code().into());
                        }
                        if let Some(pglite::Error::Database { sqlstate, .. }) =
                            cause.downcast_ref::<pglite::Error>()
                        {
                            reply["databaseCode"] = Value::String(sqlstate.as_str().into());
                        }
                    }
                }
                if request["op"]
                    .as_str()
                    .is_some_and(|op| op.starts_with("console-"))
                {
                    reply["trace"] = Value::Array(console_trace.lock().unwrap().clone());
                    if let Some(failure) = error
                        .downcast_ref::<cantrip_server::settings::reasoning::ConfigurationFailure>(
                    ) {
                        reply["failure"] = failure.0.clone();
                    }
                }
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::chats::guard::NativeCommandError>()
                {
                    reply["code"] = Value::String(error.code.into());
                }
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
