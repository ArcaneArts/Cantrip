use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use cantrip_server::{database::Database, managed_postgres::ManagedPostgres};
use tokio::{sync::oneshot, task::JoinHandle};
use tokio_postgres::{Client, Config, NoTls};

const APPLICATION: &str = "cantrip-native-pool-contract";
const DEADLINE: Duration = Duration::from_secs(5);

async fn raw(
    configuration: &Config,
) -> Result<(Client, JoinHandle<Result<(), tokio_postgres::Error>>)> {
    let mut configuration = configuration.clone();
    configuration.application_name("cantrip-pool-inspector");
    let (client, connection) = configuration.connect(NoTls).await?;
    Ok((client, tokio::spawn(connection)))
}

async fn blocked(inspector: &Client) -> Result<Vec<i32>> {
    Ok(inspector.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' ORDER BY pid", &[&APPLICATION]).await?.iter().map(|row| row.get(0)).collect())
}

async fn wait_blocked(inspector: &Client, count: usize) -> Result<Vec<i32>> {
    tokio::time::timeout(DEADLINE, async {
        loop {
            let pids = blocked(inspector).await?;
            if pids.len() == count {
                return Ok(pids);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .context("observe actual PostgreSQL lock waits")?
}

async fn wait_gone(inspector: &Client, pid: i32) -> Result<()> {
    tokio::time::timeout(DEADLINE, async {
        while inspector
            .query_opt("SELECT pid FROM pg_stat_activity WHERE pid=$1", &[&pid])
            .await?
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("observe actual backend exit")??;
    Ok(())
}

async fn listener_pid(inspector: &Client) -> Result<i32> {
    Ok(inspector
        .query_one(
            "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query LIKE 'LISTEN %'",
            &[&APPLICATION],
        )
        .await?
        .get(0))
}

#[tokio::test]
async fn postgres_concurrency_cancellation_listener_and_recovery() -> Result<()> {
    let directory = tempfile::Builder::new().prefix("cantrip pool ").tempdir()?;
    let binaries = PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?);
    let runtime = ManagedPostgres::start(directory.path(), &binaries).await?;
    let mut configuration = runtime.configuration().clone();
    configuration.application_name(APPLICATION);
    let database = Arc::new(Database::postgres(&configuration).await?);
    let (inspector, inspector_driver) = raw(&configuration).await?;
    let (locker, locker_driver) = raw(&configuration).await?;
    database
        .execute("CREATE TABLE pool_contract(id int PRIMARY KEY)")
        .await?;
    let mut notifications = database.listen("pool_contract").await?;
    let mut second_channel = database.listen("pool_second").await?;
    let original_listener = listener_pid(&inspector).await?;
    locker
        .batch_execute("BEGIN; LOCK TABLE pool_contract IN ACCESS EXCLUSIVE MODE")
        .await?;
    let first = {
        let database = database.clone();
        tokio::spawn(async move { database.query("SELECT id FROM pool_contract", &[]).await })
    };
    let first_pid = wait_blocked(&inspector, 1).await?[0];
    let rows = tokio::time::timeout(DEADLINE, database.query("SELECT 42", &[])).await??;
    assert_eq!(rows[0].get::<i32>(0)?, 42);
    assert_eq!(blocked(&inspector).await?, vec![first_pid]);
    first.abort();
    let _ = first.await;
    wait_gone(&inspector, first_pid).await?;

    let mut requests = Vec::new();
    for _ in 0..5 {
        let database = database.clone();
        requests.push(tokio::spawn(async move {
            database.query("SELECT id FROM pool_contract", &[]).await
        }));
    }
    wait_blocked(&inspector, 5).await?;
    let mut sixth = {
        let database = database.clone();
        tokio::spawn(async move { database.query("SELECT 43", &[]).await })
    };
    ensure!(
        tokio::time::timeout(Duration::from_millis(150), &mut sixth)
            .await
            .is_err(),
        "sixth request bypassed the five busy request connections"
    );
    let count: i64 = inspector
        .query_one(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1",
            &[&APPLICATION],
        )
        .await?
        .get(0);
    assert_eq!(
        count, 6,
        "five request connections plus one dedicated listener"
    );
    inspector
        .batch_execute("SELECT pg_notify('pool_contract','while-all-five-blocked')")
        .await?;
    assert_eq!(
        tokio::time::timeout(DEADLINE, notifications.recv()).await??,
        ("pool_contract".into(), "while-all-five-blocked".into())
    );
    requests[0].abort();
    let _ = (&mut requests[0]).await;
    let rows = tokio::time::timeout(DEADLINE, sixth).await???;
    assert_eq!(rows[0].get::<i32>(0)?, 43);
    for request in requests.into_iter().skip(1) {
        request.abort();
        let _ = request.await;
    }
    wait_blocked(&inspector, 0).await?;
    locker.batch_execute("ROLLBACK").await?;

    // Killing only LISTEN must restore all existing subscriptions, without a
    // new listen() call or a query-pool health probe triggering reconnection.
    inspector
        .query_one("SELECT pg_terminate_backend($1)", &[&original_listener])
        .await?;
    wait_gone(&inspector, original_listener).await?;
    tokio::time::timeout(DEADLINE, async {
        loop {
            inspector.batch_execute("SELECT pg_notify('pool_contract','after-reconnect'); SELECT pg_notify('pool_second','second-channel')").await?;
            if let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(100), notifications.recv()).await
                && event == ("pool_contract".into(), "after-reconnect".into()) {
                return Ok::<_,anyhow::Error>(());
            }
        }
    }).await.context("existing LISTEN subscription did not recover")??;
    assert_ne!(listener_pid(&inspector).await?, original_listener);
    tokio::time::timeout(DEADLINE, async {
        loop {
            if second_channel.recv().await? == ("pool_second".into(), "second-channel".into()) {
                return Ok::<_, anyhow::Error>(());
            }
        }
    })
    .await??;

    let (started, observed) = oneshot::channel();
    let transaction = {
        let database = database.clone();
        tokio::spawn(async move {
            database
                .transaction(move |transaction| {
                    Box::pin(async move {
                        let rows = transaction.query("SELECT pg_backend_pid()", &[]).await?;
                        let pid = rows[0].get::<i32>(0)?;
                        transaction
                            .execute("INSERT INTO pool_contract VALUES (99)")
                            .await?;
                        let _ = started.send(pid);
                        std::future::pending::<Result<()>>().await
                    })
                })
                .await
        })
    };
    let transaction_pid = observed.await?;
    transaction.abort();
    let _ = transaction.await;
    wait_gone(&inspector, transaction_pid).await?;
    let retained: i64 = inspector
        .query_one("SELECT count(*) FROM pool_contract", &[])
        .await?
        .get(0);
    assert_eq!(retained, 0);
    tokio::time::timeout(
        DEADLINE,
        inspector.execute("INSERT INTO pool_contract VALUES (99)", &[]),
    )
    .await??;

    locker
        .batch_execute("BEGIN; LOCK TABLE pool_contract IN ACCESS EXCLUSIVE MODE")
        .await?;
    let interrupted = {
        let database = database.clone();
        tokio::spawn(async move { database.query("SELECT id FROM pool_contract", &[]).await })
    };
    let interrupted_pid = wait_blocked(&inspector, 1).await?[0];
    inspector
        .query_one("SELECT pg_terminate_backend($1)", &[&interrupted_pid])
        .await?;
    ensure!(
        tokio::time::timeout(DEADLINE, interrupted).await??.is_err(),
        "terminated query was silently retried"
    );
    wait_gone(&inspector, interrupted_pid).await?;
    assert!(blocked(&inspector).await?.is_empty());
    assert_eq!(
        database.query("SELECT 44", &[]).await?[0].get::<i32>(0)?,
        44
    );
    locker.batch_execute("ROLLBACK").await?;

    // Close must wake a queued pool borrower, then drain all admitted queries
    // and their cancellation cleanup before reporting completion.
    locker
        .batch_execute("BEGIN; LOCK TABLE pool_contract IN ACCESS EXCLUSIVE MODE")
        .await?;
    let mut pending = Vec::new();
    for _ in 0..5 {
        let database = database.clone();
        pending.push(tokio::spawn(async move {
            database.query("SELECT id FROM pool_contract", &[]).await
        }));
    }
    let pending_pids = wait_blocked(&inspector, 5).await?;
    let mut queued = {
        let database = database.clone();
        tokio::spawn(async move { database.query("SELECT 45", &[]).await })
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut queued)
            .await
            .is_err()
    );
    let mut closing = {
        let database = database.clone();
        tokio::spawn(async move { database.close().await })
    };
    ensure!(
        tokio::time::timeout(Duration::from_millis(100), &mut closing)
            .await
            .is_err(),
        "close ignored an admitted query"
    );
    ensure!(
        tokio::time::timeout(DEADLINE, queued).await??.is_err(),
        "pool close did not wake queued borrower with an error"
    );
    for request in pending {
        request.abort();
        let _ = request.await;
    }
    tokio::time::timeout(DEADLINE, closing).await???;
    for pid in pending_pids {
        wait_gone(&inspector, pid).await?;
    }
    tokio::time::timeout(DEADLINE, async {
        loop {
            let count: i64 = inspector
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1",
                    &[&APPLICATION],
                )
                .await?
                .get(0);
            if count == 0 {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .context("close left actual PostgreSQL sessions")??;
    assert!(database.query("SELECT 1", &[]).await.is_err());
    assert!(database.listen("after_close").await.is_err());
    database.close().await?;
    locker.batch_execute("ROLLBACK").await?;
    drop(locker);
    drop(inspector);
    locker_driver.await??;
    inspector_driver.await??;
    runtime.close().await?;
    Ok(())
}
