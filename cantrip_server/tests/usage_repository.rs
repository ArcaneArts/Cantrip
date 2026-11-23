use anyhow::{Context, Result};
use cantrip_server::{
    auth::{crypto, repository::AuthRepository},
    database::Database,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    usage::{BandwidthEntry, FlushBatch, repository::UsageRepository},
};
use chrono::{DateTime, Utc};
use num_bigint::BigInt;
use std::{path::PathBuf, sync::Arc};

async fn exercise(database: Arc<Database>, competing: Option<Arc<Database>>) -> Result<()> {
    migrate(&database).await?;
    let auth = AuthRepository::new(database.clone());
    let owner = auth.local_user().await?.id;
    let other = auth
        .create_account(
            "Other",
            "usage@example.invalid",
            "usage@example.invalid",
            crypto::DUMMY_PASSWORD_HASH,
            "member",
        )
        .await?
        .id;
    let repo = UsageRepository::new(database.clone());
    let at: DateTime<Utc> = "2026-10-27T00:00:00.123Z".parse()?;
    let entry = BandwidthEntry {
        owner_id: owner.clone(),
        bucket_start: at,
        bytes: "9007199254740993".parse()?,
        operation_count: BigInt::from(3),
        channel: "http".into(),
        direction: "egress".into(),
    };
    let batch = FlushBatch {
        entries: vec![
            entry.clone(),
            BandwidthEntry {
                owner_id: other.clone(),
                bytes: BigInt::from(7),
                ..entry.clone()
            },
            BandwidthEntry {
                owner_id: "deleted-owner".into(),
                bytes: BigInt::from(17),
                ..entry.clone()
            },
        ],
        flushed_at: at,
        meter_id: "native-fixture".into(),
        sequence: BigInt::from(1),
    };
    let applied = repo.flush_bandwidth(batch.clone()).await?;
    assert!(applied.applied);
    assert_eq!(applied.owner_ids.len(), 2);
    let rows = repo
        .bandwidth_history(
            &owner,
            at - chrono::Duration::hours(1),
            at + chrono::Duration::hours(1),
            true,
        )
        .await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].bytes, entry.bytes);
    assert_eq!(rows[0].operation_count, BigInt::from(3));
    let replay = repo.flush_bandwidth(batch).await?;
    assert!(!replay.applied);
    assert_eq!(replay.owner_ids, applied.owner_ids);
    assert_eq!(
        repo.bandwidth_history(
            &owner,
            at - chrono::Duration::hours(1),
            at + chrono::Duration::hours(1),
            true
        )
        .await?,
        rows
    );
    let mut duplicate = FlushBatch {
        entries: vec![entry.clone(), entry.clone()],
        flushed_at: at,
        meter_id: "native-fixture".into(),
        sequence: BigInt::from(2),
    };
    assert!(
        repo.flush_bandwidth(duplicate.clone()).await.is_err(),
        "one batch must preserve SQL duplicate-key rejection"
    );
    assert!(database.query("SELECT 1 FROM account_bandwidth_flushes WHERE meter_id='native-fixture' AND sequence=2",&[]).await?.is_empty(),"failed batch must roll its receipt back");
    duplicate.entries.pop();
    assert!(repo.flush_bandwidth(duplicate).await?.applied);
    let deleted = repo
        .bandwidth_history(
            "deleted-owner",
            at - chrono::Duration::hours(1),
            at + chrono::Duration::hours(1),
            true,
        )
        .await?;
    assert!(deleted.is_empty());
    assert!(repo.acquire_lease("fixture", "first", at, 1000).await?);
    let peer = UsageRepository::new(competing.unwrap_or_else(|| database.clone()));
    assert!(!peer.acquire_lease("fixture", "second", at, 1000).await?);
    peer.release_lease("fixture", "second").await?;
    assert!(!peer.acquire_lease("fixture", "second", at, 1000).await?);
    assert!(
        peer.acquire_lease(
            "fixture",
            "second",
            at + chrono::Duration::milliseconds(1000),
            1000
        )
        .await?
    );
    repo.release_lease("fixture", "first").await?;
    assert!(
        !repo
            .acquire_lease(
                "fixture",
                "first",
                at + chrono::Duration::milliseconds(1000),
                1000
            )
            .await?
    );
    let measured = repo.measure_storage().await?;
    assert!(
        measured
            .iter()
            .any(|r| r.owner_id == owner && r.category == "account")
    );
    assert!(
        measured
            .iter()
            .all(|r| r.logical_bytes >= BigInt::default())
    );
    let result = repo.reconcile_storage("fixture-owner", at).await?;
    assert!(result.acquired);
    assert_eq!(result.account_count, 2);
    let current = repo.current_storage(&owner).await?;
    assert!(!current.is_empty());
    assert!(current.iter().all(|r| r.measurement.owner_id == owner));
    assert!(
        !repo
            .storage_history(
                &owner,
                at - chrono::Duration::hours(1),
                at + chrono::Duration::hours(1),
                true
            )
            .await?
            .is_empty()
    );
    assert!(repo.current_storage("unknown").await?.is_empty());
    Ok(())
}
#[tokio::test]
async fn usage_transactions_ownership_leases_and_exact_counters_on_native_pglite() -> Result<()> {
    if let Ok(phase) = std::env::var("CANTRIP_USAGE_REPOSITORY_PHASE") {
        let root = PathBuf::from(std::env::var("CANTRIP_USAGE_REPOSITORY_ROOT")?);
        let database = Arc::new(Database::pglite(&root.join("database")).await?);
        let result = if phase == "seed" {
            exercise(database.clone(), None).await
        } else {
            migrate(&database).await?;
            let repo = UsageRepository::new(database.clone());
            let at: DateTime<Utc> = "2026-10-27T00:00:00.123Z".parse()?;
            let rows = repo
                .bandwidth_history(
                    cantrip_server::auth::LOCAL_USER_ID,
                    at - chrono::Duration::hours(1),
                    at + chrono::Duration::hours(1),
                    true,
                )
                .await?;
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].bytes, "18014398509481986".parse::<BigInt>()?);
            assert!(
                !repo
                    .current_storage(cantrip_server::auth::LOCAL_USER_ID)
                    .await?
                    .is_empty()
            );
            Ok(())
        };
        database.close().await?;
        return result;
    }
    // Embedded PostgreSQL owns process-global signal/stdio state. Isolate it
    // from the concurrently spawned PostgreSQL fixture, as other suites do.
    let root = tempfile::tempdir()?;
    for phase in ["seed", "reopen"] {
        let output = tokio::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "usage_transactions_ownership_leases_and_exact_counters_on_native_pglite",
                "--nocapture",
            ])
            .env("CANTRIP_USAGE_REPOSITORY_PHASE", phase)
            .env("CANTRIP_USAGE_REPOSITORY_ROOT", root.path())
            .kill_on_drop(true)
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "Native usage {phase} failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}
#[tokio::test]
async fn usage_transactions_ownership_leases_and_exact_counters_on_postgres() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(
        std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR").context("usage PostgreSQL binaries")?,
    );
    let runtime = ManagedPostgres::start_with_owner(
        root.path(),
        &bin,
        std::path::Path::new(env!("CARGO_BIN_EXE_cantrip-server")),
    )
    .await?;
    let database = Arc::new(Database::postgres(runtime.configuration()).await?);
    let competing = Arc::new(Database::postgres(runtime.configuration()).await?);
    let result = exercise(database.clone(), Some(competing.clone())).await;
    competing.close().await?;
    database.close().await?;
    runtime.close().await?;
    result
}
