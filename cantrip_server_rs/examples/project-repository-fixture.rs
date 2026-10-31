//! Development-only disposable repository driver; never a distribution target.
use anyhow::{Context, Result};
use cantrip_server::{
    auth::repository::AuthRepository, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate, projects::repository::ProjectRepository, wire::Value,
};
use clap::Parser;
#[path = "support/agent_interactions.rs"]
mod agent_interactions;
#[path = "support/browsers.rs"]
mod browsers;
#[path = "support/chat_console.rs"]
mod chat_console;
#[path = "support/chat_forks.rs"]
mod chat_forks;
#[path = "support/chat_messages.rs"]
mod chat_messages;
#[path = "support/conversions.rs"]
mod conversions;
#[path = "support/discovery.rs"]
mod discovery;
#[path = "support/execution_lane_rest.rs"]
mod execution_lane_rest;
#[path = "support/execution_lanes.rs"]
mod execution_lanes;
#[path = "support/file_documents.rs"]
mod file_documents;
#[path = "support/managed_gui_finish.rs"]
mod managed_gui_finish;
#[path = "support/managed_queue.rs"]
mod managed_queue;
#[path = "support/native_commands.rs"]
mod native_commands;
#[path = "support/native_events.rs"]
mod native_events;
#[path = "support/native_history.rs"]
mod native_history;
#[path = "support/native_logical.rs"]
mod native_logical;
#[path = "support/native_settings.rs"]
mod native_settings;
#[path = "support/pane_layouts.rs"]
mod pane_layouts;
#[path = "support/project_surfaces.rs"]
mod project_surfaces;
#[path = "support/queue_delivery.rs"]
mod queue_delivery;
#[path = "support/queued_prompts.rs"]
mod queued_prompts;
#[path = "support/replicas.rs"]
mod replicas;
#[path = "support/repository_dispatch.rs"]
mod repository_dispatch;
#[path = "support/repository_operations.rs"]
mod repository_operations;
#[path = "support/run_configurations.rs"]
mod run_configurations;
#[path = "support/scratch_roots.rs"]
mod scratch_roots;
#[path = "support/tunnels.rs"]
mod tunnels;
#[path = "support/workspaces.rs"]
mod workspaces;
#[path = "support/worktree_coordinator.rs"]
mod worktree_coordinator;
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
fn main() -> Result<()> {
    if let Ok(bytes) = std::env::var("CANTRIP_FIXTURE_STACK_BYTES") {
        return std::thread::Builder::new()
            .name("repository-stack-probe".into())
            .stack_size(bytes.parse()?)
            .spawn(run)?
            .join()
            .map_err(|_| anyhow::anyhow!("Repository stack probe panicked"))?;
    }
    run()
}

