use anyhow::Result;
use cantrip_server::{
    database::Database, migrations::migrate, project_alerts::Repository, wire::Value,
};
use serde_json::json;
use std::sync::Arc;
fn observation(generation: &str, revision: i32, status: Option<&str>) -> Value {
    let opaque = json!({"formatVersion":1,"keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"A".repeat(16),"ciphertext":"A".repeat(22)}});
    Value::from_serialize(
        &json!({"chatId":"a3-chat","workerId":"a3-worker","threadId":"a3-thread","generation":generation,"revision":revision,"snapshot":{"kind":"chat-encrypted","goal":status.map(|status|json!({"threadId":"a3-thread","status":status,"tokenBudget":null,"tokensUsed":1,"timeUsedSeconds":1,"createdAt":1,"updatedAt":2,"protectedObjective":{"id":uuid::Uuid::new_v4().to_string(),"classification":{"role":"user","mode":"goal","attachmentIds":[]},"protectedContent":opaque,"idempotencyKey":"goal"}}))}}),
    )
}
async fn count(alerts: &Repository) -> Result<usize> {
    Ok(alerts
        .list("a3-owner", "a3-project", &Value::from_serialize(&json!({})))
        .await?
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .len())
}
#[tokio::test]
async fn native_task_goal_and_agent_sources_are_scoped_and_terminal() -> Result<()> {
    let dir =
        std::env::temp_dir().join(format!("cantrip-alert-workflows-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let db = Arc::new(match std::env::var("CANTRIP_ALERT_TEST_DATABASE_URL") {
        Ok(url) => Database::postgres_url(&url).await?,
        Err(_) => Database::pglite(&dir).await?,
    });
    let result:Result<()>=async {
 migrate(&db).await?;
 db.execute("INSERT INTO users(id,kind,display_name) VALUES ('a3-owner','anonymous','Owner'); INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES ('a3-project','a3-owner','{}','A'); INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES ('a3-worker','a3-owner','Worker','linux','x64',now(),now()); INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES ('a3-source','a3-project','a3-worker','/qa','/qa'); INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,origin) VALUES ('a3-tree','a3-source','a3-worker','Primary','/qa','/qa','cantrip'); INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id,experience) VALUES ('a3-chat','a3-owner','a3-project','{}','a3-tree','task'); INSERT INTO tasks(chat_id,state,has_plan,has_questions,planning_round,protected_content) VALUES ('a3-chat','review',true,true,1,'{}')").await?;
 let alerts=Repository::new(db.clone());assert_eq!(count(&alerts).await?,1);
 db.execute("UPDATE tasks SET state='implementing',row_version=row_version+1 WHERE chat_id='a3-chat'").await?;assert_eq!(count(&alerts).await?,0);
 db.execute("UPDATE tasks SET state='blocked',last_error='{\"code\":\"goal-blocked\",\"operationKind\":\"implementation\",\"occurredAt\":\"2026-11-02T12:00:00.000Z\"}',row_version=row_version+1 WHERE chat_id='a3-chat'").await?;assert_eq!(count(&alerts).await?,1);
 db.execute("UPDATE tasks SET state='complete',row_version=row_version+1 WHERE chat_id='a3-chat'; DELETE FROM tasks WHERE chat_id='a3-chat'; UPDATE chats SET experience='agent' WHERE id='a3-chat'; INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES ('a3-runtime','a3-chat','a3-worker','a3-tree','a3-thread')").await?;assert_eq!(count(&alerts).await?,0);
 let generation=uuid::Uuid::new_v4().to_string();alerts.register_goal_worker("a3-owner","a3-worker",&generation).await?;
 alerts.observe_goal("a3-owner",&observation(&generation,1,Some("paused"))).await?;assert_eq!(count(&alerts).await?,0);
 let blocked=observation(&generation,2,Some("blocked"));alerts.observe_goal("a3-owner",&blocked).await?;alerts.observe_goal("a3-owner",&blocked).await?;assert_eq!(count(&alerts).await?,1);
 alerts.observe_goal("a3-owner",&observation(&generation,3,Some("active"))).await?;alerts.observe_goal("a3-owner",&blocked).await?;assert_eq!(count(&alerts).await?,0);
 alerts.observe_goal("a3-owner",&observation(&generation,4,Some("usageLimited"))).await?;assert_eq!(count(&alerts).await?,1);
 let restarted=uuid::Uuid::new_v4().to_string();alerts.register_goal_worker("a3-owner","a3-worker",&restarted).await?;
 assert_eq!(alerts.observe_goal("a3-owner",&observation(&generation,5,None)).await?["reason"],"retired-worker");
 alerts.observe_goal("a3-owner",&observation(&restarted,1,None)).await?;assert_eq!(count(&alerts).await?,0);
 db.execute("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES ('a3-lane','a3-chat','a3-tree','a3-worker','agent',false,'Qualification','active',now(),'a3-runtime'); UPDATE chats SET status='running' WHERE id='a3-chat'").await?;
 let context=Value::from_serialize(&json!({"projectId":"a3-project","chatId":"a3-chat","workerId":"a3-worker","executionLaneId":"a3-lane"}));
 let key=uuid::Uuid::new_v4().to_string();let opaque=json!({"formatVersion":1,"keyRevision":1,"domain":"alert-content","envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"A".repeat(16),"ciphertext":"A".repeat(22)}});
 let mutation=|revision,status|Value::from_serialize(&json!({"key":key,"revision":revision,"status":status,"kind":"blocked","protectedDetail":{"context":{"domain":"alert-content","serverId":"server","workerId":"a3-worker","scopeId":"a3-chat","operationId":key,"operation":"agent-alert","direction":"stored","sequence":revision},"protectedContent":opaque}}));
 alerts.apply_agent("a3-owner",&context,&mutation(1,"open")).await?;assert_eq!(count(&alerts).await?,1);
 assert!(alerts.apply_agent("foreign",&context,&mutation(2,"resolved")).await?.is_none());assert_eq!(count(&alerts).await?,1);
 alerts.apply_agent("a3-owner",&context,&mutation(2,"resolved")).await?;alerts.apply_agent("a3-owner",&context,&mutation(3,"open")).await?;assert_eq!(count(&alerts).await?,0);
 Ok(())
 }.await;
    db.close().await?;
    std::fs::remove_dir_all(dir)?;
    result
}
