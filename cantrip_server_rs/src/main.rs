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

// Fixed stage names locate a stalled drain without exposing owner data or
// changing admission, cancellation, shutdown ordering, or timeout semantics.
macro_rules! shutdown_step {
    ($stage:literal, $operation:expr) => {{
        let started = std::time::Instant::now();
        eprintln!("{}", json!({"event":"server.shutdown.stage","stage":$stage,"phase":"started"}));
        let result = $operation;
        eprintln!("{}", json!({"event":"server.shutdown.stage","stage":$stage,"phase":"completed","durationMs":started.elapsed().as_millis()}));
        result
    }};
}

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
    /// Save the selected database connection privately after successful setup.
    #[arg(long, requires = "migrate_only", conflicts_with = "export_sql")]
    remember_database: bool,
    /// Export SQL and opaque server-profile files to a new directory.
    #[arg(long, requires="migrate_only", group="native_export", conflicts_with_all=["restore_sql","restore_profile","export_sql","remember_database"])]
    export_profile: Option<PathBuf>,
    /// Restore a trusted logical profile into a new, atomically published directory.
    #[arg(long, requires="migrate_only", conflicts_with_all=["restore_sql","export_sql","export_profile","remember_database","pack_profile"])]
    restore_profile: Option<PathBuf>,
    /// Package stopped legacy-profile files with an already exported SQL file.
    #[arg(long, requires_all=["export_profile","profile_sql"], conflicts_with_all=["restore_sql","export_sql","restore_profile","remember_database"])]
    pack_profile: Option<PathBuf>,
    #[arg(long, requires = "pack_profile")]
    profile_sql: Option<PathBuf>,
    #[arg(long, hide=true, requires_all=["data_dir","migrate_only"], conflicts_with_all=["restore_profile","export_profile","restore_sql","export_sql","pack_profile","remember_database"])]
    materialize_profile: Option<PathBuf>,
    #[arg(long, hide=true, requires_all=["data_dir","migrate_only"], conflicts_with_all=["materialize_profile","restore_profile","export_profile","restore_sql","export_sql","pack_profile","remember_database"])]
    publish_profile: Option<PathBuf>,
    /// Restore trusted INSERT-format pg_dump SQL and pending migrations, then exit.
    #[arg(long, requires = "migrate_only")]
    restore_sql: Option<PathBuf>,
    /// Export the selected database without migrations or identity writes, then exit.
    #[arg(long, requires = "migrate_only", group="native_export", conflicts_with_all = ["restore_sql","restore_profile","export_profile","pack_profile","remember_database"])]
    export_sql: Option<PathBuf>,
    /// Native pg_dump executable; otherwise use PostgreSQL's bin directory or PATH.
    #[arg(long, requires = "native_export")]
    pg_dump_path: Option<PathBuf>,
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
    if cantrip_server::managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
    let arguments = Arguments::parse();
    if let Some(root) = &arguments.materialize_profile {
        let receipt = cantrip_server::profile::Bundle::open(root)?
            .stage(
                arguments
                    .data_dir
                    .as_ref()
                    .context("materialized profile destination")?,
            )?
            .materialize()?;
        println!(
            "{}",
            json!({"event":"profile.materialized","receipt":receipt})
        );
        return Ok(());
    }
    if let Some(root) = &arguments.publish_profile {
        cantrip_server::profile::publish_directory(
            root,
            arguments
                .data_dir
                .as_ref()
                .context("converted profile destination")?,
        )?;
        println!("{}", json!({"event":"profile.directory.published"}));
        return Ok(());
    }
    if let Some(source) = &arguments.pack_profile {
        let receipt = cantrip_server::profile::pack_profile(
            &std::path::absolute(source)?,
            &std::path::absolute(
                arguments
                    .profile_sql
                    .as_ref()
                    .context("logical profile SQL")?,
            )?,
            arguments.database.unwrap_or(DatabaseMode::Pglite),
            &std::path::absolute(
                arguments
                    .export_profile
                    .as_ref()
                    .context("profile bundle destination")?,
            )?,
        )?;
        println!(
            "{}",
            json!({"event":"profile.export.completed","receipt":receipt})
        );
        return Ok(());
    }
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
    let cwd = std::env::current_dir()?;
    let bundle = arguments
        .restore_profile
        .as_ref()
        .map(|root| cantrip_server::profile::Bundle::open(root))
        .transpose()?;
    if let Some(bundle) = &bundle {
        bundle.apply_database_defaults(&mut environment);
    } else {
        cantrip_server::profile::apply_database(&mut environment, &cwd)?;
    }
    let mut config = ServerConfig::read(&environment, &cwd)?;
    let profile_stage = bundle
        .map(|bundle| bundle.stage(&config.data_directory))
        .transpose()?;
    if let Some(stage) = &profile_stage {
        config.data_directory = stage.data_directory().to_owned();
    }
    let config = Arc::new(config);
    let restore_sql = arguments
        .restore_sql
        .map(std::path::absolute)
        .transpose()
        .context("resolve SQL export path")?;
    let restoring = restore_sql.is_some() || profile_stage.is_some();
    let export_profile = arguments
        .export_profile
        .map(std::path::absolute)
        .transpose()?;
    let export_sql = arguments
        .export_sql
        .map(std::path::absolute)
        .transpose()
        .context("resolve SQL export destination")?;
    let pg_dump = arguments
        .pg_dump_path
        .map(std::path::absolute)
        .transpose()
        .context("resolve native pg_dump path")?
        .or_else(|| {
            config
                .postgres_bin_directory
                .as_ref()
                .map(|directory| directory.join(format!("pg_dump{}", std::env::consts::EXE_SUFFIX)))
        })
        .unwrap_or_else(|| PathBuf::from("pg_dump"));
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
    let mut profile_database = None;
    let prepared: Result<()> = async {
        if let Some(file) = export_profile {
            let receipt = cantrip_server::profile::export_profile(
                &database, &config, &file, &pg_dump,
            ).await?;
            use std::io::Write;
            writeln!(
                parent_output, "\n{}",
                json!({"event":"profile.export.completed","receipt":receipt})
            )?;
            return Ok(());
        }
        if let Some(file) = export_sql {
            let receipt = cantrip_server::database_transfer::export_sql(&database, &file, &pg_dump).await?;
            use std::io::Write;
            writeln!(parent_output,"\n{}",json!({"event":"database.export.completed","databaseEngine":database.engine(),"receipt":receipt}))?;
            return Ok(());
        }
        if let Some(file) = restore_sql {
            let receipt = cantrip_server::database_transfer::restore_sql(&database, &file).await?;
            use std::io::Write;
            writeln!(
                parent_output,
                "\n{}",
                json!({"event":"database.restore.completed","databaseEngine":database.engine(),"receipt":receipt})
            )?;
        }
        if let Some(stage) = &profile_stage {
            profile_database = Some(stage.restore(&database).await?);
        }
        migrate(&database).await?;
        if arguments.migrate_only && !restoring {
            AuthRepository::new(database.clone()).local_user().await?;
        }
        if arguments.remember_database {
            cantrip_server::profile::remember_database(&config)?;
        }
        Ok(())
    }.await;
    if let Err(error) = prepared {
        // A failed offline load must finish closing its private postmaster
        // before returning. Parent-death cleanup alone races an immediate retry.
        let database_closed = database.close().await;
        let owned_closed = if let Some(runtime) = managed.take() {
            runtime.close().await
        } else {
            Ok(())
        };
        if profile_stage.is_some() {
            std::env::set_current_dir(&cwd)?;
        }
        database_closed.context("close database after setup failure")?;
        owned_closed.context("close owned PostgreSQL after setup failure")?;
        return Err(error);
    }
    if !arguments.migrate_only {
        let service = AuthService::initialize(database.clone(), config.clone()).await?;
        let port = arguments.port.unwrap_or(config.port as u16);
        let listener = tokio::net::TcpListener::bind((config.host.as_str(), port)).await?;
        service.usage.start();
        service.logical_completion_delivery.start();
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
            eprintln!("{}", json!({"event":"server.shutdown.started"}));
            shutdown_service.live.transports.pre_close();
            shutdown_service.workers.pre_close();
        })
        .await?;
        // Pre-close interrupts sockets with their normal disconnect semantics.
        // Finish active HTTP requests before permanently closing the bridge,
        // disabling publications, or draining service/database owners.
        service.logical_completion_delivery.stop();
        service.folder_setup.stop();
        service.project_replicas.stop();
        service.github_conversion.stop();
        service.workspace_discovery.stop();
        service.scratch_roots.stop();
        service.worker_maintenance.stop();
        service.tunnel_leases.stop();
        shutdown_step!(
            "project-operations",
            service.project_operations.drain().await
        );
        service.worktree_observations.stop();
        service.run_configuration_observations.stop();
        shutdown_step!("project-shares", service.project_shares.close().await);
        service.tunnel_runtime.close();
        service.live.close();
        shutdown_step!(
            "direct-attachments-close",
            service.direct_attachments.close().await
        );
        shutdown_step!("worker-links-close", service.worker_links.close().await);
        shutdown_step!("worker-bridge-close", service.workers.close());
        shutdown_step!(
            "logical-completions",
            service.logical_completion_delivery.drained().await
        );
        // Observation commands are background work, and may still be awaiting
        // a worker's normal reconnect grace after socket pre-close. As in the
        // reference shutdown, close the bridge before waiting for those
        // commands. Keep their owned persistence tasks and the database alive.
        shutdown_step!(
            "worktree-observations",
            service.worktree_observations.drained().await
        );
        shutdown_step!(
            "run-observations",
            service.run_configuration_observations.drained().await
        );
        shutdown_step!("live-transports", service.live.transports.drained().await);
        // A socket callback can admit an owned account task. Finish socket
        // handlers before the final account/catalog drain, then finish any
        // commands those tasks admitted before closing their database.
        shutdown_step!("worker-handshakes", service.workers.drained().await?);
        shutdown_step!(
            "worker-link-callbacks",
            service.worker_links.local.drained().await
        );
        shutdown_step!(
            "provider-accounts",
            service.provider_accounts.drained().await
        );
        for _error in shutdown_step!("provider-catalogs", service.provider_catalogs.drain().await) {
            eprintln!(
                "{}",
                json!({"level":"warn","event":"provider.catalog.background-persistence-failed","message":"Provider catalog background persistence failed during shutdown"})
            );
        }
        shutdown_step!("worker-commands", service.workers.commands.drained().await);
        shutdown_step!(
            "direct-attachments-drain",
            service.direct_attachments.drained().await
        );
        shutdown_step!("tunnel-leases", service.tunnel_leases.drained().await);
        shutdown_step!("tunnel-runtime", service.tunnel_runtime.drained().await);
        shutdown_step!("folder-jobs", service.folder_setup.drained().await);
        shutdown_step!("scratch-root-jobs", service.scratch_roots.drained().await);
        shutdown_step!("replica-jobs", service.project_replicas.drained().await);
        shutdown_step!(
            "github-conversion-jobs",
            service.github_conversion.drained().await
        );
        shutdown_step!(
            "workspace-discovery-jobs",
            service.workspace_discovery.drained().await
        );
        shutdown_step!(
            "worker-maintenance",
            service.worker_maintenance.drained().await
        );
        shutdown_step!("mutation-audits", service.mutation_audits.drained().await);
        shutdown_step!("usage", service.usage.close().await);
    }
    shutdown_step!("database", database.close().await?);
    if let Some(runtime) = managed {
        shutdown_step!("private-postgres", runtime.close().await?);
    }
    if let Some(stage) = profile_stage {
        // Windows holds the current directory open even after the native
        // embedded database closes. Release it before publishing the profile.
        std::env::set_current_dir(&cwd)?;
        let receipt = stage.publish(
            &config,
            profile_database.context("restored profile database receipt")?,
        )?;
        use std::io::Write;
        writeln!(
            parent_output,
            "\n{}",
            json!({"event":"profile.restore.completed","receipt":receipt})
        )?;
    }
    Ok(())
}
