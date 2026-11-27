mod support;

use anyhow::Result;
use cantrip_server::{
    auth::{crypto, repository::AuthRepository},
    chats::{managed_console::ManagedConsole, routing::ModelRouting},
    database::Database,
    migrations::migrate,
    native_handoffs::Repository as Handoffs,
    relay::RelayQuotas,
    settings::{
        catalog_runtime::{CatalogRequest, CatalogRuntime},
        repository::SettingsRepository,
    },
    wire::Value,
    workers::{
        bridge::{BridgeStats, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
        repository::WorkerRepository,
    },
};
use futures::future::BoxFuture;
use serde_json::json;
use std::{sync::Arc, time::Duration};

struct CatalogWorker;

impl CommandDelegate for CatalogWorker {
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: 1,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }

    fn is_connected(&self, worker: &str) -> bool {
        worker == "fixture-worker"
    }

    fn request(
        self: Arc<Self>,
        _: String,
        worker: String,
        command: Value,
        _: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        Box::pin(async move {
            assert_eq!(worker, "fixture-worker");
            assert_eq!(command["type"], "claude-code.account.inspect");
            assert_eq!(command["section"], "models");
            assert_eq!(command["serverId"], "catalog-fixture");
            Ok(Some(Value::from_serialize(&json!({"models":[
                {"id":"sonnet","name":"Claude Sonnet","description":null,"efforts":["high"]}
            ]}))))
        })
    }
}

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
    let fixtures = support::security_fixtures(&[
        "workerHeartbeatSchema",
        "encryptedModelProviderAccountCreateSchema",
    ])?;
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
    let label = &fixtures["encryptedModelProviderAccountCreateSchema"][0]["protectedLabel"];
    let make_account = |id: &str, worker: &str| {
        Value::from_serialize(&json!({
            "id":id, "protectedLabel":label, "boundWorkerId":worker
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

    let catalog_owner = owner.clone();
    let commands = LimitedCommandBus::with_parts(
        Arc::new(CatalogWorker),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 10, 10),
        CommandLimits {
            account_concurrency: 10,
            account_rate_per_minute: 100,
            worker_concurrency: 10,
            worker_rate_per_minute: 100,
        },
        Arc::new(move |_| {
            let owner = catalog_owner.clone();
            Box::pin(async move { Ok(Some(owner)) })
        }),
        Arc::new(|| 0),
    );
    let catalog = CatalogRuntime::new(
        repository.clone(),
        commands.clone(),
        "catalog-fixture".into(),
    )?;
    let request = CatalogRequest {
        owner: owner.clone(),
        provider: provider.into(),
        worker: None,
        force: false,
        account: None,
        quota_trigger: None,
    };
    let inventory = catalog.load(request.clone()).await?.unwrap();
    assert_eq!(inventory["models"][0]["nativeModelId"], "sonnet");
    assert_eq!(inventory["models"][0]["metadataSource"], "claude-code");
    assert_eq!(inventory["availability"].as_array().unwrap().len(), 2);
    assert!(
        repository
            .get_model_runtimes(&owner, None, None, false, Some(provider))
            .await?
            .iter()
            .any(|runtime| runtime["model"]["profileName"] == "Claude Sonnet"
                && runtime["model"]["name"] == "sonnet")
    );

    assert!(
        repository
            .delete_provider_account(&owner, provider, &first)
            .await?
    );
    let inventory = catalog.load(request).await?.unwrap();
    assert_eq!(inventory["availability"].as_array().unwrap().len(), 1);
    assert_eq!(inventory["availability"][0]["providerAccountId"], second);
    heartbeat["workerId"] = json!("alternate-worker");
    workers.record_worker(&owner, &heartbeat).await?;
    let remote = uuid::Uuid::new_v4().to_string();
    repository
        .create_provider_account(&owner, provider, &make_account(&remote, "alternate-worker"))
        .await?
        .unwrap();
    let state = json!({
        "chatId":"fixture-chat","revision":"1","desiredRevision":"0","desired":null,
        "desiredStatus":null,"pending":[],"effective":null,
        "binding":{"chatId":"fixture-chat","workerId":"fixture-worker","threadId":"thread",
            "projectId":null,"contextKind":"standalone","placementId":"fixture-root",
            "modelRouteId":"fixture-source-route","providerAccountId":null,
            "bindingId":"binding","runtimeGeneration":"runtime","nativeEpoch":"epoch"}
    })
    .to_string();
    let fixture_owner = owner.clone();
    database.transaction(move |tx| Box::pin(async move {
        tx.query("INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('fixture-source-provider',$1,'Source','openai-compatible','https://example.invalid/v1')", &[&fixture_owner]).await?;
        tx.query("INSERT INTO model_profiles(id,owner_id,name) VALUES('fixture-source-model',$1,'Source model')", &[&fixture_owner]).await?;
        tx.query("INSERT INTO model_routes(id,model_id,provider_id,model_name) VALUES('fixture-source-route','fixture-source-model','fixture-source-provider','source')", &[]).await?;
        tx.query("INSERT INTO chats(id,owner_id,context_kind,active_worker_id,active_scratch_root_id,worktree_mode,model_id,protected_label) VALUES('fixture-chat',$1,'standalone','fixture-worker','fixture-root',NULL,'fixture-source-model','{}'::jsonb)", &[&fixture_owner]).await?;
        tx.query("INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES('fixture-root','fixture-chat',$1,'fixture-worker','ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ready')", &[&fixture_owner]).await?;
        tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,scratch_root_id,codex_thread_id,model_route_id,status) VALUES('fixture-runtime','fixture-chat','fixture-worker','fixture-root','thread','fixture-source-route','ready')", &[]).await?;
        tx.query("INSERT INTO native_settings_states(chat_id,state) VALUES('fixture-chat',$1::text::jsonb)", &[&state]).await?;
        Ok(())
    })).await?;
    let handoffs = Handoffs::new(database.clone());
    let inventory = handoffs.inventory(&owner, "fixture-chat").await?.unwrap();
    let claude = inventory["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == provider)
        .unwrap();
    assert_eq!(claude["requiresAccount"], true);
    let accounts = claude["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0]["id"], second);
    let route = &claude["models"].as_array().unwrap()[0]["routeId"];
    let begin = |account: Option<&str>| {
        cantrip_server::wire::value::json!({
            "operationId":uuid::Uuid::new_v4().to_string(),"bindingId":"binding",
            "targetModelRouteId":route,"targetProviderAccountId":account
        })
    };
    assert!(
        handoffs
            .begin(&owner, "fixture-chat", &begin(None))
            .await
            .is_err()
    );
    assert!(
        handoffs
            .begin(&owner, "fixture-chat", &begin(Some(&remote)))
            .await
            .is_err()
    );
    let handoff = handoffs
        .begin(&owner, "fixture-chat", &begin(Some(&second)))
        .await?;
    assert_eq!(handoff["targetProviderAccountId"], second);
    let routing = ModelRouting::with_dependencies(
        database.clone(),
        Arc::new(|_| true),
        Arc::new(|_, _| Box::pin(async { Ok(false) })),
        Arc::new(|| 0.0),
    );
    let console = ManagedConsole::new(database.clone(), routing, commands);
    let target = handoffs
        .configuration(&owner, &handoff, "destination", &console)
        .await?;
    assert_eq!(target["configuration"]["provider"]["kind"], "claude-code");
    assert_eq!(target["configuration"]["provider"]["accountId"], second);
    assert_eq!(&target["configuration"]["model"]["routeId"], route);
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
        2
    );
    database.close().await?;
    Ok(())
}