#[tokio::main(flavor = "current_thread")]
async fn run() -> Result<()> {
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
    let dispatcher = repository_dispatch::Dispatcher {
        database: &database,
        repository: &repository,
        folders: &folders,
        placement: &placement,
        live: &live,
        chats: &chats,
    };
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
        let outcome = dispatcher.run(&request, console_trace.clone()).await;
        let mut reply: Value = serde_json::from_value(
            serde_json::json!({"id":request["id"],"rejected":outcome.is_err()}),
        )?;
        match outcome {
            Ok(value) => reply["value"] = value,
            Err(error) => {
                reply["diagnostic"] = Value::String(error.to_string().into());
                if error.is::<cantrip_server::agent_interactions::Conflict>() {
                    reply["interactionError"] =
                        Value::String("AgentInteractionConflictError".into());
                }
                if request["op"]
                    .as_str()
                    .is_some_and(|op| op.starts_with("native-command-lane-"))
                    && let Some(error) =
                        error.downcast_ref::<cantrip_server::chats::execution_lanes::LaneError>()
                {
                    reply["laneError"] = Value::String(error.class_name().into());
                }
                if request["op"]
                    .as_str()
                    .is_some_and(|op| op.starts_with("native-command-"))
                    && let Some(error) =
                        error.downcast_ref::<cantrip_server::native_commands::CommandError>()
                {
                    reply["commandError"] = Value::String(error.code.as_str().into());
                    reply["commandStatus"] = Value::from_serialize(&error.status);
                }
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::chats::message_writes::HistoryError>()
                {
                    reply["historyError"] = Value::String(error.code.into());
                    reply["historyStatus"] = Value::from_serialize(&error.status_code);
                }
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::native_history::BatchRejection>()
                {
                    reply["historyError"] = error.rejection["code"].clone();
                    reply["historyStatus"] = Value::from_serialize(&409);
                    reply["rejection"] = error.rejection.clone();
                }
                if request["op"]
                    .as_str()
                    .is_some_and(|op| op.starts_with("fork-"))
                {
                    reply["causes"] = Value::Array(
                        error
                            .chain()
                            .skip(1)
                            .map(|cause| Value::String(cause.to_string().into()))
                            .collect(),
                    );
                    reply["trace"] = Value::Array(console_trace.lock().unwrap().clone());
                    if error.is::<cantrip_server::chats::forks::Conflict>() {
                        reply["forkError"] = Value::String("ExecutionLaneConflictError".into());
                    }
                    if let Some(c) =
                        error.downcast_ref::<cantrip_server::chats::catalog::StatementFailure>()
                    {
                        reply["duplicateMessage"] = Value::Bool(c.duplicate_message);
                    }
                }
                if error.is::<cantrip_server::chats::catalog::StandaloneUnavailable>() {
                    reply["scratchError"] =
                        Value::String("StandaloneChatPlacementUnavailableError".into());
                }
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::chats::roots::RootJobError>()
                {
                    reply["scratchError"] = Value::String(
                        match error {
                            cantrip_server::chats::roots::RootJobError::Conflict(_) => {
                                "StandaloneChatRootJobConflictError"
                            }
                            cantrip_server::chats::roots::RootJobError::Stale(_) => {
                                "StandaloneChatRootJobStaleAttemptError"
                            }
                        }
                        .into(),
                    );
                }
                if error.is::<cantrip_server::projects::workspaces::WorkspaceInvariant>() {
                    reply["discoveryError"] =
                        Value::String("ProjectWorkspaceInvariantError".into());
                }
                if let Some(error) = error
                    .downcast_ref::<cantrip_server::projects::workspace_discovery::DiscoveryError>(
                ) {
                    use cantrip_server::projects::workspace_discovery::DiscoveryError;
                    reply["discoveryError"] = Value::String(
                        match error {
                            DiscoveryError::Invariant(_) => {
                                "WorkspaceRepositoryDiscoveryInvariantError"
                            }
                            DiscoveryError::Stale(_) => {
                                "WorkspaceRepositoryDiscoveryStaleAttemptError"
                            }
                            DiscoveryError::ImportStale(_) => {
                                "WorkspaceRepositoryImportStaleAttemptError"
                            }
                        }
                        .into(),
                    );
                }
                if let Some(error) = error
                    .downcast_ref::<cantrip_server::projects::github_conversion::ConversionError>(
                ) {
                    use cantrip_server::projects::github_conversion::ConversionError;
                    reply["conversionError"] = Value::String(
                        match error {
                            ConversionError::NotFound => "ProjectGithubConversionJobNotFoundError",
                            ConversionError::Conflict(_) => {
                                "ProjectGithubConversionJobConflictError"
                            }
                            ConversionError::Stale(_) => {
                                "ProjectGithubConversionJobStaleAttemptError"
                            }
                        }
                        .into(),
                    );
                }
                if let Some(error) =
                    error.downcast_ref::<cantrip_server::projects::replicas::ReplicaError>()
                {
                    use cantrip_server::projects::replicas::ReplicaError;
                    reply["replicaError"] = Value::String(
                        match error {
                            ReplicaError::Conflict(_) => "ProjectReplicaJobConflictError",
                            ReplicaError::NotFound(_) => "ProjectReplicaJobNotFoundError",
                            ReplicaError::Stale(_) => "ProjectReplicaJobStaleAttemptError",
                        }
                        .into(),
                    );
                }

                if request["op"].as_str().is_some_and(|op| {
                    op == "sql"
                        || op.starts_with("project-surface-")
                        || op.starts_with("discovery-")
                        || op.starts_with("tunnel-")
                        || op.starts_with("browser-")
                        || op.starts_with("document-")
                        || op.starts_with("workspace-")
                        || op.starts_with("layout-")
                        || op.starts_with("scratch-")
                        || op.starts_with("fork-")
                        || op.starts_with("message-")
                        || op.starts_with("native-command-")
                        || op.starts_with("native-history-")
                }) {
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
                if request["op"].as_str().is_some_and(|op| {
                    op.starts_with("project-surface-")
                        || op.starts_with("workspace-")
                        || op.starts_with("layout-")
                }) {
                    reply["errorName"] = Value::String(
                        error
                            .downcast_ref::<cantrip_server::workspace_layouts::ModelError>()
                            .map_or("Error", |e| e.name)
                            .into(),
                    );
                    if let Some(code) = error
                        .downcast_ref::<cantrip_server::workspace_layouts::ModelError>()
                        .and_then(|e| e.code)
                    {
                        reply["code"] = Value::String(code.into());
                    }
                    if error
                        .downcast_ref::<cantrip_server::workspace_layouts::LegacyInvariant>()
                        .is_some()
                    {
                        reply["statusCode"] = Value::Number(400.0);
                    }
                    if error.is::<cantrip_server::pane_layouts::Conflict>() {
                        reply["statusCode"] = Value::Number(409.0);
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
                if !request["op"]
                    .as_str()
                    .is_some_and(|op| op.starts_with("native-command-"))
                    && let Some(error) =
                        error.downcast_ref::<cantrip_server::chats::guard::NativeCommandError>()
                {
                    reply["code"] = Value::String(error.code.as_str().into());
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
