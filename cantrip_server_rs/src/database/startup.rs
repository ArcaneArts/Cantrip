//! Serving startup, distinct from offline profile/export operations.
use super::Database;
use crate::{
    auth::service::{AuthService, PreparedDatabase},
    config::{DatabaseMode, ServerConfig},
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    operations::logging::{self, LogCall},
    wire::value::json,
};
use anyhow::{Context, Result};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

mod key;

pub struct Connected {
    pub database: Arc<Database>,
    pub prepared: PreparedDatabase,
    pub managed: Option<ManagedPostgres>,
}

fn emit(
    event: &'static str,
    message: &'static str,
    operation: &'static str,
    status: &'static str,
    engine: &str,
    elapsed: Option<Instant>,
    attempt: Option<usize>,
) {
    let mut context = json!({"event":event,"subsystem":"database","operation":operation,"status":status,"databaseEngine":engine});
    if let Some(started) = elapsed {
        context["durationMs"] = json!(started.elapsed().as_millis() as f64)
    }
    if let Some(attempt) = attempt {
        context["attempt"] = json!(attempt)
    }
    logging::server_logger()(LogCall::event("info", message, context));
}

async fn initialize(
    database: Arc<Database>,
    started: Instant,
    attempt: Option<usize>,
) -> Result<PreparedDatabase> {
    migrate(&database).await?;
    if database.engine() == "postgres" {
        // These are the actual serving subscriptions, retained by the shared
        // PostgreSQL listener. Consumers attach their receivers during service
        // composition; repeating LISTEN there is idempotent. An initial LISTEN
        // failure belongs to the connector's retry/cleanup boundary.
        for channel in [
            "cantrip_inference_resource_revocations",
            "cantrip_computer_use_authority",
            "cantrip_project_alerts",
        ] {
            drop(database.listen(channel).await?);
        }
    }
    let prepared = AuthService::prepare_database(database.clone()).await?;
    // Current Node legacy provider/account/MCP secret migration methods are
    // no-ops; SQL migration 0119 owns those data transitions.
    emit(
        "database.migrations.completed",
        if database.engine() == "pglite" {
            "PGlite migrations completed"
        } else {
            "PostgreSQL migrations completed"
        },
        "migrate",
        "completed",
        database.engine(),
        Some(started),
        attempt,
    );
    Ok(prepared)
}

pub async fn connect(config: &ServerConfig) -> Result<Connected> {
    let started = Instant::now();
    let engine = if config.database_mode == DatabaseMode::Pglite {
        "pglite"
    } else {
        "postgres"
    };
    emit(
        "database.connection.started",
        "Database connection began",
        "connect",
        "connecting",
        engine,
        None,
        None,
    );
    key::resolve(config)?;
    let mut managed = None;
    let (database, prepared) = if config.database_mode == DatabaseMode::Pglite {
        let attempt_started = Instant::now();
        let database = Arc::new(Database::pglite(&config.data_directory.join("server-db")).await?);
        match initialize(database.clone(), attempt_started, None).await {
            Ok(prepared) => (database, prepared),
            Err(error) => {
                database
                    .close()
                    .await
                    .context("close database after setup failure")?;
                return Err(error);
            }
        }
    } else {
        let (configuration, tls) = if config.database_mode == DatabaseMode::Postgres {
            super::postgres_url::parse(
                config
                    .database_url
                    .as_deref()
                    .context("postgres mode requires DATABASE_URL or --database-url")?,
            )?
        } else {
            let tls = postgres_native_tls::MakeTlsConnector::new(
                native_tls::TlsConnector::builder().build()?,
            );
            let bin=config.postgres_bin_directory.as_ref().context("bundled-postgres mode requires --postgres-bin-dir until runtime packaging is integrated")?;
            let runtime =
                ManagedPostgres::start(&config.data_directory.join("postgres"), bin).await?;
            let configuration = runtime.configuration().clone();
            managed = Some(runtime);
            (configuration, tls)
        };
        match postgres(configuration, tls).await {
            Ok(pair) => pair,
            Err(error) => {
                if let Some(runtime) = managed.take() {
                    runtime
                        .close()
                        .await
                        .context("close owned PostgreSQL after setup failure")?;
                }
                return Err(error);
            }
        }
    };
    emit(
        "database.connection.completed",
        "Database connection completed",
        "connect",
        "ready",
        database.engine(),
        Some(started),
        None,
    );
    Ok(Connected {
        database,
        prepared,
        managed,
    })
}

async fn postgres(
    configuration: tokio_postgres::Config,
    tls: postgres_native_tls::MakeTlsConnector,
) -> Result<(Arc<Database>, PreparedDatabase)> {
    let mut last_error = None;
    for attempt in 1..=30 {
        let started = Instant::now();
        let error = match Database::postgres_with_tls(configuration.clone(), tls.clone()).await {
            Ok(database) => {
                let database = Arc::new(database);
                match initialize(database.clone(), started, Some(attempt)).await {
                    Ok(prepared) => return Ok((database, prepared)),
                    Err(error) => {
                        database
                            .close()
                            .await
                            .context("close PostgreSQL after failed initialization")?;
                        error
                    }
                }
            }
            Err(error) => error,
        };
        last_error = Some(error);
        if attempt < 30 {
            logging::server_logger()(LogCall::repeated(
                "database-postgres-connect-retry".into(),
                "warn",
                "PostgreSQL connection attempt failed; retrying",
                json!({"event":"database.connection.retrying","subsystem":"database","operation":"connect","reasonCode":"connection-failed","status":"retrying","attempt":attempt}),
                Some(json!({"summaryEvery":5,"windowMs":30000})),
            ));
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    Err(last_error
        .unwrap()
        .context("Could not connect to PostgreSQL."))
}
