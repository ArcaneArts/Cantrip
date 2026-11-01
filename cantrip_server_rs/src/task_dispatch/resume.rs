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
            let ex=Executor::Transaction(tx); let counts=super::claim::active_counts(ex,&owner).await?;
            let candidates=all(ex,"SELECT json_build_object('cycle',to_jsonb(d),'projectId',p.id,'projectPaused',p.task_scheduling_paused,'taskWorker',to_jsonb(w))::text FROM task_dispatch_cycles d JOIN chats c ON c.id=d.chat_id JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 JOIN task_workers w ON w.id=d.selected_task_worker_id WHERE d.owner_id=$1 AND d.state='paused' ORDER BY d.fifo_created_at ASC,d.id ASC",&[&owner]).await?;
            for candidate in candidates {
                let row=&candidate["cycle"]; let worker=&candidate["taskWorker"]; let cycle=summary(row)?;
                if candidate["projectPaused"]==true { continue; }
                let active=*counts.get(&text(&worker["id"])?).unwrap_or(&0);
                if active>=worker["max_concurrency"].as_i64().context("Task worker capacity")? { let now=clock(&options)?; change(ex,&text(&cycle["id"])?,&json!({"eligibility_code":"capacity-unavailable","updated_at":now}),None,None,"").await?; continue; }
                let eligibility=resolve(cycle.clone()).await?;
                if eligibility["eligible"]!=true { let now=clock(&options)?; change(ex,&text(&cycle["id"])?,&json!({"eligibility_code":eligibility["code"],"updated_at":now}),None,None,"").await?; continue; }
                let now=clock(&options)?; let expires=expiry(&now,duration)?;
                let fields=json!({"state":"running","lease_owner":row.get("lease_owner").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(lease_owner)),"lease_expires_at":expires,"last_heartbeat_at":now,"eligibility_code":Value::Null,"paused_at":Value::Null,"updated_at":now});
                let Some(resumed)=change(ex,&text(&cycle["id"])?,&fields,Some("paused"),Some(&cycle["fencingToken"]),",attempt_count=c.attempt_count+1").await? else { continue; };
                let cycle=summary(&resumed)?;
                return Ok(Some(json!({"lease":lease(&cycle)?,"cycle":cycle,"projectId":candidate["projectId"],"taskWorker":worker_summary(worker,active+1)?})));
            }
            Ok(None)
        })).await
    }
}
