use super::*;
impl Repository {
    pub async fn enqueue(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        kind: &str,
        version: &Value,
    ) -> Result<Value> {
        identity(
            operation,
            "Task dispatch operation IDs must contain 1-200 characters.",
        )?;
        let (owner, chat, operation, kind, version) = (
            owner.to_owned(),
            chat.to_owned(),
            operation.to_owned(),
            kind.to_owned(),
            version.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let ex=Executor::Transaction(tx);
            if !lock_owner(tx,&owner).await? { return Err(NotFound.into()); }
            let prior=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 AND c.operation_id=$3 LIMIT 1",&[&owner,&chat,&operation]).await?;
            if let Some(prior)=&prior {
                if prior["operation_kind"]!=kind { return Err(Conflict::new("idempotency-conflict","This Task operation ID was already used for another operation.").into()); }
                if !matches!(prior["state"].as_str(),Some("failed"|"cancelled"|"expired")) { return summary(prior); }
            }
            let task=one(ex,"SELECT to_jsonb(t)::text FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND t.chat_id=$2 LIMIT 1 FOR UPDATE",&[&owner,&chat]).await?.ok_or(NotFound)?;
            if task["row_version"]!=version { return Err(Conflict::new("stale-version","The Task changed in another client.").into()); }
            if kind!="goal-continuation" {
                if (kind=="direct")==(task["plan_goal_enabled"]==true) { return Err(Conflict::new("idempotency-conflict",if task["plan_goal_enabled"]==true { "Disable Plan + Goal before queueing this Task directly." } else { "Enable Plan + Goal before queueing a planning operation." }).into()); }
                if let Err(error)=crate::tasks::policy::validate_start(&text(&task["state"])?,task["stable_state_before_failure"].as_str(),&kind) {
                    if error.is::<crate::tasks::policy::StateTransitionError>() { return Err(Conflict::new("idempotency-conflict",error.to_string()).into()); }
                    return Err(error);
                }
            }
            let active=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.chat_id=$1 AND c.state IN ('queued','claimed','running','paused') LIMIT 1",&[&chat]).await?;
            if let Some(active)=active {
                if active["operation_id"]==operation { return summary(&active); }
                return Err(Conflict::new("active-operation","The Task already has an active scheduled operation.").into());
            }
            if let Some(prior)=prior {
                let mut fields=reset_fields(&clock(&Value::Null)?,Value::Null,true); fields["requested_task_worker_id"]=task["requested_task_worker_id"].clone();
                return summary(&change(ex,&text(&prior["id"])?,&fields,None,None,",fencing_token=c.fencing_token+1").await?.context("Task dispatch requeue returned no row")?);
            }
            let id=uuid::Uuid::new_v4().to_string();
            let row=one(ex,"INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,requested_task_worker_id) VALUES($1,$2,$3,$4,$5,'queued',$6::text::timestamptz,$7) RETURNING to_jsonb(task_dispatch_cycles)::text",&[&id,&owner,&chat,&operation,&kind,&text(&crate::native_commands::receipt::iso(&task["created_at"])?)?,&task["requested_task_worker_id"].as_str()]).await?.context("Task dispatch enqueue returned no row")?;
            summary(&row)
        })).await
    }
}
