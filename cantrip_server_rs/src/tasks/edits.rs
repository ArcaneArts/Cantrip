use super::*;
impl Repository {
    pub async fn update_draft(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = parse("taskOpaqueMutationSchema", input)?;
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_user(tx,&owner).await? { return Ok(None); }
            let cycle=one(Executor::Transaction(tx),"SELECT to_jsonb(d)::text FROM task_dispatch_cycles d JOIN tasks t ON t.chat_id=d.chat_id JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND d.chat_id=$2 AND d.state IN ('queued','claimed','running','paused') LIMIT 1 FOR UPDATE",&[&owner,&chat]).await?;
            if cycle.as_ref().is_some_and(|c|c["state"]!="queued") { return conflict("operation-active","The Task has already started and can no longer be edited."); }
            let Some(task)=owned(Executor::Transaction(tx),&owner,&chat,true).await? else { return Ok(None); };
            let current=summary(&task,cycle.as_ref())?;
            if current["state"]!="draft" && !(current["state"]=="failed" && current["stableStateBeforeFailure"]=="draft") { return policy::transition_error(&text(&current["state"])?,"draft"); }
            policy::assert_mutation(&current,&input)?;
            if truthy(input.get("requestedTaskWorkerId")) && tx.query("SELECT id FROM task_workers WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL LIMIT 1",&[&text(&input["requestedTaskWorkerId"])?,&owner]).await?.is_empty() { return conflict("stale-version","The selected Task Worker is unavailable."); }
            let now=now();
            let mut fields=task_columns(&input["task"]);
            for (key,column) in [("planGoalEnabled","plan_goal_enabled"),("draftAttachmentIds","draft_attachment_ids"),("priority","priority"),("requestedTaskWorkerId","requested_task_worker_id")] { if let Some(v)=input.get(key) { fields[column]=v.clone(); } }
            fields["scheduler_revision"]=increment(&task["scheduler_revision"]);
            fields["row_version"]=increment(&task["row_version"]); fields["updated_at"]=now.clone();
            let Some(updated)=update(tx,Table::Task,&chat,&fields,Some(("row_version",&input["rowVersion"]))).await? else { return conflict("stale-version","The Task draft changed in another client."); };
            let updated_cycle=if let Some(cycle)=cycle {
                let enabled=input.get("planGoalEnabled").unwrap_or(&updated["plan_goal_enabled"]);
                let kind=if enabled==&true { "initial-plan" } else { "direct" };
                let worker=if updated["requested_task_worker_id"].is_null(){None}else{Some(text(&updated["requested_task_worker_id"])?)};
                let Some(next)=one(Executor::Transaction(tx),"UPDATE task_dispatch_cycles c SET operation_kind=$2,requested_task_worker_id=$3,fencing_token=c.fencing_token+1,eligibility_code=NULL,updated_at=$4::text::timestamptz WHERE c.id=$1 AND c.state='queued' RETURNING to_jsonb(c)::text",&[&text(&cycle["id"])?,&kind,&worker,&text(&now)?]).await? else { return conflict("operation-active","The Task started before this edit could be saved."); };
                Some(next)
            } else { None };
            summary(&updated,updated_cycle.as_ref()).map(Some)
        })).await
    }
    pub async fn update_plan(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = parse("taskOpaqueMutationSchema", input)?;
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_user(tx,&owner).await? { return Ok(None); }
            if !tx.query("SELECT id FROM task_dispatch_cycles WHERE chat_id=$1 AND state IN ('queued','claimed','running','paused') LIMIT 1 FOR UPDATE",&[&chat]).await?.is_empty() { return conflict("operation-active","The next Task cycle is already queued or running."); }
            let Some(task)=owned(Executor::Transaction(tx),&owner,&chat,true).await? else { return Ok(None); };
            let current=summary(&task,None)?;
            if current["state"]!="review" && !(current["state"]=="failed" && current["stableStateBeforeFailure"]=="review") { return policy::transition_error(&text(&current["state"])?,"review"); }
            policy::assert_mutation(&current,&input)?;
            let mut fields=task_columns(&input["task"]); fields["row_version"]=increment(&task["row_version"]); fields["updated_at"]=now();
            let Some(updated)=update(tx,Table::Task,&chat,&fields,Some(("row_version",&input["rowVersion"]))).await? else { return conflict("stale-version","The Task plan changed in another client."); };
            summary(&updated,None).map(Some)
        })).await
    }
}
