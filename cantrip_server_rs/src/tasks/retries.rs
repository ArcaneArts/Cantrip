//! Operational retry accounting is separate from encrypted Task revisions.
use super::*;
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
enum Action {
    Note {
        key: String,
        kind: String,
        now: f64,
    },
    Reset,
    Clear,
    Claim {
        now: f64,
    },
    Finish {
        claim: String,
        failure: Option<Value>,
        now: f64,
    },
}
fn time(now: Option<f64>) -> f64 {
    now.unwrap_or_else(|| crate::auth::now().timestamp_millis() as f64)
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn list_candidates(&self, now: Option<f64>) -> Result<Vec<Value>> {
        let now = ryu_js::Buffer::new().format(time(now)).to_owned();
        self.database.query("SELECT json_build_object('ownerId',c.owner_id,'chatId',t.chat_id,'projectId',c.project_id)::text FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE c.archived_at IS NULL AND c.automation_paused=false AND p.task_scheduling_paused=false AND c.status NOT IN ('running','waiting-for-approval') AND NOT EXISTS (SELECT 1 FROM agent_interaction_requests i WHERE i.chat_id=c.id AND i.status='pending') AND ((t.state='failed' AND t.automatic_retry IS NULL AND t.last_error IS NOT NULL) OR (t.automatic_retry->>'status'='scheduled' AND (t.automatic_retry->>'dueAt')::double precision<=$1::text::double precision) OR (t.automatic_retry->>'status'='retrying' AND (t.automatic_retry->'claim'->>'expiresAt')::double precision<=$1::text::double precision)) ORDER BY t.updated_at ASC",&[&now]).await?.iter().map(|r|Ok(serde_json::from_str(&r.get::<String>(0)?)?)).collect()
    }
    async fn mutate(&self, owner: &str, chat: &str, action: Action) -> Result<Value> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            tx.query("SELECT id FROM users WHERE id=$1 LIMIT 1 FOR UPDATE",&[&owner]).await?;
            let row=one(Executor::Transaction(tx),"SELECT json_build_object('task',to_jsonb(t),'chat',to_jsonb(c),'project',to_jsonb(p))::text FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE t.chat_id=$1 AND c.owner_id=$2 AND c.archived_at IS NULL LIMIT 1 FOR UPDATE",&[&chat,&owner]).await?;
            let Some(row)=row else { return Ok(Value::Null); };
            let pending=!tx.query("SELECT id FROM agent_interaction_requests WHERE chat_id=$1 AND status='pending' LIMIT 1",&[&chat]).await?.is_empty();
            let (record,result)=apply(&row,pending,action)?;
            if record.stringify()!=row["task"]["automatic_retry"].stringify() {
                let record=(!record.is_null()).then(||record.stringify());
                tx.query("UPDATE tasks SET automatic_retry=$2::text::jsonb WHERE chat_id=$1",&[&chat,&record]).await?;
            }
            Ok(result)
        })).await
    }
    pub async fn note_failure(
        &self,
        owner: &str,
        chat: &str,
        key: &str,
        kind: &str,
        now: Option<f64>,
    ) -> Result<Value> {
        self.mutate(
            owner,
            chat,
            Action::Note {
                key: key.into(),
                kind: kind.into(),
                now: time(now),
            },
        )
        .await
    }
    pub async fn reset(&self, owner: &str, chat: &str) -> Result<Value> {
        self.mutate(owner, chat, Action::Reset).await
    }
    pub async fn clear_pending(&self, owner: &str, chat: &str) -> Result<Value> {
        self.mutate(owner, chat, Action::Clear).await
    }
    pub async fn claim_due(&self, owner: &str, chat: &str, now: Option<f64>) -> Result<Value> {
        self.mutate(owner, chat, Action::Claim { now: time(now) })
            .await
    }
    pub async fn finish(
        &self,
        owner: &str,
        chat: &str,
        claim: &str,
        failure: Option<&Value>,
        now: Option<f64>,
    ) -> Result<Value> {
        self.mutate(
            owner,
            chat,
            Action::Finish {
                claim: claim.into(),
                failure: failure.cloned(),
                now: time(now),
            },
        )
        .await
    }
}
fn apply(row: &Value, pending: bool, action: Action) -> Result<(Value, Value)> {
    let task = &row["task"];
    let chat = &row["chat"];
    let project = &row["project"];
    let mut record = task["automatic_retry"].clone();
    match action {
        Action::Note { key, kind, now } => {
            if task["state"] == "complete" {
                return Ok((Value::Null, json!(false)));
            }
            let same = !record.is_null() && record["failureKey"] == key;
            Ok((
                policy::schedule_retry(Some(&record), &key, &kind, now)?,
                json!(!same),
            ))
        }
        Action::Reset => Ok((Value::Null, json!(true))),
        Action::Clear => {
            if task["state"] == "complete" {
                record = Value::Null;
            } else if matches!(task["state"].as_str(), Some("blocked" | "review"))
                && !record.is_null()
                && record["status"] != "latched"
            {
                record["status"] = json!("idle");
                record["dueAt"] = Value::Null;
                record["claim"] = Value::Null;
            }
            Ok((record, json!(true)))
        }
        Action::Claim { now } => {
            if record.is_null()
                || !matches!(record["status"].as_str(), Some("scheduled" | "retrying"))
            {
                return Ok((record, Value::Null));
            }
            if matches!(task["state"].as_str(), Some("complete" | "blocked")) {
                record["status"] = json!("idle");
                record["claim"] = Value::Null;
                record["dueAt"] = Value::Null;
                return Ok((record, Value::Null));
            }
            if chat["automation_paused"] == true
                || project["task_scheduling_paused"] == true
                || pending
                || matches!(
                    chat["status"].as_str(),
                    Some("running" | "waiting-for-approval")
                )
            {
                return Ok((record, Value::Null));
            }
            if !record["claim"].is_null()
                && record["claim"]["expiresAt"]
                    .as_f64()
                    .is_some_and(|v| v > now)
            {
                return Ok((record, Value::Null));
            }
            if record["status"] == "scheduled"
                && (record["dueAt"].is_null() || record["dueAt"].as_f64().is_some_and(|v| v > now))
            {
                return Ok((record, Value::Null));
            }
            let mut attempts = record["attempts"]
                .as_array()
                .context("Task retry attempts")?
                .iter()
                .filter(|at| at.as_f64().is_some_and(|v| v > now - 60_000.0))
                .cloned()
                .collect::<Vec<_>>();
            if attempts.len() >= 5 {
                record["status"] = json!("latched");
                record["attempts"] = Value::Array(attempts);
                record["claim"] = Value::Null;
                record["dueAt"] = Value::Null;
                return Ok((record, Value::Null));
            }
            let id = uuid::Uuid::new_v4().to_string();
            attempts.push(json!(now));
            record["status"] = json!("retrying");
            record["attempts"] = Value::Array(attempts);
            record["dueAt"] = Value::Null;
            record["claim"] = json!({"id":id,"expiresAt":now+300_000.0});
            Ok((record, json!({"id":id,"rowVersion":task["row_version"]})))
        }
        Action::Finish {
            claim,
            failure,
            now,
        } => {
            if record.is_null() || record["claim"].get("id") != Some(&json!(claim)) {
                return Ok((record, json!(false)));
            }
            if let Some(failure) = failure.filter(|v| truthy(Some(v))) {
                if truthy(failure.get("defer")) {
                    let mut attempts = record["attempts"]
                        .as_array()
                        .context("Task retry attempts")?
                        .clone();
                    attempts.pop();
                    record["attempts"] = Value::Array(attempts);
                }
                record = policy::schedule_retry(
                    Some(&record),
                    &format!("retry:{claim}"),
                    &text(&failure["kind"])?,
                    now,
                )?;
            } else {
                record["status"] = json!("idle");
                record["claim"] = Value::Null;
                record["dueAt"] = Value::Null;
            }
            Ok((record, json!(true)))
        }
    }
}
