mod postgres;
mod postgres_url;

use std::{future::Future, path::Path, pin::Pin};

use anyhow::{Context, Result};
use postgres_native_tls::MakeTlsConnector;
use postgres_types::{FromSql, ToSql};
use tokio::sync::{Mutex, broadcast};

pub type Parameters<'a> = &'a [&'a (dyn ToSql + Sync)];
pub type TransactionFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

enum Backend {
    Pglite(Mutex<Option<pglite::PGlite>>),
    Postgres(Box<postgres::Postgres>),
}

/// PGlite retains its single-session execution model. PostgreSQL leases request
/// connections independently and dedicates a separate connection to LISTEN.
pub struct Database {
    backend: Backend,
    engine: &'static str,
    notifications: broadcast::Sender<(String, String)>,
}

pub enum Row {
    Pglite(pglite::Row),
    Postgres(tokio_postgres::Row),
}

impl Row {
    pub fn get<'a, T: FromSql<'a>>(&'a self, column: usize) -> Result<T> {
        match self {
            Self::Pglite(row) => Ok(row.get(column)?),
            Self::Postgres(row) => Ok(row.try_get(column)?),
        }
    }
}

pub enum Transaction<'a> {
    Pglite(pglite::Transaction<'a>),
    Postgres(tokio_postgres::Transaction<'a>),
}

impl Transaction<'_> {
    pub async fn execute(&self, sql: &str) -> Result<()> {
        match self {
            Self::Pglite(transaction) => transaction.exec(sql).await?,
            Self::Postgres(transaction) => transaction.batch_execute(sql).await?,
        }
        Ok(())
    }

    pub async fn query(&self, sql: &str, parameters: Parameters<'_>) -> Result<Vec<Row>> {
        Ok(match self {
            Self::Pglite(transaction) => transaction
                .query(sql, parameters)
                .await?
                .into_iter()
                .map(Row::Pglite)
                .collect(),
            Self::Postgres(transaction) => transaction
                .query(sql, parameters)
                .await?
                .into_iter()
                .map(Row::Postgres)
                .collect(),
        })
    }

    async fn commit(self) -> Result<()> {
        match self {
            Self::Pglite(transaction) => transaction.commit().await?,
            Self::Postgres(transaction) => transaction.commit().await?,
        }
        Ok(())
    }

    async fn rollback(self) -> Result<()> {
        match self {
            Self::Pglite(transaction) => transaction.rollback().await?,
            Self::Postgres(transaction) => transaction.rollback().await?,
        }
        Ok(())
    }
}

impl Database {
    pub async fn pglite(directory: &Path) -> Result<Self> {
        // Resolve the host before the native engine changes TZ/PGTZ/LANG.
        let timezone = crate::environment::pglite_default_timezone()?;
        // This chooses an initial setting; it never prevents the real open.
        // Existing cluster settings must survive restart and host-zone changes.
        let initialized = directory.join("PG_VERSION").is_file();
        let database = pglite::PGlite::open_with(
            directory,
            pglite::PGliteOptions {
                // Return database errors to the caller without printing SQL or
                // user values through PostgreSQL's process-global stderr logger.
                start_params: vec![
                    "log_min_messages=fatal".into(),
                    "log_min_error_statement=panic".into(),
                    "log_error_verbosity=terse".into(),
                ],
                ..Default::default()
            },
        )
        .await
        .context("open native PGlite")?;
        if !initialized {
            database
                .exec(&format!("ALTER SYSTEM SET TimeZone='{timezone}'"))
                .await?;
            database
                .query("SELECT set_config('TimeZone',$1,false)", &[&timezone])
                .await?;
        }
        Ok(Self {
            backend: Backend::Pglite(Mutex::new(Some(database))),
            engine: "pglite",
            notifications: broadcast::channel(256).0,
        })
    }

    pub async fn postgres(configuration: &tokio_postgres::Config) -> Result<Self> {
        let connector = MakeTlsConnector::new(native_tls::TlsConnector::builder().build()?);
        Self::postgres_with_tls(configuration.clone(), connector).await
    }

    pub async fn postgres_url(url: &str) -> Result<Self> {
        let (configuration, connector) = postgres_url::parse(url)?;
        Self::postgres_with_tls(configuration, connector).await
    }

    async fn postgres_with_tls(
        configuration: tokio_postgres::Config,
        connector: MakeTlsConnector,
    ) -> Result<Self> {
        let notifications = broadcast::channel(256).0;
        let database =
            postgres::Postgres::open(configuration, connector, notifications.clone()).await?;
        Ok(Self {
            backend: Backend::Postgres(Box::new(database)),
            engine: "postgres",
            notifications,
        })
    }

    pub fn engine(&self) -> &'static str {
        self.engine
    }

    pub async fn execute(&self, sql: &str) -> Result<()> {
        match &self.backend {
            Backend::Pglite(database) => {
                database
                    .lock()
                    .await
                    .as_ref()
                    .context("database is closed")?
                    .exec(sql)
                    .await?
            }
            Backend::Postgres(database) => database.execute(sql).await?,
        }
        Ok(())
    }

    pub async fn query(&self, sql: &str, parameters: Parameters<'_>) -> Result<Vec<Row>> {
        Ok(match &self.backend {
            Backend::Pglite(database) => database
                .lock()
                .await
                .as_ref()
                .context("database is closed")?
                .query(sql, parameters)
                .await?
                .into_iter()
                .map(Row::Pglite)
                .collect(),
            Backend::Postgres(database) => database.query(sql, parameters).await?,
        })
    }

    /// PostgreSQL's reference driver supplies explicit types for some values
    /// passed through unvalidated legacy routes. Embedded PGlite instead uses
    /// the statement's inferred types; its caller executes the ordinary query.
    pub(crate) async fn query_postgres_typed(
        &self,
        sql: &str,
        parameters: &[(&(dyn ToSql + Sync), postgres_types::Type)],
    ) -> Result<Option<Vec<Row>>> {
        match &self.backend {
            Backend::Postgres(database) => database.query_typed(sql, parameters).await.map(Some),
            Backend::Pglite(_) => Ok(None),
        }
    }

    pub async fn listen(&self, channel: &str) -> Result<broadcast::Receiver<(String, String)>> {
        let receiver = self.notifications.subscribe();
        match &self.backend {
            Backend::Pglite(database) => {
                let emitter = self.notifications.clone();
                let channel_name = channel.to_owned();
                database
                    .lock()
                    .await
                    .as_ref()
                    .context("database is closed")?
                    .listen(channel, move |payload| {
                        let _ = emitter.send((channel_name.clone(), payload.to_owned()));
                    })
                    .await?;
            }
            Backend::Postgres(database) => database.listen(channel).await?,
        }
        Ok(receiver)
    }

    pub async fn transaction<T>(
        &self,
        operation: impl for<'a, 'b> FnOnce(&'a Transaction<'b>) -> TransactionFuture<'a, T>,
    ) -> Result<T> {
        let database = match &self.backend {
            Backend::Pglite(database) => database,
            Backend::Postgres(database) => return database.transaction(operation).await,
        };
        let mut database = database.lock().await;
        let transaction = Transaction::Pglite(
            database
                .as_mut()
                .context("database is closed")?
                .transaction()
                .await?,
        );
        match operation(&transaction).await {
            Ok(result) => {
                transaction.commit().await?;
                Ok(result)
            }
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .context("roll back failed transaction")?;
                Err(error)
            }
        }
    }

    pub async fn close(&self) -> Result<()> {
        match &self.backend {
            Backend::Pglite(database) => {
                let mut database = database.lock().await;
                if let Some(database) = database.take() {
                    database.close().await?;
                }
            }
            Backend::Postgres(database) => database.close().await?,
        }
        Ok(())
    }
}
