mod support;

use anyhow::{Context, Result};
use cantrip_server::{
    auth::{crypto, repository::AuthRepository},
    database::Database,
    encryption::repository::EncryptionRepository,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use uuid::Uuid;

fn fixtures() -> Result<Value> {
    support::security_fixtures(&[
        "accountEncryptionProfileInitializeSchema",
        "accountPasswordEncryptionChangeSchema",
        "encryptionKeyGrantCreateSchema",
    ])
}

fn client_input(initial: &Value, id: &str) -> Value {
    json!({"id":id,"kind":"client","label":null,"publicKey":initial["initialClient"]["publicKey"]})
}
fn client_grant(initial: &Value, id: &str) -> Value {
    let mut wrapped = initial["initialClient"]["wrappedMasterKey"].clone();
    wrapped["clientId"] = json!(id);
    json!({"component":"account-master-key","keyRevision":1,"wrappedKey":wrapped})
}

async fn exercise(database: Arc<Database>, competing: Option<Arc<Database>>) -> Result<Value> {
    migrate(&database).await?;
    let auth = AuthRepository::new(database.clone());
    let owner = auth
        .create_account(
            "Owner",
            "owner@example.invalid",
            "owner@example.invalid",
            crypto::DUMMY_PASSWORD_HASH,
            "owner",
        )
        .await?
        .id;
    let other = auth
        .create_account(
            "Other",
            "other@example.invalid",
            "other@example.invalid",
            crypto::DUMMY_PASSWORD_HASH,
            "member",
        )
        .await?
        .id;
    let repo = EncryptionRepository::new(database.clone());
    let fixtures = fixtures()?;
    let initial = &fixtures["accountEncryptionProfileInitializeSchema"][0];
    assert!(repo.get_profile(&owner).await?.is_none());
    let created = repo.initialize(&owner, initial).await?;
    assert_eq!(created["created"], true);
    assert_eq!(created["profile"]["ownerId"], owner);
    assert_eq!(
        created["grant"]["wrappedKey"],
        initial["initialClient"]["wrappedMasterKey"]
    );
    assert_eq!(
        repo.initialize(
            &owner,
            &fixtures["accountEncryptionProfileInitializeSchema"][1]
        )
        .await?["created"],
        false
    );
    assert!(repo.get_profile(&other).await?.is_none());
    assert!(repo.list_principals(&other).await?.is_empty());
    let initial_id = initial["initialClient"]["id"].as_str().unwrap();
    assert_eq!(
        repo.active_grants(&other, initial_id).await?["status"],
        "missing"
    );
    assert!(
        repo.approve_principal(&other, initial_id, 1)
            .await?
            .is_none()
    );
    let updated = repo
        .update_migration(
            &owner,
            &json!({"expectedRevision":1,"payloadMigrationStatus":"in-progress"}),
        )
        .await?
        .unwrap();
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["payloadMigrationStatus"], "in-progress");
    assert!(
        repo.update_migration(
            &owner,
            &json!({"expectedRevision":1,"payloadMigrationStatus":"complete"})
        )
        .await?
        .is_none()
    );
    let mut password_change = fixtures["accountPasswordEncryptionChangeSchema"][0].clone();
    assert!(
        repo.change_password(&owner, &password_change, "wrong-stale-hash")
            .await?
            .is_none()
    );
    assert_eq!(
        auth.credential(&owner, true).await?.unwrap().1,
        crypto::DUMMY_PASSWORD_HASH
    );
    password_change["expectedProfileRevision"] = json!(2);
    let new_hash = "new-opaque-password-hash";
    let changed = repo
        .change_password(&owner, &password_change, new_hash)
        .await?
        .unwrap();
    assert_eq!(changed["revision"], 3);
    assert_eq!(
        changed["passwordWrappedMasterKey"],
        password_change["passwordWrappedMasterKey"]
    );
    assert_eq!(auth.credential(&owner, true).await?.unwrap().1, new_hash);
    let pending_id = Uuid::new_v4().to_string();
    let input = client_input(initial, &pending_id);
    assert!(repo.create_principal(&other, &input, None).await?.is_none());
    assert_eq!(
        repo.create_principal(&owner, &input, None).await?.unwrap()["state"],
        "pending"
    );
    assert!(repo.create_principal(&owner, &input, None).await?.is_none());
    assert_eq!(
        repo.active_grants(&owner, &pending_id).await?["status"],
        "unavailable"
    );
    assert!(
        repo.approve_principal(&owner, &pending_id, 2)
            .await?
            .is_none()
    );
    assert_eq!(
        repo.approve_principal(&owner, &pending_id, 1)
            .await?
            .unwrap()["revision"],
        2
    );
    assert!(
        repo.approve_principal(&owner, &pending_id, 1)
            .await?
            .is_none()
    );
    let grant_input = client_grant(initial, &pending_id);
    let mut wrong = grant_input.clone();
    wrong["wrappedKey"]["clientId"] = json!(initial_id);
    assert_eq!(
        repo.create_grant(&owner, &pending_id, &wrong).await?["status"],
        "wrapper-mismatch"
    );
    let mut attempts = Vec::new();
    for index in 0..10 {
        let repo = EncryptionRepository::new(if index % 2 == 0 {
            competing.clone().unwrap_or_else(|| database.clone())
        } else {
            database.clone()
        });
        let owner = owner.clone();
        let id = pending_id.clone();
        let input = grant_input.clone();
        attempts.push(tokio::spawn(async move {
            repo.create_grant(&owner, &id, &input).await
        }));
    }
    let mut successes = Vec::new();
    for attempt in attempts {
        let result = attempt.await??;
        if result["status"] == "created" {
            successes.push(result["grant"].clone());
        } else {
            assert_eq!(result["status"], "conflict");
        }
    }
    assert_eq!(successes.len(), 1);
    let grant_id = successes[0]["id"].as_str().unwrap();
    assert!(
        repo.revoke_grant(
            &other,
            grant_id,
            &json!({"expectedRevision":1,"reason":"wrong owner"})
        )
        .await?
        .is_none()
    );
    assert_eq!(
        repo.revoke_principal(
            &owner,
            &pending_id,
            &json!({"expectedRevision":2,"reason":"fixture principal revoked"})
        )
        .await?
        .unwrap()["revision"],
        3
    );
    let revoked = database
        .query(
            "SELECT state,revision,revoked_reason FROM encryption_key_grants WHERE id=$1",
            &[&grant_id],
        )
        .await?;
    assert_eq!(revoked[0].get::<String>(0)?, "revoked");
    assert_eq!(revoked[0].get::<i32>(1)?, 2);
    assert_eq!(revoked[0].get::<String>(2)?, "principal revoked");
    assert!(
        repo.revoke_grant(
            &owner,
            grant_id,
            &json!({"expectedRevision":2,"reason":"repeat"})
        )
        .await?
        .is_none()
    );
    assert_eq!(
        repo.create_grant(&owner, &pending_id, &grant_input).await?["status"],
        "unavailable"
    );
    let worker = "fixture-worker";
    let at = chrono::Utc::now();
    database.query("INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Fixture','darwin','arm64',$3,$3)",&[&worker,&owner,&at]).await?;
    let worker_id = Uuid::new_v4().to_string();
    let worker_input = json!({"id":worker_id,"kind":"worker","workerId":worker,"label":null,"publicKey":initial["initialClient"]["publicKey"]});
    assert!(
        repo.create_principal(&owner, &worker_input, None)
            .await?
            .is_none()
    );
    assert!(
        repo.create_principal(&other, &worker_input, Some(worker))
            .await?
            .is_none()
    );
    assert_eq!(
        repo.create_principal(&owner, &worker_input, Some(worker))
            .await?
            .unwrap()["state"],
        "pending"
    );
    repo.revoke_principal(
        &owner,
        &worker_id,
        &json!({"expectedRevision":1,"reason":"replace development principal"}),
    )
    .await?
    .unwrap();
    let credential_id = Uuid::new_v4().to_string();
    let expired = at - chrono::Duration::seconds(1);
    database.query("INSERT INTO worker_credentials(id,owner_id,worker_id,secret_hash,expires_at) VALUES($1,$2,$3,'synthetic-hash',$4)",&[&credential_id,&owner,&worker,&expired]).await?;
    let mut worker_input = worker_input;
    let worker_id = Uuid::new_v4().to_string();
    worker_input["id"] = json!(worker_id);
    assert!(
        repo.create_principal(&owner, &worker_input, None)
            .await?
            .is_none()
    );
    database
        .query(
            "UPDATE worker_credentials SET expires_at=NULL WHERE id=$1",
            &[&credential_id],
        )
        .await?;
    repo.create_principal(&owner, &worker_input, None)
        .await?
        .unwrap();
    repo.approve_principal(&owner, &worker_id, 1)
        .await?
        .unwrap();
    let worker_grant = &fixtures["encryptionKeyGrantCreateSchema"][1];
    assert_eq!(
        repo.create_grant(&owner, &worker_id, worker_grant).await?["status"],
        "created"
    );
    let mut replacement = worker_input.clone();
    replacement["id"] = json!(initial_id);
    assert!(
        repo.replace_worker_principal(&owner, worker, &replacement)
            .await
            .is_err()
    );
    assert_eq!(
        repo.find_worker_principal(&owner, worker, None)
            .await?
            .unwrap()["id"],
        worker_id
    );
    assert_eq!(
        repo.active_grants(&owner, &worker_id).await?["grants"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let replacement_id = Uuid::new_v4().to_string();
    replacement["id"] = json!(replacement_id);
    assert_eq!(
        repo.replace_worker_principal(&owner, worker, &replacement)
            .await?
            .unwrap()["state"],
        "pending"
    );
    assert_eq!(
        repo.find_worker_principal(&owner, worker, Some(&worker_id))
            .await?
            .unwrap()["revokedReason"],
        "worker encryption identity rotated"
    );
    assert_eq!(
        repo.active_grants(&owner, &worker_id).await?["status"],
        "unavailable"
    );
    assert_eq!(
        repo.find_worker_principal(&owner, worker, None)
            .await?
            .unwrap()["id"],
        replacement_id
    );
    Ok(
        json!({"owner":owner,"profile":repo.get_profile(&owner).await?,"principals":repo.list_principals(&owner).await?,"initialGrants":repo.active_grants(&owner,initial_id).await?}),
    )
}

async fn retained(database: Arc<Database>, snapshot: &Value) -> Result<()> {
    assert_eq!(migrate(&database).await?, 0);
    let repo = EncryptionRepository::new(database.clone());
    let owner = snapshot["owner"].as_str().unwrap();
    assert_eq!(repo.get_profile(owner).await?.unwrap(), snapshot["profile"]);
    assert_eq!(
        json!(repo.list_principals(owner).await?),
        snapshot["principals"]
    );
    let initial = snapshot["initialGrants"]["grants"][0]["principalId"]
        .as_str()
        .unwrap();
    assert_eq!(
        repo.active_grants(owner, initial).await?,
        snapshot["initialGrants"]
    );
    database.close().await
}
#[tokio::test]
async fn native_registry_transactions_ownership_and_retained_state() -> Result<()> {
    if let Ok(phase) = std::env::var("CANTRIP_REGISTRY_PHASE") {
        let root = PathBuf::from(std::env::var("CANTRIP_REGISTRY_ROOT")?);
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
                "native_registry_transactions_ownership_and_retained_state",
                "--nocapture",
            ])
            .env("CANTRIP_REGISTRY_PHASE", phase)
            .env("CANTRIP_REGISTRY_ROOT", root.path())
            .kill_on_drop(true)
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "Native registry {phase} failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}
#[tokio::test]
async fn postgres_registry_transactions_and_retained_state() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(
        std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR").context("registry PostgreSQL binaries")?,
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
