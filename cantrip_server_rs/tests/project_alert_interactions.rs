use anyhow::{Context, Result};
use cantrip_server::{
    agent_interactions,
    database::{Database, Executor},
    migrations::migrate,
    project_alerts,
    wire::Value,
};
use serde_json::json;
use std::sync::Arc;

fn opaque() -> serde_json::Value {
    json!({"formatVersion":1,"keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"A".repeat(16),"ciphertext":"A".repeat(22)}})
}
fn request(key: &str, kind: &str, turn: Option<&str>) -> Value {
    Value::from_serialize(
        &json!({"requestKey":format!("alerts2-{key}"),"projectId":"alerts2-project","provenance":{"chatId":"alerts2-chat","threadId":"thread","turnId":turn,"itemId":null,"executionLaneId":null,"workerId":"alerts2-worker"},"classification":{"kind":kind},"protectedPayload":opaque(),"expiresAt":null}),
    )
}
async fn count(repository: &project_alerts::Repository) -> Result<usize> {
    Ok(repository
        .list(
            "alerts2-owner",
            "alerts2-project",
            &Value::from_serialize(&json!({})),
        )
        .await?
        .context("Alert page")?["items"]
        .as_array()
        .context("Alert items")?
        .len())
}

#[tokio::test]
async fn actual_native_requests_drive_alert_lifecycles_without_chat_ui() -> Result<()> {
    let dir = std::env::temp_dir().join(format!(
        "cantrip-alert-interactions-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir)?;
    let db = Arc::new(match std::env::var("CANTRIP_ALERT_TEST_DATABASE_URL") {
        Ok(url) => Database::postgres_url(&url).await?,
        Err(_) => Database::pglite(&dir).await?,
    });
    let result: Result<()> = async {
        migrate(&db).await?;
        db.execute("INSERT INTO users(id,kind,display_name) VALUES ('alerts2-owner','anonymous','Owner'); INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('alerts2-project','alerts2-owner','{}','A'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('alerts2-worker','alerts2-owner','Worker','linux','x64',now(),now()); INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('alerts2-source','alerts2-project','alerts2-worker','/qa','/qa'); INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin) VALUES ('alerts2-tree','alerts2-source','alerts2-worker','Primary','/qa','/qa','cantrip'); INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id) VALUES ('alerts2-chat','alerts2-owner','alerts2-project','{}','alerts2-tree')").await?;
        let requests=agent_interactions::Repository::new(Executor::Database(&db));
        let alerts=project_alerts::Repository::new(db.clone());
        let mut rows=Vec::new();
        for kind in ["commandExecution","fileChange","permissions","userInput","mcpElicitation"] {
            let input=request(kind,kind,None);
            let row=requests.record(&input,true).await?;
            assert_eq!(requests.record(&input,true).await?,row);
            rows.push(row);
        }
        let mut cua=request("cua","permissions",None);
        cua["provenance"]["owner"]=Value::from_serialize(&json!("computer-use"));
        cua["provenance"]["threadId"]=Value::Null;
        requests.record(&cua,true).await?;
        assert_eq!(count(&alerts).await?,6);
        let page=alerts.list("alerts2-owner","alerts2-project",&Value::from_serialize(&json!({}))).await?.unwrap();
        for row in page["items"].as_array().unwrap() {
            assert!(row["protectedDetail"].is_null());
            assert!(!row.stringify().contains("ciphertext"));
            assert_eq!(row["sourceId"],row["target"]["requestId"]);
        }
        let reply=Value::from_serialize(&json!({"idempotencyKey":"once","classification":{"kind":"commandExecution"},"protectedResponse":opaque()}));
        requests.resolve("alerts2-owner",rows[0]["id"].as_str().unwrap(),&reply,true,false).await?;
        requests.resolve("alerts2-owner",rows[0]["id"].as_str().unwrap(),&reply,true,false).await?;
        assert_eq!(count(&alerts).await?,5);
        db.execute("UPDATE agent_interaction_requests SET expires_at='2000-01-01' WHERE request_key='alerts2-userInput'").await?;
        assert_eq!(count(&alerts).await?,4);
        requests.interrupt("alerts2-chat",None).await?;
        assert_eq!(count(&alerts).await?,0);

        let archived=request("archived","fileChange",None);
        requests.record(&archived,true).await?;
        db.execute("UPDATE chats SET automation_paused=true WHERE id='alerts2-chat'").await?;
        assert_eq!(count(&alerts).await?,1);
        db.execute("UPDATE chats SET archived_at=now() WHERE id='alerts2-chat'").await?;
        assert_eq!(count(&alerts).await?,0);
        let late=request("late-archived","fileChange",None);
        requests.record(&late,true).await?;
        db.execute("UPDATE chats SET archived_at=NULL,automation_paused=false WHERE id='alerts2-chat'").await?;
        requests.record(&archived,true).await?;
        requests.record(&late,true).await?;
        assert_eq!(count(&alerts).await?,0);
        requests.record(&request("stopped","fileChange",None),true).await?;
        db.execute("UPDATE chats SET managed_autonomy_stopped=true WHERE id='alerts2-chat'").await?;
        assert_eq!(count(&alerts).await?,0);
        db.execute("UPDATE chats SET managed_autonomy_stopped=false WHERE id='alerts2-chat'").await?;

        db.execute("INSERT INTO native_history_bindings(id,owner_id,worker_id,chat_id,thread_id,project_id,worktree_id) VALUES ('alerts2-binding','alerts2-owner','alerts2-worker','alerts2-chat','thread','alerts2-project','alerts2-tree'); INSERT INTO native_history_turns(binding_id,turn_id,revision,ordinal,status,metadata,payload_digest) VALUES ('alerts2-binding','a',1,0,'inProgress','{}',repeat('a',64))").await?;
        requests.record(&request("turn-a","permissions",Some("a")),true).await?;
        requests.record(&request("turn-b","userInput",Some("b")),true).await?;
        assert_eq!(count(&alerts).await?,2);
        db.execute("UPDATE native_history_turns SET status='completed',revision=2 WHERE binding_id='alerts2-binding' AND turn_id='a'").await?;
        assert_eq!(count(&alerts).await?,1);
        requests.record(&request("delayed-turn-a","permissions",Some("a")),true).await?;
        assert_eq!(count(&alerts).await?,1);
        assert!(alerts.counts("unrelated").await?.as_array().unwrap().is_empty());
        db.execute("DELETE FROM chats WHERE id='alerts2-chat'").await?;
        assert_eq!(count(&alerts).await?,0);
        Ok(())
    }.await;
    db.close().await?;
    std::fs::remove_dir_all(dir)?;
    result
}
