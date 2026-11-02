use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    migrations::migrate,
    project_alerts::Repository,
    wire::{self, Value},
};
use serde_json::json;
use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};

fn event(source: &str, revision: i32, status: &str) -> Value {
    Value::from_serialize(
        &json!({"projectId":"project","chatId":"chat","source":"interaction","sourceId":source,"episodeId":"request","sourceRevision":revision,"kind":"permission","status":status,"target":{"kind":"interaction","chatId":"chat","requestId":source},"occurredAt":"2026-11-02T12:00:00.000Z"}),
    )
}
#[tokio::test]
async fn native_projection_is_idempotent_scoped_and_terminal() -> Result<()> {
    let dir = std::env::temp_dir().join(format!("cantrip-alert-native-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let database = Arc::new(match std::env::var("CANTRIP_ALERT_TEST_DATABASE_URL") {
        Ok(url) => Database::postgres_url(&url).await?,
        Err(_) => Database::pglite(&dir).await?,
    });
    let result: Result<()> = async {
        migrate(&database).await?;
        database.execute("INSERT INTO users(id,kind,display_name) VALUES ('owner','anonymous','Owner'); INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('project','owner','{}'::jsonb,'A'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('worker','owner','Worker','linux','x64',now(),now()); INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('source','project','worker','/qa','/qa'); INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin) VALUES ('tree','source','worker','Primary','/qa','/qa','cantrip'); INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id) VALUES ('chat','owner','project','{}'::jsonb,'tree')").await?;
        let mut changes = database.listen("cantrip_project_alerts").await?;
        let repository = Repository::new(database.clone());
        let first = repository.apply("owner",&event("a",1,"open")).await?.context("First alert")?;
        let (_,payload) = tokio::time::timeout(Duration::from_secs(3),changes.recv()).await??;
        let change: serde_json::Value = serde_json::from_str(&payload)?;
        assert_eq!(change,json!({"ownerId":"owner","projectId":"project"}));
        assert_eq!(repository.apply("owner",&event("a",1,"open")).await?.unwrap(),first);
        repository.apply("owner",&event("a",3,"resolved")).await?;
        assert_eq!(repository.apply("owner",&event("a",4,"open")).await?.unwrap()["status"].as_str(),Some("resolved"));
        repository.apply("owner",&event("b",2,"resolved")).await?;
        assert_eq!(repository.apply("owner",&event("b",1,"open")).await?.unwrap()["status"].as_str(),Some("resolved"));
        for id in ["c","d","e"] { repository.apply("owner",&event(id,1,"open")).await?; }
        let page = repository.list("owner","project",&Value::from_serialize(&json!({"limit":2}))).await?.unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(),2);
        let next = repository.list("owner","project",&Value::from_serialize(&json!({"limit":2,"after":page["nextCursor"]}))).await?.unwrap();
        assert_eq!(next["items"].as_array().unwrap().len(),1);
        assert!(next["nextCursor"].is_null());
        assert_eq!(repository.counts("owner").await?, Value::from_serialize(&json!([{"projectId":"project","count":3}])));
        assert!(repository.counts("other").await?.as_array().unwrap().is_empty());
        assert!(repository.list("other","project",&Value::from_serialize(&json!({}))).await?.is_none());
        assert!(repository.apply("other",&event("foreign",1,"open")).await?.is_none());
        database.execute("UPDATE chats SET archived_at=now() WHERE id='chat'").await?;
        assert!(repository.counts("owner").await?.as_array().unwrap().is_empty());
        assert!(repository.apply("owner",&event("archived",1,"open")).await?.is_none());
        Ok(())
    }.await;
    database.close().await?;
    std::fs::remove_dir_all(dir)?;
    result
}
#[test]
fn alert_contracts_match_the_protocol_oracle() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let output = Command::new("node")
        .args(["scripts/server-rust/project-alert-oracle.mjs"])
        .current_dir(root)
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for case in cases.as_array().unwrap() {
        let parsed = wire::parse(case["schema"].as_str().unwrap(), Some(&case["input"]));
        assert_eq!(
            parsed.is_ok(),
            case["success"].as_bool().unwrap(),
            "{case:?}"
        );
        if let Ok(value) = parsed {
            assert_eq!(value, case["data"], "{case:?}");
        }
    }
    Ok(())
}
