use anyhow::Result;
use cantrip_server::{
    auth::{crypto, repository::AuthRepository},
    chats::{Repository, execution_lanes::LaneRepository, managed_console::permission_profile},
    database::Database,
    migrations::migrate,
    wire::{self, Value, value::json},
};
use std::sync::Arc;

fn envelope() -> Value {
    json!({
        "version": 1, "algorithm":"AES-256-GCM", "keyRevision":1,
        "nonce": "AAAAAAAAAAAAAAAA", "ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"
    })
}

fn create(id: &str) -> Result<Value> {
    wire::parse(
        "councilAgentCreateSchema",
        Some(&json!({
            "id":id,
            "titleProtection":json!({
                "classification":json!({"recordKind":"chat"}),
                "protectedLabel":json!({"formatVersion":1,"keyRevision":1,"envelope":envelope()})
            }),
            "protectedRole":envelope()
        })),
    )
    .map_err(|error| anyhow::anyhow!("Council creation fixture: {error:?}"))
}

#[tokio::test]
async fn council_roster_owns_a_single_worker_and_separate_conversations() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let database = Arc::new(Database::pglite(&temp.path().join("database")).await?);
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
    auth.settings(&owner).await?;
    auth.settings(&other).await?;
    let caps = serde_json::json!({"scratch":{
        "provision":true,"resolve":true,"archive":true,"restore":true,"remove":true,
        "reconcile":true,"routingHandles":true
    }});
    database.query(
        "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,standalone_chat_capabilities) VALUES
         ('alpha',$1,'Alpha','linux','x64',now(),now(),$3),
         ('beta',$1,'Beta','linux','x64',now(),now(),$3),
         ('foreign',$2,'Foreign','linux','x64',now(),now(),$3)",
        &[&owner,&other,&caps],
    ).await?;
    database.query(
        "UPDATE user_settings SET default_worker_id='beta',default_council_permission_profile_id=':read-only' WHERE user_id=$1",
        &[&owner],
    ).await?;
    let repository = Repository::new(database.clone());
    let a = "9c50384b-e803-4e6b-8444-9e1811572461";
    let b = "b65838ea-26ec-44bd-afea-355c31afed8b";
    let c = "91b166c5-ae2a-4192-a660-abce320f21bb";
    let (one, two) = tokio::join!(
        repository.create_council_agent(&owner, create(a)?, |_| true),
        repository.create_council_agent(&owner, create(b)?, |_| true)
    );
    let (one, two) = (one?, two?);
    assert_eq!(
        (one["workerId"].as_str(), two["workerId"].as_str()),
        (Some("beta"), Some("beta"))
    );
    assert_ne!(one["primary"], two["primary"]);
    for value in [&one, &two] {
        assert!(wire::parse("councilAgentWireSummarySchema", Some(value)).is_ok());
        assert_eq!(value["scratchStatus"], "provisioning");
    }
    assert!(repository.list_standalone(&owner).await?.is_empty());
    assert!(repository.council_agents(&other).await?.is_empty());
    assert_eq!(repository.council_agents(&owner).await?.len(), 2);
    let blocked = repository
        .create_council_agent(&other, create(c)?, |_| false)
        .await;
    assert!(blocked.is_err());

    database
        .query(
            "UPDATE user_settings SET default_worker_id='alpha' WHERE user_id=$1",
            &[&owner],
        )
        .await?;
    let queued = repository
        .create_council_agent(&owner, create(c)?, |_| false)
        .await?;
    assert_eq!(queued["workerId"], "beta");
    assert_eq!(queued["primary"], false);

    for target in [a, b, c] {
        let rows = database
            .query(
                "SELECT c.context_kind,c.permission_profile_id,r.worker_id,j.state
             FROM chats c JOIN standalone_chat_roots r ON r.id=c.active_scratch_root_id
             JOIN standalone_chat_root_jobs j ON j.root_id=r.id
             WHERE c.id=$1",
                &[&target],
            )
            .await?;
        let row = &rows[0];
        assert_eq!(row.get::<&str>(0)?, "council");
        assert_eq!(row.get::<&str>(1)?, ":read-only");
        assert_eq!(row.get::<&str>(2)?, "beta");
        assert_eq!(row.get::<&str>(3)?, "queued");
    }
    for id in [a, b] {
        let changed = repository
            .update_council_agent(&owner, id, json!({"expectedRevision":1,"primary":true}))
            .await?;
        assert_eq!(changed["revision"], 2);
        assert_eq!(changed["primary"], true);
    }
    assert!(
        repository
            .update_council_agent(&owner, a, json!({"expectedRevision":1,"primary":false}))
            .await
            .is_err()
    );
    assert!(
        repository
            .update_council_agent(&other, a, json!({"expectedRevision":2,"primary":false}))
            .await
            .is_err()
    );
    assert!(
        repository
            .create_council_agent(&owner, create(a)?, |_| true)
            .await
            .is_err()
    );
    assert_eq!(repository.council_agents(&owner).await?.len(), 3);
    let before = repository.execution_context(&owner, a).await?.unwrap();
    assert_eq!(before["status"], "offline");
    assert_eq!(before["councilAgent"]["protectedRole"], envelope());
    assert!(repository.execution_context(&other, a).await?.is_none());

    let path_handle = "ctrr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    database.query(
        "UPDATE standalone_chat_roots SET status='ready', protected_path_handle=$2 WHERE chat_id=$1",
        &[&a, &path_handle],
    ).await?;
    database.query(
        "UPDATE user_settings SET default_council_permission_profile_id=':workspace' WHERE user_id=$1",
        &[&owner],
    ).await?;
    let lanes = LaneRepository::new(database.clone());
    let started = lanes
        .start(&owner, a, "user", "Test native Council lane")
        .await?
        .unwrap();
    assert_eq!(started["status"], "running");
    assert_eq!(started["workerId"], "beta");
    assert_eq!(started["cwd"], path_handle);
    assert_eq!(permission_profile(&started)["effectiveId"], ":workspace");
    assert_eq!(started["councilAgent"]["primary"], true);
    assert_eq!(started["councilAgent"]["protectedRole"], envelope());
    assert!(
        lanes
            .start(&owner, a, "user", "Second active Council lane")
            .await
            .is_err()
    );
    database.close().await?;
    Ok(())
}
