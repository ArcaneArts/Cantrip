use super::*;

#[derive(Clone)]
pub(crate) struct CouncilOrigin {
    pub agent_id: String,
    pub project_id: String,
    pub operation_id: uuid::Uuid,
}
impl Repository {
    pub async fn enqueue(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        kind: &str,
        version: &Value,
    ) -> Result<Value> {
        self.enqueue_with_origin(owner, chat, operation, kind, version, None)
            .await
            .map(|(dispatch, _)| dispatch)
    }

    pub(crate) async fn enqueue_with_origin(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        kind: &str,
        version: &Value,
        council: Option<CouncilOrigin>,
    ) -> Result<(Value, bool)> {
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
            if let Some(council) = &council {
                let prior = one(ex, "SELECT (to_jsonb(d) || jsonb_build_object('target_project_id',c.project_id))::text
                    FROM council_task_dispatches source
                    JOIN task_dispatch_cycles d ON d.id=source.dispatch_id AND d.owner_id=$1
                    JOIN chats c ON c.id=d.chat_id AND c.owner_id=d.owner_id
                    JOIN council_agents a ON a.chat_id=source.source_chat_id AND a.owner_id=d.owner_id
                    WHERE source.source_chat_id=$2 AND source.operation_id=$3::text::uuid",
                    &[&owner, &council.agent_id, &council.operation_id.to_string()]).await?;
                if let Some(prior) = prior {
                    if prior["chat_id"] != chat || prior["target_project_id"] != council.project_id {
                        return Err(Conflict::new("idempotency-conflict","This Council operation ID was already used for another Task operation.").into());
                    }
                    return Ok((summary(&prior)?, false));
                }
            }
            let prior=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 AND c.operation_id=$3 LIMIT 1",&[&owner,&chat,&operation]).await?;
            if let Some(prior)=&prior {
                if council.is_some() {
                    return Err(Conflict::new("idempotency-conflict","This Task dispatch operation ID is already in use.").into());
                }
                if prior["operation_kind"]!=kind { return Err(Conflict::new("idempotency-conflict","This Task operation ID was already used for another operation.").into()); }
                if !matches!(prior["state"].as_str(),Some("failed"|"cancelled"|"expired")) { return Ok((summary(prior)?, false)); }
            }
            let project = council.as_ref().map(|council| council.project_id.as_str());
            let task=one(ex,"SELECT to_jsonb(t)::text FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id
                WHERE p.owner_id=$1 AND t.chat_id=$2 AND ($3::text IS NULL OR (p.id=$3 AND c.archived_at IS NULL))
                LIMIT 1 FOR UPDATE",&[&owner,&chat,&project]).await?.ok_or(NotFound)?;
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
                if active["operation_id"]==operation { return Ok((summary(&active)?, false)); }
                return Err(Conflict::new("active-operation","The Task already has an active scheduled operation.").into());
            }
            if let Some(prior)=prior {
                let mut fields=reset_fields(&clock(&Value::Null)?,Value::Null,true); fields["requested_task_worker_id"]=Value::Null; fields["model_configuration"]=task["model_configuration"].clone();
                return Ok((summary(&change(ex,&text(&prior["id"])?,&fields,None,None,",fencing_token=c.fencing_token+1").await?.context("Task dispatch requeue returned no row")?)?, true));
            }
            let id=uuid::Uuid::new_v4().to_string();
            let row=one(ex,"INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,model_configuration) VALUES($1,$2,$3,$4,$5,'queued',$6::text::timestamptz,$7::text::jsonb) RETURNING to_jsonb(task_dispatch_cycles)::text",&[&id,&owner,&chat,&operation,&kind,&text(&crate::native_commands::receipt::iso(&task["created_at"])?)?,&task["model_configuration"].stringify()]).await?.context("Task dispatch enqueue returned no row")?;
            if let Some(council) = council {
                let assigned = tx.query("INSERT INTO council_task_dispatches (dispatch_id,source_chat_id,operation_id)
                    SELECT $1,a.chat_id,$2::text::uuid FROM council_agents a WHERE a.chat_id=$3 AND a.owner_id=$4
                    RETURNING dispatch_id",
                    &[&id,&council.operation_id.to_string(),&council.agent_id,&owner]).await?;
                if assigned.is_empty() { return Err(NotFound.into()); }
            }
            Ok((summary(&row)?, true))
        })).await
    }
}
