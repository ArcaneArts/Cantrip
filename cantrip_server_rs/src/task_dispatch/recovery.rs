use super::*;
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
            "c.state='claimed' AND c.started_at IS NULL",
        )
        .await
    }
    pub async fn expire_started_leases(&self, owner: &str, options: &Value) -> Result<Value> {
        let now = clock(options)?;
        let fields = json!({"state":"expired","lease_owner":Value::Null,"lease_expires_at":Value::Null,"last_heartbeat_at":Value::Null,"eligibility_code":"reconciliation-required","completed_at":now,"updated_at":now});
        self.expire(
            owner,
            &now,
            fields,
            "c.state='running' OR (c.state='claimed' AND c.started_at IS NOT NULL)",
        )
        .await
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
            if options["allowSettled"]==true && row["state"]!="running" {
                if !crate::wire::coercion::truthy(row.get("selected_task_worker_id")) { return Err(Conflict::stale().into()); }
                let selected=text(&row["selected_task_worker_id"])?;
                let worker=one(ex,"SELECT to_jsonb(w)::text FROM task_workers w WHERE w.owner_id=$1 AND w.id=$2 LIMIT 1",&[&owner,&selected]).await?;
                let counts=tx.query("SELECT count(*)::int FROM task_dispatch_cycles WHERE owner_id=$1 AND selected_task_worker_id=$2 AND state IN ('claimed','running')",&[&owner,&selected]).await?;
                let active=counts.first().context("Task capacity count")?.get::<i32>(0)? as i64;
                let Some(worker)=worker.filter(|w|w["enabled"]==true && w["allows_plan_goal"]==true) else { return Err(Conflict::new("active-operation","The selected Task Worker is disabled or no longer allows Plan + Goal. Enable it before resuming.").into()); };
                if active>=worker["max_concurrency"].as_i64().context("Task worker capacity")? { return Err(Conflict::new("active-operation","The Task Worker has no available capacity. Retry when a running Task finishes.").into()); }
            }
            let live=row["state"]=="running" && row["lease_expires_at"].as_js_string().and_then(crate::wire::date_milliseconds).zip(clock(&options).ok().and_then(|s|crate::wire::date_milliseconds(&s.into()))).is_some_and(|(expires,now)|expires>now);
            let owner=if live { row["lease_owner"].clone() } else { json!(lease_owner) };
            let token=if live { row["fencing_token"].clone() } else { number_next(&row["fencing_token"])? };
            let now=clock(&options)?; let expires=expiry(&now,LEASE_MS as f64)?;
            change(ex,&id,&json!({"state":"running","lease_owner":owner,"fencing_token":token,"lease_expires_at":expires,"last_heartbeat_at":now,"completed_at":Value::Null,"eligibility_code":Value::Null,"updated_at":now}),None,None,"").await?;
            parse("taskDispatchWorkerLeaseSchema",&json!({"cycleId":row["id"],"operationId":row["operation_id"],"leaseOwner":owner,"fencingToken":token,"leaseExpiresAt":expires}))
        })).await
    }
}
