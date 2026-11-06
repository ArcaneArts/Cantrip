use super::*;
impl Repository {
    pub async fn resume_next_paused(
        &self,
        owner: &str,
        lease_owner: &str,
        resolve: Eligibility,
        options: &Value,
    ) -> Result<Option<Value>> {
        let options = capture_clock(options);
        let duration = duration(&options)?;
        let (owner, lease_owner) = (owner.to_owned(), lease_owner.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_owner(tx,&owner).await? { return Ok(None); }
            let ex=Executor::Transaction(tx);
            let restore_chat = options["nativeSuspension"]["chatId"].as_str().map(str::to_owned);
            let restore_control = options["nativeSuspension"]["controlId"].as_str().map(str::to_owned);
            let explicit = restore_chat.is_some();
            let candidates=all(ex,"SELECT json_build_object('cycle',to_jsonb(d),'projectId',p.id,'projectPaused',p.task_scheduling_paused)::text FROM task_dispatch_cycles d JOIN chats c ON c.id=d.chat_id JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE d.owner_id=$1 AND d.state='paused' AND (($2::text IS NOT NULL AND d.chat_id=$2 AND c.native_suspension_state->>'controlId'=$3 AND c.native_suspension_state->>'phase'='resuming' AND c.native_suspension_state->>'action'='resume' AND c.native_suspension_state->'target'->'taskRound'->>'cycleId'=d.id AND c.native_suspension_state->'checkpoint' <> 'null'::jsonb) OR ($2::text IS NULL AND NOT COALESCE((c.native_suspension_state->'target'->'taskRound'->>'cycleId'=d.id AND (c.native_suspension_state->>'action'='stop' OR (c.native_suspension_state->'checkpoint' <> 'null'::jsonb AND c.native_suspension_state->>'phase' IN ('pausing','paused','resuming','error')))),false))) AND NOT EXISTS(SELECT 1 FROM native_runtime_handoffs h WHERE h.chat_id=d.chat_id AND h.phase IN ('preparing','prepared','committed')) AND NOT EXISTS(SELECT 1 FROM task_planning_rounds r WHERE r.chat_id=d.chat_id AND r.inference_input->'routeChange'->>'phase'='draining') ORDER BY d.fifo_created_at ASC,d.id ASC",&[&owner,&restore_chat,&restore_control]).await?;
            for candidate in candidates {
                let row=&candidate["cycle"]; let cycle=summary(row)?;
                if candidate["projectPaused"]==true { continue; }
                let eligibility=resolve(cycle.clone()).await?;
                if eligibility["eligible"]!=true { let now=clock(&options)?; change(ex,&text(&cycle["id"])?,&json!({"eligibility_code":eligibility["code"],"updated_at":now}),None,None,"").await?; continue; }
                let now=clock(&options)?; let expires=expiry(&now,duration)?;
                let fields=json!({"state":"running","lease_owner":if explicit {json!(lease_owner)} else {row.get("lease_owner").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(lease_owner))},"lease_expires_at":expires,"last_heartbeat_at":now,"eligibility_code":Value::Null,"paused_at":Value::Null,"updated_at":now});
                let Some(resumed)=change(ex,&text(&cycle["id"])?,&fields,Some("paused"),Some(&cycle["fencingToken"]),if explicit {",fencing_token=c.fencing_token+1"} else {",attempt_count=c.attempt_count+CASE WHEN c.goal_input->>'deferred'='true' THEN 0 ELSE 1 END"}).await? else { continue; };
                let cycle=summary(&resumed)?;
                return Ok(Some(json!({"lease":lease(&cycle)?,"cycle":cycle,"projectId":candidate["projectId"],"modelConfiguration":cycle["modelConfiguration"]})));
            }
            Ok(None)
        })).await
    }
}
