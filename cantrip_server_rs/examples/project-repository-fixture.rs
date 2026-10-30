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
#[path = "support/file_documents.rs"]
mod file_documents;
#[path = "support/pane_layouts.rs"]
mod pane_layouts;
#[path = "support/project_surfaces.rs"]
mod project_surfaces;
#[path = "support/repository_operations.rs"]
mod repository_operations;
#[path = "support/run_configurations.rs"]
mod run_configurations;
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
                let result = chat_console::run(database.clone(), &request, console_trace.clone())
                    .boxed()
                    .await?;
                Ok(Value::object([
                    ("result", result),
                    ("trace", Value::Array(console_trace.lock().unwrap().clone())),
                ]))
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("tunnel-"))
            {
                tunnels::run(database.clone(), &request).boxed().await
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("browser-"))
            {
                browsers::run(database.clone(), &request).boxed().await
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("document-"))
            {
                file_documents::run(database.clone(), &request)
                    .boxed()
                    .await
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("layout-"))
            {
                pane_layouts::run(database.clone(), &request).boxed().await
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("workspace-"))
            {
                workspaces::run(database.clone(), &request).boxed().await
            } else if request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("project-surface-"))
            {
                project_surfaces::run(database.clone(), &request)
                    .boxed()
                    .await
            } else {
                repository_operations::run(
                    &database,
                    &request,
                    &repository,
                    &folders,
                    &placement,
                    &live,
                    &chats,
                )
                .await
            }
        }
        .boxed()
        .await;
        let mut reply: Value = serde_json::from_value(
            serde_json::json!({"id":request["id"],"rejected":outcome.is_err()}),
        )?;
        match outcome {
            Ok(value) => reply["value"] = value,
            Err(error) => {
                reply["diagnostic"] = Value::String(error.to_string().into());
                if request["op"].as_str().is_some_and(|op| {
                    op.starts_with("project-surface-")
                        || op.starts_with("tunnel-")
                        || op.starts_with("browser-")
                        || op.starts_with("document-")
                        || op.starts_with("workspace-")
                        || op.starts_with("layout-")
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
