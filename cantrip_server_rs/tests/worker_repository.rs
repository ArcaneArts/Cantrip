mod support;

use anyhow::{Context, Result};
use cantrip_server::{
    auth::{crypto, repository::AuthRepository},
    database::Database,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    workers::{
        DEFAULT_CREDENTIAL_SCOPES, WorkerEnrollmentError,
        repository::{EnrollmentInput, RotationInput, WorkerRepository},
    },
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use uuid::Uuid;

fn heartbeat(id: &str) -> Result<Value> {
    let fixture =
        support::security_fixtures(&["workerCredentialListSchema", "workerHeartbeatSchema"])?;
    assert_eq!(
        json!(DEFAULT_CREDENTIAL_SCOPES),
        fixture["workerCredentialListSchema"][0][0]["scopes"]
    );
    let mut heartbeat = fixture["workerHeartbeatSchema"][0].clone();
    heartbeat["workerId"] = json!(id);
    Ok(heartbeat)
}
fn input(code: &str, heartbeat: &Value, secret: &str) -> EnrollmentInput {
    EnrollmentInput {
        code_hash: crypto::hash_secret(code),
        credential_hash: crypto::hash_secret(secret),
        credential_id: Uuid::new_v4().to_string(),
        heartbeat: heartbeat.clone(),
        replacement: None,
        scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
    }
}
async fn code(repo: &WorkerRepository, owner: &str, secret: &str) -> Result<String> {
    repo.create_enrollment_code(
        owner,
        None,
        &crypto::hash_secret(secret),
        Some("Fixture code"),
        chrono::Utc::now() + chrono::Duration::minutes(10),
    )
    .await
}
fn error_message(error: anyhow::Error, expected: &str) {
    assert_eq!(
        error.downcast_ref::<WorkerEnrollmentError>().map(|e| e.0),
        Some(expected)
    );
}

async fn exercise(database: Arc<Database>, competing: Option<Arc<Database>>) -> Result<Value> {
    migrate(&database).await?;
    let auth = AuthRepository::new(database.clone());
    let owner = auth.local_user().await?.id;
    let other = auth
        .create_account(
            "Other owner",
            "other@example.invalid",
            "other@example.invalid",
            crypto::DUMMY_PASSWORD_HASH,
            "member",
        )
        .await?
        .id;
    let repo = WorkerRepository::new(database.clone());
    let hb = heartbeat("fixture-worker")?;
    assert_eq!(
        repo.reusable_worker_id(
            &owner,
            &["unknown-a".into(), "unknown-a".into(), "unknown-b".into()]
        )
        .await?,
        Some("unknown-a".into())
    );
    let id = code(&repo, &owner, "fixture-code").await?;
    assert_eq!(
        repo.enrollment_code_status(&owner, &id).await?.unwrap()["status"],
        "pending"
    );
    assert!(repo.enrollment_code_status(&other, &id).await?.is_none());
    let provision = repo
        .exchange_enrollment_code(input("fixture-code", &hb, "first-secret"))
        .await?;
    assert_eq!(provision.owner_id, owner);
    assert!(provision.revoked_credential_ids.is_empty());
    assert!(provision.replaced_worker_id.is_none());
    assert_eq!(provision.worker["workerId"], hb["workerId"]);
    assert_eq!(provision.worker["online"], true);
    assert_eq!(provision.credential["label"], "Fixture code");
    assert_eq!(provision.credential["active"], true);
    assert_eq!(
        repo.enrollment_code_status(&owner, &id).await?.unwrap()["status"],
        "paired"
    );
    let repeat = repo
        .exchange_enrollment_code(input("fixture-code", &hb, "repeat-secret"))
        .await
        .err()
        .context("single-use code")?;
    error_message(
        repeat,
        "This worker link code is invalid, expired, or already used.",
    );
    let credential = repo
        .authenticate(
            &crypto::hash_secret("first-secret"),
            "fixture-worker",
            "worker:heartbeat",
        )
        .await?
        .unwrap();
    assert_eq!(credential.owner_id, owner);
    assert_eq!(credential.worker_id, "fixture-worker");
    assert_eq!(credential.scopes, DEFAULT_CREDENTIAL_SCOPES);
    assert_eq!(credential.id, provision.credential["id"]);
    assert!(
        repo.authenticate(
            &crypto::hash_secret("first-secret"),
            "different-worker",
            "worker:connect"
        )
        .await?
        .is_none()
    );
    assert!(
        repo.authenticate(
            &crypto::hash_secret("first-secret"),
            "fixture-worker",
            "missing:scope"
        )
        .await?
        .is_none()
    );
    assert!(
        repo.list_credentials(&other, "fixture-worker")
            .await?
            .is_none()
    );
    let blocked = code(&repo, &owner, "blocked-code").await?;
    error_message(
        repo.exchange_enrollment_code(input("blocked-code", &hb, "blocked-secret"))
            .await
            .err()
            .context("already enrolled")?,
        "This worker identity is already enrolled. Rotate its credential instead.",
    );
    assert_eq!(
        repo.enrollment_code_status(&owner, &blocked)
            .await?
            .unwrap()["status"],
        "pending"
    );
    error_message(
        repo.record_worker(&other, &hb)
            .await
            .err()
            .context("heartbeat owner boundary")?,
        "This worker identity belongs to another account.",
    );
    database
        .query(
            "UPDATE workers SET display_name='Retained display name' WHERE id='fixture-worker'",
            &[],
        )
        .await?;
    let mut updated = hb.clone();
    updated["name"] = json!("Changed runtime name");
    assert_eq!(
        repo.record_worker(&owner, &updated).await?["name"],
        "Retained display name"
    );
    database.query("UPDATE worker_credentials SET expires_at=now()-interval '1 second' WHERE worker_id='fixture-worker'",&[]).await?;
    assert!(
        repo.authenticate(
            &crypto::hash_secret("first-secret"),
            "fixture-worker",
            "worker:connect"
        )
        .await?
        .is_none()
    );
    let rotated = repo
        .rotate_credential(RotationInput {
            credential_hash: crypto::hash_secret("rotated-secret"),
            credential_id: Uuid::new_v4().to_string(),
            label: None,
            owner_id: owner.clone(),
            worker_id: "fixture-worker".into(),
            scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
        })
        .await?
        .unwrap();
    assert_eq!(rotated["active"], true);
    assert!(rotated["lastUsedAt"].is_null());
    let previous = database
        .query(
            "SELECT replaces_credential_id FROM worker_credentials WHERE id=$1",
            &[&rotated["id"].as_str().unwrap()],
        )
        .await?[0]
        .get::<Option<String>>(0)?;
    assert_eq!(previous.as_deref(), provision.credential["id"].as_str());
    assert!(
        repo.authenticate(
            &crypto::hash_secret("rotated-secret"),
            "fixture-worker",
            "worker:connect"
        )
        .await?
        .is_some()
    );
    assert!(
        repo.authenticate(
            &crypto::hash_secret("first-secret"),
            "fixture-worker",
            "worker:connect"
        )
        .await?
        .is_none()
    );
    assert_eq!(
        repo.list_credentials(&owner, "fixture-worker")
            .await?
            .unwrap()
            .len(),
        2
    );
    assert!(
        repo.revoke_credential(
            &other,
            "fixture-worker",
            rotated["id"].as_str().unwrap(),
            "revoked by owner"
        )
        .await?
        .is_none()
    );
    let revoked = repo
        .revoke_credential(
            &owner,
            "fixture-worker",
            rotated["id"].as_str().unwrap(),
            "revoked by owner",
        )
        .await?
        .unwrap();
    assert_eq!(revoked["active"], false);
    assert!(
        repo.revoke_credential(
            &owner,
            "fixture-worker",
            rotated["id"].as_str().unwrap(),
            "again"
        )
        .await?
        .is_none()
    );
    error_message(
        repo.rotate_credential(RotationInput {
            credential_hash: crypto::hash_secret("impossible"),
            credential_id: Uuid::new_v4().to_string(),
            label: None,
            owner_id: owner.clone(),
            worker_id: "fixture-worker".into(),
            scopes: DEFAULT_CREDENTIAL_SCOPES.map(String::from).into(),
        })
        .await
        .err()
        .context("bootstrap rotation error")?,
        "Development bootstrap workers do not have rotatable credentials.",
    );
    code(&repo, &owner, "re-enroll").await?;
    repo.exchange_enrollment_code(input("re-enroll", &hb, "replacement-secret"))
        .await?;
    let rollback_code = code(&repo, &other, "replacement-conflict").await?;
    let mut replacement = input("replacement-conflict", &hb, "rejected-secret");
    replacement.replacement = Some((
        "fixture-worker".into(),
        crypto::hash_secret("replacement-secret"),
    ));
    error_message(
        repo.exchange_enrollment_code(replacement)
            .await
            .err()
            .context("same identity replacement")?,
        "A worker cannot replace its own identity during enrollment.",
    );
    let mut collision = input(
        "replacement-conflict",
        &heartbeat("owned-collision")?,
        "collision-secret",
    );
    collision.replacement = Some((
        "fixture-worker".into(),
        crypto::hash_secret("replacement-secret"),
    ));
    repo.record_worker(&owner, &heartbeat("owned-collision")?)
        .await?;
    error_message(
        repo.exchange_enrollment_code(collision)
            .await
            .err()
            .context("reassignment rollback")?,
        "This worker identity is already owned by another account.",
    );
    assert_eq!(
        repo.enrollment_code_status(&other, &rollback_code)
            .await?
            .unwrap()["status"],
        "pending"
    );
    assert!(repo.get_worker(&owner, "fixture-worker").await?.is_some());
    assert!(
        repo.authenticate(
            &crypto::hash_secret("replacement-secret"),
            "fixture-worker",
            "worker:connect"
        )
        .await?
        .is_some()
    );
    let mut reassigned = input(
        "replacement-conflict",
        &heartbeat("reassigned-worker")?,
        "reassigned-secret",
    );
    reassigned.replacement = Some((
        "fixture-worker".into(),
        crypto::hash_secret("replacement-secret"),
    ));
    let reassigned = repo.exchange_enrollment_code(reassigned).await?;
    assert_eq!(reassigned.owner_id, other);
    assert_eq!(
        reassigned.replaced_worker_id.as_deref(),
        Some("fixture-worker")
    );
    assert_eq!(reassigned.revoked_credential_ids.len(), 1);
    assert!(repo.get_worker(&owner, "fixture-worker").await?.is_none());
    assert!(
        repo.authenticate(
            &crypto::hash_secret("replacement-secret"),
            "fixture-worker",
            "worker:connect"
        )
        .await?
        .is_none()
    );
    assert_eq!(
        repo.reusable_worker_id(&owner, &["unknown-a".into(), "fixture-worker".into()])
            .await?,
        Some("fixture-worker".into())
    );
    assert_eq!(
        repo.reusable_worker_id(
            &other,
            &[
                "fixture-worker".into(),
                "reassigned-worker".into(),
                "new-worker".into()
            ]
        )
        .await?,
        Some("new-worker".into())
    );
    let expired = repo
        .create_enrollment_code(
            &owner,
            None,
            &crypto::hash_secret("expired"),
            None,
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .await?;
    assert_eq!(
        repo.enrollment_code_status(&owner, &expired)
            .await?
            .unwrap()["status"],
        "expired"
    );
    error_message(
        repo.exchange_enrollment_code(input(
            "expired",
            &heartbeat("expired-worker")?,
            "expired-secret",
        ))
        .await
        .err()
        .context("expired code")?,
        "This worker link code is invalid, expired, or already used.",
    );
    code(&repo, &owner, "concurrent-code").await?;
    let hb = heartbeat("concurrent-worker")?;
    let attempts = (0..10).map(|i| {
        let repo = WorkerRepository::new(if i % 2 == 1 {
            competing.clone().unwrap_or_else(|| database.clone())
        } else {
            database.clone()
        });
        let input = input("concurrent-code", &hb, &format!("concurrent-secret-{i}"));
        async move { repo.exchange_enrollment_code(input).await }
    });
    let results = futures::future::join_all(attempts).await;
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    for error in results.into_iter().filter_map(Result::err) {
        error_message(
            error,
            "This worker link code is invalid, expired, or already used.",
        );
    }
    // Force a real failure after heartbeat/code updates, at credential insert.
    database.execute("CREATE FUNCTION reject_fixture_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.worker_id='rollback-worker' THEN RAISE EXCEPTION 'fixture insertion failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_credential BEFORE INSERT ON worker_credentials FOR EACH ROW EXECUTE FUNCTION reject_fixture_credential()").await?;
    let failed = code(&repo, &owner, "failed-insert").await?;
    assert!(
        repo.exchange_enrollment_code(input(
            "failed-insert",
            &heartbeat("rollback-worker")?,
            "failed-secret"
        ))
        .await
        .is_err()
    );
    assert_eq!(
        repo.enrollment_code_status(&owner, &failed).await?.unwrap()["status"],
        "pending"
    );
    assert!(repo.get_worker(&owner, "rollback-worker").await?.is_none());
    database.execute("DROP TRIGGER reject_fixture_credential ON worker_credentials; DROP FUNCTION reject_fixture_credential()").await?;
    Ok(
        json!({"owner":owner,"other":other,"pairedCode":id,"ownerWorkers":repo.list_workers(&owner).await?,"otherWorkers":repo.list_workers(&other).await?,"credentials":repo.list_credentials(&other,"reassigned-worker").await?}),
    )
}
async fn retained(database: Arc<Database>, snapshot: &Value) -> Result<()> {
    assert_eq!(migrate(&database).await?, 0);
    let repo = WorkerRepository::new(database.clone());
    for (key, owner) in [("ownerWorkers", "owner"), ("otherWorkers", "other")] {
        let mut expected = snapshot[key].clone();
        let mut actual = json!(repo.list_workers(snapshot[owner].as_str().unwrap()).await?);
        for list in [&mut expected, &mut actual] {
            for worker in list.as_array_mut().unwrap() {
                worker.as_object_mut().unwrap().remove("online");
            }
        }
        assert_eq!(actual, expected);
    }
    assert_eq!(
        json!(
            repo.list_credentials(snapshot["other"].as_str().unwrap(), "reassigned-worker")
                .await?
        ),
        snapshot["credentials"]
    );
    assert_eq!(
        repo.enrollment_code_status(
            snapshot["owner"].as_str().unwrap(),
            snapshot["pairedCode"].as_str().unwrap()
        )
        .await?
        .unwrap()["status"],
        "paired"
    );
    database.close().await
}
#[tokio::test]
async fn native_worker_enrollment_rotation_transactions_and_reopen() -> Result<()> {
    if let Ok(phase) = std::env::var("CANTRIP_WORKER_REPOSITORY_PHASE") {
        let root = PathBuf::from(std::env::var("CANTRIP_WORKER_REPOSITORY_ROOT")?);
        let database = Arc::new(Database::pglite(&root.join("database")).await?);
        if phase == "seed" {
            let snapshot = exercise(database.clone(), None).await?;
            std::fs::write(root.join("retained.json"), serde_json::to_vec(&snapshot)?)?;
            database.close().await?;
        } else {
            retained(
                database,
                &serde_json::from_slice(&std::fs::read(root.join("retained.json"))?)?,
            )
            .await?;
        }
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    for phase in ["seed", "reopen"] {
        let output = tokio::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "native_worker_enrollment_rotation_transactions_and_reopen",
                "--nocapture",
            ])
            .env("CANTRIP_WORKER_REPOSITORY_PHASE", phase)
            .env("CANTRIP_WORKER_REPOSITORY_ROOT", root.path())
            .kill_on_drop(true)
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "Native worker {phase} failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}
#[tokio::test]
async fn postgres_worker_enrollment_rotation_concurrency_and_reopen() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(
        std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR").context("worker PostgreSQL binaries")?,
    );
    let runtime = ManagedPostgres::start(root.path(), &bin).await?;
    let database = Arc::new(Database::postgres(runtime.configuration()).await?);
    let competing = Arc::new(Database::postgres(runtime.configuration()).await?);
    let snapshot = exercise(database.clone(), Some(competing.clone())).await?;
    competing.close().await?;
    database.close().await?;
    runtime.close().await?;
    let runtime = ManagedPostgres::start(root.path(), &bin).await?;
    retained(
        Arc::new(Database::postgres(runtime.configuration()).await?),
        &snapshot,
    )
    .await?;
    runtime.close().await?;
    Ok(())
}
