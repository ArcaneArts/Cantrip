use std::{net::IpAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use cantrip_server::{
    database::Database, http, managed_postgres::ManagedPostgres, migrations::migrate,
};
use clap::{Parser, ValueEnum};
use serde_json::json;

#[derive(Clone, Copy, ValueEnum)]
enum DatabaseMode {
    Pglite,
    BundledPostgres,
    Postgres,
}

#[derive(Parser)]
#[command(about = "Cantrip Rust server (replacement implementation in progress)")]
struct Arguments {
    #[arg(long, env = "CANTRIP_SERVER_HOST", default_value = "127.0.0.1")]
    host: IpAddr,
    #[arg(long, env = "CANTRIP_SERVER_PORT", default_value_t = 4310)]
    port: u16,
    #[arg(long, env = "CANTRIP_DATA_DIR")]
    data_dir: PathBuf,
    #[arg(long, env = "CANTRIP_DATABASE_MODE")]
    database: Option<DatabaseMode>,
    #[arg(long, env = "DATABASE_URL", hide_env_values = true)]
    database_url: Option<String>,
    #[arg(long, env = "CANTRIP_POSTGRES_BIN_DIR")]
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
    // Native PostgreSQL changes its process stdio during single-user startup.
    // Keep independent handles to the launcher's pipes before initializing it.
    let mut parent_output = os_pipe::dup_stdout()?;
    let parent_input = if arguments.shutdown_on_stdin_close {
        Some(os_pipe::dup_stdin()?)
    } else {
        None
    };
    let mode = arguments
        .database
        .unwrap_or(if arguments.database_url.is_some() {
            DatabaseMode::Postgres
        } else {
            DatabaseMode::Pglite
        });
    let mut managed = None;
    let database = match mode {
        DatabaseMode::Pglite => {
            // Use the existing root name. The native engine must report actual
            // format errors; it must never select a fresh database as fallback.
            Database::pglite(&arguments.data_dir.join("server-db")).await?
        }
        DatabaseMode::Postgres => {
            let configuration = arguments
                .database_url
                .as_deref()
                .context("postgres mode requires DATABASE_URL or --database-url")?
                .parse()?;
            Database::postgres(&configuration).await?
        }
        DatabaseMode::BundledPostgres => {
            let bin = arguments.postgres_bin_dir.context("bundled-postgres mode requires --postgres-bin-dir until runtime packaging is integrated")?;
            let runtime =
                ManagedPostgres::start(&arguments.data_dir.join("postgres"), &bin).await?;
            let database = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            database
        }
    };
    let database = Arc::new(database);
    migrate(&database).await?;
    if !arguments.migrate_only {
        let listener = tokio::net::TcpListener::bind((arguments.host, arguments.port)).await?;
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
        axum::serve(listener, http::router(database.clone()))
            .with_graceful_shutdown(async move {
                tokio::select! { _=shutdown()=>{}, _=receiver, if watch_parent=>{} }
            })
            .await?;
    }
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
