mod support;

use anyhow::Result;
use cantrip_server::{
    auth::{crypto, repository::AuthRepository},
    database::Database,
    migrations::migrate,
    settings::repository::SettingsRepository,
    wire::Value,
    workers::repository::WorkerRepository,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn claude_profiles_are_bound_to_one_owned_worker_and_store_only_status() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = Arc::new(Database::pglite(directory.path()).await?);
    migrate(&database).await?;
    let auth = AuthRepository::new(database.clone());
    let owner = auth.local_user().await?.id;
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
    let workers = WorkerRepository::new(database.clone());
    let fixtures = support::security_fixtures(&["workerHeartbeatSchema"])?;
    let mut heartbeat = fixtures["workerHeartbeatSchema"][0].clone();
    heartbeat["workerId"] = json!("fixture-worker");
    workers.record_worker(&owner, &heartbeat).await?;
    heartbeat["workerId"] = json!("other-worker");
    workers.record_worker(&other, &heartbeat).await?;

    let repository = SettingsRepository::new(database.clone());
    let input = Value::from_serialize(&json!({
        "name":"Claude Code", "kind":"claude-code", "baseUrl":"https://claude-code.invalid"
    }));
    let provider = repository.create_model_provider(&owner, &input).await?;
    let provider = provider["id"].as_str().unwrap();
    assert!(
        repository
            .create_model_provider(&owner, &input)
            .await
            .is_err()
    );
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let make_account = |id: &str, worker: &str| {
        Value::from_serialize(&json!({
            "id":id, "protectedLabel":{"fixture":"opaque"}, "boundWorkerId":worker
        }))
    };
    assert!(
        repository
            .create_provider_account(&owner, provider, &make_account(&first, "other-worker"))
            .await
            .is_err()
    );
    for id in [&first, &second] {
        let account = repository
            .create_provider_account(&owner, provider, &make_account(id, "fixture-worker"))
            .await?
            .unwrap();
        assert_eq!(account["boundWorkerId"], "fixture-worker");
        assert_eq!(
            repository
                .claude_account_worker(&owner, provider, id, true)
                .await?
                .as_deref(),
            Some("fixture-worker")
        );
        assert!(
            repository
                .claude_account_worker(&other, provider, id, true)
                .await?
                .is_none()
        );
        assert!(
            repository
                .get_provider_account_credential(&owner, provider, id)
                .await?
                .is_none()
        );
    }
    assert!(
        repository
            .delete_model_provider(&owner, provider)
            .await
            .is_err()
    );
    repository
        .record_claude_account_status(&owner, provider, &first, "fixture-worker", "signed-in")
        .await?;
    repository
        .record_claude_account_status(&owner, provider, &first, "other-worker", "signed-out")
        .await?;
    repository
        .reorder_provider_accounts(
            &owner,
            provider,
            &[second.clone().into(), first.clone().into()],
        )
        .await?;
    let accounts = repository
        .list_provider_accounts(&owner, provider)
        .await?
        .unwrap();
    assert_eq!(accounts[0]["id"], second);
    assert_eq!(accounts[0]["workerBindings"], json!([]));
    assert_eq!(accounts[1]["workerBindings"][0]["authState"], "signed-in");
    assert!(
        repository
            .delete_provider_account(&owner, provider, &first)
            .await?
    );
    assert!(
        repository
            .claude_account_worker(&owner, provider, &first, true)
            .await?
            .is_none()
    );
    assert_eq!(
        repository
            .list_provider_accounts(&owner, provider)
            .await?
            .unwrap()
            .len(),
        1
    );
    database.close().await?;
    Ok(())
}
