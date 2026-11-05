use super::*;
pub(super) const PENDING_TASK_INPUT: &str = "EXISTS(SELECT 1 FROM task_planning_rounds r JOIN tasks t ON t.chat_id=r.chat_id AND t.active_operation_id=r.id JOIN chats chat ON chat.id=t.chat_id WHERE r.id=c.operation_id AND r.status='running' AND r.relay_result IS NULL AND r.assistant_message_id IS NULL AND r.turn_id IS NULL AND r.inference_input->>'deferred'='false' AND (r.inference_input->>'failedBeforeDispatch'='true' OR (r.inference_input->>'accepted'='true' AND r.inference_input->>'allAttemptsEnforced'='true' AND r.inference_input->>'firstDispatchedOperationId' IS NULL)) AND chat.archived_at IS NULL AND t.state NOT IN ('failed','complete') AND NOT EXISTS(SELECT 1 FROM task_dispatch_cycles newer WHERE newer.chat_id=c.chat_id AND (newer.created_at,newer.id)>(c.created_at,c.id)))";
impl Repository {
    pub async fn defer_for_capacity(&self, fence: &Value, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        summary(
            &self
                .update(
                    fence,
                    reset_fields(&now, json!("capacity-unavailable"), false),
                    &now,
                    Update {
                        predicate: "c.state IN ('claimed','running') AND c.turn_id IS NULL",
                        extra: ",fencing_token=c.fencing_token+1",
                        query_context: None,
                    },
                )
                .await?,
        )
    }
    pub async fn requeue_expired_leases(&self, owner: &str, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        self.expire(
            owner,
            &now,
            reset_fields(&now, json!("reconciliation-required"), true),
            "c.state='claimed' AND c.started_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_planning_rounds r WHERE r.id=c.operation_id AND r.inference_input IS NOT NULL)",
        )
        .await
    }
    pub async fn expire_started_leases(&self, owner: &str, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        let fields = json!({"state":"expired","lease_owner":Value::Null,"lease_expires_at":Value::Null,"last_heartbeat_at":Value::Null,"eligibility_code":"reconciliation-required","completed_at":now,"updated_at":now});
        let expired=self.expire(
            owner,
            &now,
            fields,
            "c.state='running' OR (c.state='claimed' AND (c.started_at IS NOT NULL OR EXISTS(SELECT 1 FROM task_planning_rounds r WHERE r.id=c.operation_id AND r.inference_input IS NOT NULL)))",
        )
        .await?;
        let mut expired = expired.as_array().context("Expired Task leases")?.clone();
        let mut ids = std::collections::HashSet::new();
        for row in &expired {
            ids.insert(text(&row["id"])?);
        }
        for row in all(Executor::Database(&self.database),&format!("SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.state='expired' AND {PENDING_TASK_INPUT}"),&[&owner]).await? {
            if ids.insert(text(&row["id"])?) {expired.push(summary(&row)?);}
        }
        Ok(Value::Array(expired))
    }
    async fn expire(
        &self,
        owner: &str,
        now: &str,
        fields: Value,
        predicate: &str,
    ) -> Result<Value> {
        let assignments = fields
            .as_object()
            .context("Expired Task columns")?
            .keys()
            .map(|k| format!("{k}=d.{k}"))
            .collect::<Vec<_>>()
            .join(",");
        let rows=all(Executor::Database(&self.database),&format!("UPDATE task_dispatch_cycles c SET {assignments},fencing_token=c.fencing_token+1 FROM jsonb_populate_record(NULL::task_dispatch_cycles,$3::text::jsonb) d WHERE c.owner_id=$1 AND c.lease_expires_at<=$2::text::timestamptz AND ({predicate}) RETURNING to_jsonb(c)::text"),&[&owner,&now,&fields.stringify()]).await?;
        summaries(&rows)
    }
    pub async fn recover_started_goal(
        &self,
        owner: &str,
        expected: &Value,
        lease_owner: &str,
        options: &Value,
    ) -> Result<Value> {
        let (owner, expected, lease_owner, options) = (
            owner.to_owned(),
            expected.clone(),
            lease_owner.to_owned(),
            capture_clock(options),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let ex=Executor::Transaction(tx); lock_owner(tx,&owner).await?;
            let chat=text(&expected["chatId"])?; let id=text(&expected["id"])?;
            let task=one(ex,"SELECT to_jsonb(t)::text FROM tasks t WHERE t.chat_id=$1 LIMIT 1 FOR UPDATE",&[&chat]).await?;
            let row=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.id=$2 LIMIT 1 FOR UPDATE",&[&owner,&id]).await?;
            let latest=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1",&[&owner,&chat]).await?;
            let (Some(row),Some(task))=(row,task) else { return Err(Conflict::stale().into()); };
            let allowed=matches!(row["state"].as_str(),Some("running"|"expired"|"failed")) || (options["allowSettled"]==true && row["state"]=="succeeded");
            if latest.as_ref().and_then(|c|c.get("id"))!=row.get("id") || row["operation_kind"]!="finalize" || row["started_at"].is_null() || task["implementation_started_at"].is_null() || task["plan_goal_enabled"]!=true || task["state"]=="complete" || task["has_final_plan"]!=true || task["has_goal_prompt"]!=true || row["operation_id"]!=expected["operationId"] || row["fencing_token"]!=expected["fencingToken"] || row["codex_thread_id"]!=expected["codexThreadId"] || row["worktree_id"]!=expected["worktreeId"] || !allowed { return Err(Conflict::stale().into()); }
            let live=row["state"]=="running" && row["lease_expires_at"].as_js_string().and_then(crate::wire::date_milliseconds).zip(clock(&options).ok().and_then(|s|crate::wire::date_milliseconds(&s.into()))).is_some_and(|(expires,now)|expires>now);
            let owner=if live { row["lease_owner"].clone() } else { json!(lease_owner) };
            let token=if live { row["fencing_token"].clone() } else { number_next(&row["fencing_token"])? };
            let now=clock(&options)?; let expires=expiry(&now,LEASE_MS as f64)?;
            change(ex,&id,&json!({"state":"running","lease_owner":owner,"fencing_token":token,"lease_expires_at":expires,"last_heartbeat_at":now,"completed_at":Value::Null,"eligibility_code":Value::Null,"updated_at":now}),None,None,"").await?;
            parse("taskDispatchWorkerLeaseSchema",&json!({"cycleId":row["id"],"operationId":row["operation_id"],"leaseOwner":owner,"fencingToken":token,"leaseExpiresAt":expires}))
        })).await
    }
}
