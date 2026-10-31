use super::*;
#[cfg(debug_assertions)]
fn observe(action: &str, entry: &Value, changed: bool, due: Option<i64>) {
    if std::env::var("CANTRIP_TEST_HISTORY_OBSERVATIONS").as_deref() != Ok("true") {
        return;
    }
    use crate::wire::value::json;
    let mut event = json!({"event":"fixture.native-history.publication.persisted","action":action,"identity":Value::Array(vec![entry["ownerId"].clone(),entry["bindingId"].clone(),entry["commitId"].clone()]),"changed":changed});
    if let Some(at) = due {
        event["dueMs"] = json!(at);
    }
    eprintln!("{}", event.stringify());
}
#[cfg(not(debug_assertions))]
fn observe(_action: &str, _entry: &Value, _changed: bool, _due: Option<i64>) {}

impl Repository {
    pub async fn pending_publications(&self, limit: i64) -> Result<Vec<Value>> {
        self.database.query("SELECT jsonb_build_object('commitId',p.commit_id,'bindingId',p.binding_id,'ownerId',b.owner_id,'workerId',b.worker_id,'chatId',b.chat_id,'attempts',p.attempts)::text FROM native_history_publications p INNER JOIN native_history_bindings b ON b.id=p.binding_id INNER JOIN chats c ON c.id=b.chat_id AND c.owner_id=b.owner_id WHERE p.next_attempt_at<=$1 ORDER BY p.next_attempt_at ASC,p.commit_id ASC LIMIT $2",&[&crate::auth::now(),&limit]).await?.iter().map(|r|Ok(serde_json::from_str(&r.get::<String>(0)?)?)).collect()
    }
    pub async fn acknowledge_publication(&self, entry: &Value) -> Result<bool> {
        let commit = text(&entry["commitId"])?;
        let binding = text(&entry["bindingId"])?;
        let owner = text(&entry["ownerId"])?;
        let worker = text(&entry["workerId"])?;
        let chat = text(&entry["chatId"])?;
        let changed=self.database.query("DELETE FROM native_history_publications p WHERE p.commit_id=$1 AND p.binding_id=$2 AND EXISTS(SELECT 1 FROM native_history_bindings b INNER JOIN chats c ON c.id=b.chat_id AND c.owner_id=b.owner_id WHERE b.id=$2 AND b.owner_id=$3 AND b.worker_id=$4 AND b.chat_id=$5) RETURNING p.commit_id",&[&commit,&binding,&owner,&worker,&chat]).await?.len()==1;
        observe("ack", entry, changed, None);
        Ok(changed)
    }
    pub async fn defer_publication(
        &self,
        entry: &Value,
        due: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool> {
        let commit = text(&entry["commitId"])?;
        let binding = text(&entry["bindingId"])?;
        let owner = text(&entry["ownerId"])?;
        let worker = text(&entry["workerId"])?;
        let chat = text(&entry["chatId"])?;
        let changed=self.database.query("UPDATE native_history_publications p SET next_attempt_at=$6,attempts=p.attempts+1 WHERE p.commit_id=$1 AND p.binding_id=$2 AND EXISTS(SELECT 1 FROM native_history_bindings b INNER JOIN chats c ON c.id=b.chat_id AND c.owner_id=b.owner_id WHERE b.id=$2 AND b.owner_id=$3 AND b.worker_id=$4 AND b.chat_id=$5) RETURNING p.commit_id",&[&commit,&binding,&owner,&worker,&chat,&due]).await?.len()==1;
        observe("defer", entry, changed, Some(due.timestamp_millis()));
        Ok(changed)
    }
}
