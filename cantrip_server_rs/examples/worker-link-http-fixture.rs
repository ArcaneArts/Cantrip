//! Loopback-only WorkerLink HTTP facade qualification. The test replaces only
//! this dependency in a fresh AuthService; it does not qualify shared bootstrap.
use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use cantrip_server::{
    auth::service::AuthService,
    config::{DatabaseMode, Environment, ServerConfig},
    coordination::{Options, RedisCoordinator},
    database::Database,
    http,
    managed_postgres::{self, ManagedPostgres},
    migrations::migrate,
    worker_links::service::Service,
};
use clap::{Parser, ValueEnum};
use std::{
    io::{Read, Write},
    sync::Arc,
};
#[path = "support/worker_link_lookup_control.rs"]
mod lookup;
#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    database: DatabaseMode,
    #[arg(long)]
    shutdown_on_stdin_close: bool,
}
struct Control {
    coordinator: Arc<lookup::Controlled>,
    service: Arc<Service>,
}
async fn configure(
    State(c): State<Arc<Control>>,
    Json(v): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    c.coordinator.configure(
        v["session"].as_str().unwrap().into(),
        v["nth"].as_u64().unwrap() as usize,
        v["action"].as_str().unwrap().into(),
    );
    Json(c.coordinator.snapshot())
}
async fn release(State(c): State<Arc<Control>>) -> Json<serde_json::Value> {
    c.coordinator.release();
    Json(c.coordinator.snapshot())
}
async fn snapshot(State(c): State<Arc<Control>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"lookup":c.coordinator.snapshot(),"relay":c.service.relay.stats()}))
}
#[tokio::main]
async fn main() -> Result<()> {
    if managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
    let args = Arguments::parse();
    let mut parent_output = os_pipe::dup_stdout()?;
    let mut parent_input = os_pipe::dup_stdin()?;
    let mut env: Environment = std::env::vars().collect();
    env.insert(
        "CANTRIP_DATABASE_MODE".into(),
        args.database.to_possible_value().unwrap().get_name().into(),
    );
    let config = Arc::new(ServerConfig::read(&env, &std::env::current_dir()?)?);
    let mut managed = None;
    let database = Arc::new(match config.database_mode {
        DatabaseMode::Pglite => Database::pglite(&config.data_directory.join("server-db")).await?,
        DatabaseMode::Postgres => {
            Database::postgres_url(
                config
                    .database_url
                    .as_deref()
                    .context("Fixture DATABASE_URL")?,
            )
            .await?
        }
        DatabaseMode::BundledPostgres => {
            let runtime = ManagedPostgres::start(
                &config.data_directory.join("postgres"),
                config
                    .postgres_bin_directory
                    .as_deref()
                    .context("Fixture PostgreSQL binaries")?,
            )
            .await?;
            let database = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            database
        }
    });
    migrate(&database).await?;
    let mut options = Options::new(
        config
            .redis_url
            .clone()
            .context("Fixture private REDIS_URL")?,
        "http-rust".into(),
    );
    options.key_prefix = std::env::var("CANTRIP_WORKER_LINK_HTTP_NAMESPACE")?;
    let redis = RedisCoordinator::new(options)?;
    redis.start().await?;
    let controlled = lookup::Controlled::new(redis.clone());
    let mut service = AuthService::initialize(database.clone(), config.clone()).await?;
    service.worker_links.close().await?;
    let links = Service::with_coordination(
        service.server_id.clone(),
        &config,
        &service.workers,
        &service.usage,
        Some(controlled.clone()),
    );
    // Test-only dependency injection before the router or any request owns the
    // root. Other domains are deliberately outside this facade's claim.
    Arc::get_mut(&mut service)
        .context("Fresh HTTP fixture root ownership")?
        .worker_links = links.clone();
    let control = Arc::new(Control {
        coordinator: controlled.clone(),
        service: links,
    });
    let routes = Router::new()
        .route("/__worker_link_http/configure", post(configure))
        .route("/__worker_link_http/release", post(release))
        .route("/__worker_link_http/state", get(snapshot))
        .with_state(control);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await?;
    writeln!(
        parent_output,
        "\n{}",
        serde_json::json!({"event":"server.listening","origin":format!("http://{}",listener.local_addr()?)})
    )?;
    let (closed, closing) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut bytes = [0; 256];
        while parent_input.read(&mut bytes).is_ok_and(|n| n > 0) {}
        let _ = closed.send(());
    });
    let retained = service.clone();
    axum::serve(
        listener,
        http::router(service.clone())
            .merge(routes)
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        if args.shutdown_on_stdin_close {
            let _ = closing.await;
        } else {
            let _ = tokio::signal::ctrl_c().await;
        }
        controlled.release();
        retained.live.transports.pre_close();
        retained.live.close();
        retained
            .worker_links
            .close()
            .await
            .expect("Fixture WorkerLink shutdown");
        retained
            .workers
            .close()
            .await
            .expect("Fixture worker shutdown");
    })
    .await?;
    service.live.transports.drained().await;
    service.worker_links.drained().await;
    service.workers.drained().await?;
    service.usage.close().await;
    redis.close().await?;
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
