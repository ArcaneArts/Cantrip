mod listener;

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use deadpool::managed::{Manager, Metrics, Object, Pool, RecycleError, RecycleResult};
use postgres_native_tls::MakeTlsConnector;
use tokio::{
    sync::{OwnedRwLockReadGuard, RwLock, broadcast, watch},
    task::JoinHandle,
};
use tokio_postgres::{Client, Config};

use super::{Parameters, Row, Transaction, TransactionFuture};
use listener::Listener;

const REQUEST_CONNECTIONS: usize = 5;
const CANCEL_TIMEOUT: Duration = Duration::from_secs(2);
type Notifications = broadcast::Sender<(String, String)>;

// Construct this before spawning the driver: aborting a task before its first
// poll must still release its registered lifetime, without a lost wakeup.
struct DriverLifetime(watch::Sender<usize>);

impl Drop for DriverLifetime {
    fn drop(&mut self) {
        self.0.send_modify(|count| *count -= 1);
    }
}

struct Session {
    client: Client,
    driver: JoinHandle<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

#[derive(Clone)]
struct Factory {
    configuration: Config,
    tls: MakeTlsConnector,
    drivers: watch::Sender<usize>,
}

impl Factory {
    async fn connect(
        &self,
        notifications: Option<Notifications>,
    ) -> Result<Session, tokio_postgres::Error> {
        let (client, mut connection) = self.configuration.connect(self.tls.clone()).await?;
        self.drivers.send_modify(|count| *count += 1);
        let lifetime = DriverLifetime(self.drivers.clone());
        let driver = tokio::spawn(async move {
            let _lifetime = lifetime;
            while let Some(message) =
                std::future::poll_fn(|context| connection.poll_message(context)).await
            {
                match message {
                    Ok(tokio_postgres::AsyncMessage::Notification(notification)) => {
                        if let Some(emitter) = &notifications {
                            let _ = emitter.send((
                                notification.channel().to_owned(),
                                notification.payload().to_owned(),
                            ));
                        }
                    }
                    Err(_) => break,
                    _ => {}
                }
            }
        });
        Ok(Session { client, driver })
    }

    async fn cancel(&self, session: &Session) {
        // Closing a TCP driver alone can leave PostgreSQL waiting on a relation
        // lock. Send its actual CancelRequest before discarding the session.
        let _ = tokio::time::timeout(
            CANCEL_TIMEOUT,
            session.client.cancel_token().cancel_query(self.tls.clone()),
        )
        .await;
    }
}

impl Manager for Factory {
    type Type = Session;
    type Error = tokio_postgres::Error;

    async fn create(&self) -> Result<Session, Self::Error> {
        self.connect(None).await
    }

    async fn recycle(&self, session: &mut Session, _: &Metrics) -> RecycleResult<Self::Error> {
        if session.client.is_closed() {
            Err(RecycleError::message("PostgreSQL connection is closed"))
        } else {
            // The requested operation establishes whether the connection works.
            // Do not precede it with a health query or replay failed statements.
            Ok(())
        }
    }
}

struct Lease {
    object: Option<Object<Factory>>,
    factory: Factory,
    reusable: bool,
    admission: Option<OwnedRwLockReadGuard<()>>,
}

impl Lease {
    fn client(&self) -> &Client {
        &self.object.as_ref().unwrap().client
    }

    fn client_mut(&mut self) -> &mut Client {
        &mut self.object.as_mut().unwrap().client
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(object) = self.object.take() else {
            return;
        };
        if self.reusable {
            return;
        }
        let factory = self.factory.clone();
        let admission = self.admission.take();
        tokio::spawn(async move {
            let _admission = admission;
            // Keep the pool slot and shutdown admission until cleanup finishes.
            // Detaching first would allow unbounded cancellation connections.
            factory.cancel(&object).await;
            drop(Object::take(object));
        });
    }
}

pub(super) struct Postgres {
    pool: Pool<Factory>,
    factory: Factory,
    admission: Arc<RwLock<()>>,
    closing: AtomicBool,
    drivers: watch::Receiver<usize>,
    listener: Listener,
}

impl Postgres {
    pub(super) async fn open(
        configuration: Config,
        tls: MakeTlsConnector,
        notifications: Notifications,
    ) -> Result<Self> {
        let (drivers, receiver) = watch::channel(0);
        let factory = Factory {
            configuration,
            tls,
            drivers,
        };
        let pool = Pool::builder(factory.clone())
            .max_size(REQUEST_CONNECTIONS)
            .build()?;
        // Attempt the real connection now, retaining the existing startup error
        // boundary. Subsequent independent requests can create the other slots.
        drop(pool.get().await.context("connect to PostgreSQL")?);
        let listener = Listener::new(factory.clone(), notifications);
        Ok(Self {
            pool,
            factory,
            admission: Arc::new(RwLock::new(())),
            closing: AtomicBool::new(false),
            drivers: receiver,
            listener,
        })
    }

    async fn lease(&self) -> Result<Lease> {
        let admission = self.admission.clone().read_owned().await;
        ensure!(!self.closing.load(Ordering::Acquire), "database is closed");
        Ok(Lease {
            object: Some(self.pool.get().await?),
            factory: self.factory.clone(),
            reusable: false,
            admission: Some(admission),
        })
    }

    pub(super) async fn execute(&self, sql: &str) -> Result<()> {
        let mut lease = self.lease().await?;
        lease.client().batch_execute(sql).await?;
        lease.reusable = true;
        Ok(())
    }

    pub(super) async fn query(&self, sql: &str, parameters: Parameters<'_>) -> Result<Vec<Row>> {
        let mut lease = self.lease().await?;
        let rows = lease.client().query(sql, parameters).await?;
        lease.reusable = true;
        Ok(rows.into_iter().map(Row::Postgres).collect())
    }
    pub(super) async fn query_typed(
        &self,
        sql: &str,
        parameters: &[(&(dyn postgres_types::ToSql + Sync), postgres_types::Type)],
    ) -> Result<Vec<Row>> {
        let mut lease = self.lease().await?;
        let rows = lease.client().query_typed(sql, parameters).await?;
        lease.reusable = true;
        Ok(rows.into_iter().map(Row::Postgres).collect())
    }

    pub(super) async fn transaction<T>(
        &self,
        operation: impl for<'a, 'b> FnOnce(&'a Transaction<'b>) -> TransactionFuture<'a, T>,
    ) -> Result<T> {
        let mut lease = self.lease().await?;
        let transaction = Transaction::Postgres(lease.client_mut().transaction().await?);
        let result = match operation(&transaction).await {
            Ok(value) => {
                transaction.commit().await?;
                Ok(value)
            }
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .context("roll back failed transaction")?;
                Err(error)
            }
        };
        lease.reusable = true;
        result
    }

    pub(super) async fn listen(&self, channel: &str) -> Result<()> {
        ensure!(!self.closing.load(Ordering::Acquire), "database is closed");
        self.listener.listen(channel).await
    }

    pub(super) async fn close(&self) -> Result<()> {
        self.closing.store(true, Ordering::Release);
        self.pool.close();
        self.listener.close().await?;
        let _drain = self.admission.clone().write_owned().await;
        let mut drivers = self.drivers.clone();
        while *drivers.borrow_and_update() != 0 {
            drivers.changed().await?;
        }
        Ok(())
    }
}
