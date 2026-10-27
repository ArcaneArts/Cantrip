use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use cantrip_server::{
    auth::{repository::AuthRepository, service::AuthService},
    config::{DatabaseMode, Environment, ServerConfig},
    database::Database,
    http,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
};
use clap::{Parser, ValueEnum};
use serde_json::json;

#[derive(Parser)]
#[command(about = "Cantrip Rust server (replacement implementation in progress)")]
struct Arguments {
    #[arg(long)]
    host: Option<String>,
    #[arg(long)]
    port: Option<u16>,
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    database: Option<DatabaseMode>,
    #[arg(long)]
    database_url: Option<String>,
    #[arg(long)]
    postgres_bin_dir: Option<PathBuf>,
    #[arg(long)]
    migrate_only: bool,
    #[arg(long)]
    shutdown_on_stdin_close: bool,
}

async fn shutdown() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let mut environment: Environment = std::env::vars().collect();
    if let Some(host) = arguments.host {
        environment.insert("CANTRIP_SERVER_HOST".into(), host);
    }
    if let Some(port) = arguments.port {
        // The explicit CLI port 0 is used by process tests for OS allocation.
        // Environment ports retain the existing server's 1..65535 contract.
        environment.insert(
            "CANTRIP_SERVER_PORT".into(),
            if port == 0 {
                "4310".into()
            } else {
                port.to_string()
            },
        );
    }
    for (name, value) in [
        ("CANTRIP_DATA_DIR", arguments.data_dir),
        ("CANTRIP_POSTGRES_BIN_DIR", arguments.postgres_bin_dir),
    ] {
        if let Some(value) = value {
            environment.insert(
                name.into(),
                value
                    .to_str()
                    .context("server paths must be valid UTF-8")?
                    .into(),
            );
        }
    }
    if let Some(mode) = arguments.database {
        environment.insert(
            "CANTRIP_DATABASE_MODE".into(),
            mode.to_possible_value().unwrap().get_name().into(),
        );
    }
    if let Some(url) = arguments.database_url {
        environment.insert("DATABASE_URL".into(), url);
    }
    // Resolve every path before native PostgreSQL can change the process cwd.
    let config = Arc::new(ServerConfig::read(&environment, &std::env::current_dir()?)?);
    // Native PostgreSQL changes its process stdio during single-user startup.
    // Keep independent handles to the launcher's pipes before initializing it.
    let mut parent_output = os_pipe::dup_stdout()?;
    let parent_input = if arguments.shutdown_on_stdin_close {
        Some(os_pipe::dup_stdin()?)
    } else {
        None
    };
    let mut managed = None;
    let database = match config.database_mode {
        DatabaseMode::Pglite => {
            // Use the existing root name. The native engine must report actual
            // format errors; it must never select a fresh database as fallback.
            Database::pglite(&config.data_directory.join("server-db")).await?
        }
        DatabaseMode::Postgres => {
            let url = config
                .database_url
                .as_deref()
                .context("postgres mode requires DATABASE_URL or --database-url")?;
            Database::postgres_url(url).await?
        }
        DatabaseMode::BundledPostgres => {
            let bin = config.postgres_bin_directory.as_ref().context("bundled-postgres mode requires --postgres-bin-dir until runtime packaging is integrated")?;
            let runtime =
                ManagedPostgres::start(&config.data_directory.join("postgres"), bin).await?;
            let database = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            database
        }
    };
    let database = Arc::new(database);
    migrate(&database).await?;
    if arguments.migrate_only {
        AuthRepository::new(database.clone()).local_user().await?;
    }
    if !arguments.migrate_only {
        let service = AuthService::initialize(database.clone(), config.clone()).await?;
        let port = arguments.port.unwrap_or(config.port as u16);
        let listener = tokio::net::TcpListener::bind((config.host.as_str(), port)).await?;
        use std::io::Write;
        writeln!(
            parent_output,
            "\n{}",
            json!({"event":"server.listening", "origin":format!("http://{}", listener.local_addr()?)})
        )?;
        let (closed, receiver) = tokio::sync::oneshot::channel::<()>();
        let watch_parent = arguments.shutdown_on_stdin_close;
        if let Some(mut parent_input) = parent_input {
            // A detached OS thread is intentional: unlike Tokio's blocking
            // stdin adapter it cannot hold runtime shutdown open after a signal.
            std::thread::spawn(move || {
                use std::io::Read;
                let mut bytes = [0_u8; 256];
                while parent_input.read(&mut bytes).is_ok_and(|count| count > 0) {}
                let _ = closed.send(());
            });
        }
        let shutdown_service = service.clone();
        axum::serve(
            listener,
            http::router(service.clone())
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            tokio::select! { _=shutdown()=>{}, _=receiver, if watch_parent=>{} }
            shutdown_service.live.transports.pre_close();
            shutdown_service.live.close();
            shutdown_service.workers.close();
        })
        .await?;
        service.live.transports.drained().await;
        service.workers.drained().await?;
    }
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
