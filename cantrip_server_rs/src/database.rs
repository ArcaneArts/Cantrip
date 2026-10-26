use std::{future::Future, path::Path, pin::Pin};

use anyhow::{Context, Result};
use postgres_native_tls::MakeTlsConnector;
use postgres_types::{FromSql, ToSql};
use tokio::{
    sync::{Mutex, broadcast},
    task::JoinHandle,
};

pub type Parameters<'a> = &'a [&'a (dyn ToSql + Sync)];
pub type TransactionFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

enum Backend {
    Pglite(pglite::PGlite),
    Postgres(tokio_postgres::Client),
}

/// One serialized session initially matches PGlite's existing execution model.
/// PostgreSQL pooling can be introduced without changing repository contracts.
pub struct Database {
    backend: Mutex<Option<Backend>>,
    connection: Mutex<Option<JoinHandle<Result<()>>>>,
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
        Ok(Self {
            backend: Mutex::new(Some(Backend::Pglite(database))),
            connection: Mutex::new(None),
            engine: "pglite",
            notifications: broadcast::channel(256).0,
        })
    }

    pub async fn postgres(configuration: &tokio_postgres::Config) -> Result<Self> {
        let connector = MakeTlsConnector::new(native_tls::TlsConnector::builder().build()?);
        let (client, mut connection) = configuration
            .connect(connector)
            .await
            .context("connect to PostgreSQL")?;
        let notifications = broadcast::channel(256).0;
        let emitter = notifications.clone();
        let connection = tokio::spawn(async move {
            while let Some(message) =
                futures::future::poll_fn(|context| connection.poll_message(context)).await
            {
                if let tokio_postgres::AsyncMessage::Notification(notification) =
                    message.context("PostgreSQL connection stopped")?
                {
                    let _ = emitter.send((
                        notification.channel().to_owned(),
                        notification.payload().to_owned(),
                    ));
                }
            }
            Ok(())
        });
        Ok(Self {
            backend: Mutex::new(Some(Backend::Postgres(client))),
            connection: Mutex::new(Some(connection)),
            engine: "postgres",
            notifications,
        })
    }

    pub fn engine(&self) -> &'static str {
        self.engine
    }

    pub async fn execute(&self, sql: &str) -> Result<()> {
        match self
            .backend
            .lock()
            .await
            .as_ref()
            .context("database is closed")?
        {
            Backend::Pglite(database) => database.exec(sql).await?,
            Backend::Postgres(client) => client.batch_execute(sql).await?,
        }
        Ok(())
    }

    pub async fn query(&self, sql: &str, parameters: Parameters<'_>) -> Result<Vec<Row>> {
        Ok(
            match self
                .backend
                .lock()
                .await
                .as_ref()
                .context("database is closed")?
            {
                Backend::Pglite(database) => database
                    .query(sql, parameters)
                    .await?
                    .into_iter()
                    .map(Row::Pglite)
                    .collect(),
                Backend::Postgres(client) => client
                    .query(sql, parameters)
                    .await?
                    .into_iter()
                    .map(Row::Postgres)
                    .collect(),
            },
        )
    }

    pub async fn listen(&self, channel: &str) -> Result<broadcast::Receiver<(String, String)>> {
        let receiver = self.notifications.subscribe();
        match self
            .backend
            .lock()
            .await
            .as_ref()
            .context("database is closed")?
        {
            Backend::Pglite(database) => {
                let emitter = self.notifications.clone();
                let channel_name = channel.to_owned();
                database
                    .listen(channel, move |payload| {
                        let _ = emitter.send((channel_name.clone(), payload.to_owned()));
                    })
                    .await?;
            }
            Backend::Postgres(client) => {
                client
                    .batch_execute(&format!("LISTEN \"{}\"", channel.replace('"', "\"\"")))
                    .await?;
            }
        }
        Ok(receiver)
    }

    pub async fn transaction<T>(
        &self,
        operation: impl for<'a, 'b> FnOnce(&'a Transaction<'b>) -> TransactionFuture<'a, T>,
    ) -> Result<T> {
        let mut backend = self.backend.lock().await;
        let transaction = match backend.as_mut().context("database is closed")? {
            Backend::Pglite(database) => Transaction::Pglite(database.transaction().await?),
            Backend::Postgres(client) => Transaction::Postgres(client.transaction().await?),
        };
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
        match self.backend.lock().await.take() {
            Some(Backend::Pglite(database)) => database.close().await?,
            Some(Backend::Postgres(client)) => drop(client),
            None => return Ok(()),
        }
        if let Some(connection) = self.connection.lock().await.take() {
            connection.await??;
        }
        Ok(())
    }
}
