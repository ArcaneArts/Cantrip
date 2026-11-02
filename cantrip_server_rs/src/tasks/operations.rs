use super::*;
impl Repository {
    pub async fn begin_operation(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = parse("taskEncryptedOperationStartSchema", input)?;
        if input["operation"]["chatId"] != chat {
            return conflict(
                "idempotency-conflict",
                "The encrypted Task operation belongs to another Task.",
            );
        }
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let request=&input["operation"]; let operation=text(&request["operationId"])?;
            let prior=one(Executor::Transaction(tx),"SELECT json_build_object('task',to_jsonb(t),'round',to_jsonb(r))::text FROM task_planning_rounds r JOIN tasks t ON t.chat_id=r.chat_id JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND r.id=$2 LIMIT 1",&[&owner,&operation]).await?;
            if let Some(prior)=prior {
                if !policy::same_operation(request,&prior["round"]["relay_request"]) { return conflict("idempotency-conflict","This Task operation ID was already used for different input."); }
                let mut out=context(&prior["task"],&prior["round"])?; out["idempotent"]=json!(true); return Ok(Some(out));
            }
            let Some(task)=owned(Executor::Transaction(tx),&owner,&chat,true).await? else { return Ok(None); };
            if truthy(task.get("active_operation_id")) { return conflict("operation-active","This Task already has an active operation."); }
            if task["row_version"]!=input["rowVersion"] { return conflict("stale-version","The Task changed in another client."); }
            let kind=text(&request["classification"]["kind"])?;
            if (kind=="direct")== (task["plan_goal_enabled"]==true) { return conflict("idempotency-conflict",if task["plan_goal_enabled"]==true { "Disable Plan + Goal before starting this Task directly." } else { "Enable Plan + Goal before starting a planning operation." }); }
            policy::validate_start(&text(&task["state"])?,task["stable_state_before_failure"].as_str(),&kind)?;
            if request["classification"]["ordinal"]!=increment(&task["planning_round"]) { return conflict("stale-version","The encrypted Task planning round is stale."); }
            let now=now();
            let mut round=round_columns(&request["classification"],&request["protectedInput"]);
            round["id"]=json!(operation); round["chat_id"]=json!(chat); round["relay_request"]=request.clone(); round["failure_task"]=input["failure"]["task"].clone(); round["failure_round"]=input["failure"]["round"].clone(); round["started_at"]=now.clone();
            let columns=round.as_object().context("Task round columns")?.keys().map(|k|k.lossy().into_owned()).collect::<Vec<_>>().join(",");
            let inserted=one(Executor::Transaction(tx),&format!("INSERT INTO task_planning_rounds({columns}) SELECT {columns} FROM jsonb_populate_record(NULL::task_planning_rounds,$1::text::jsonb) RETURNING to_jsonb(task_planning_rounds)::text"),&[&round.stringify()]).await?.context("Task round insert returned no row")?;
            let mut fields=task_columns(&request["task"]); fields["active_operation_id"]=json!(operation); fields["row_version"]=increment(&task["row_version"]); fields["updated_at"]=now.clone();
            if kind=="direct" { fields["implementation_started_at"]=if task["implementation_started_at"].is_null() { now } else { task["implementation_started_at"].clone() }; }
            let Some(updated)=update(tx,Table::Task,&chat,&fields,Some(("row_version",&input["rowVersion"]))).await? else { return conflict("stale-version","The Task changed in another client."); };
            let mut out=context(&updated,&inserted)?; out["idempotent"]=json!(false); Ok(Some(out))
        })).await
    }
}
