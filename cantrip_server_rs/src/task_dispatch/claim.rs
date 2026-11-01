use super::*;
use std::collections::{HashMap, HashSet};
impl Repository {
    pub async fn claim_next(
        &self,
        owner: &str,
        lease_owner: &str,
        resolve: Eligibility,
        options: &Value,
    ) -> Result<Option<Value>> {
        identity(
            lease_owner,
            "Task dispatch lease owners must contain 1-200 characters.",
        )?;
        let options = capture_clock(options);
        let duration = duration(&options)?;
        let (owner, lease_owner) = (owner.to_owned(), lease_owner.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_owner(tx,&owner).await? { return Ok(None); }
            let ex=Executor::Transaction(tx);
            let workers=all(ex,"SELECT to_jsonb(w)::text FROM task_workers w WHERE w.owner_id=$1 AND w.enabled=true AND w.deleted_at IS NULL ORDER BY w.position ASC,w.id ASC",&[&owner]).await?;
            let counts=active_counts(ex,&owner).await?;
            let candidates=all(ex,"SELECT json_build_object('cycle',to_jsonb(d),'task',to_jsonb(t),'projectId',p.id,'projectPaused',p.task_scheduling_paused,'archivedAt',c.archived_at,'worktreeId',w.id,'worktreeState',w.lifecycle_state,'branch',w.branch,'physicalWorkerId',w.worker_id,'physicalWorkerUnlinkedAt',a.unlinked_at)::text FROM task_dispatch_cycles d JOIN tasks t ON t.chat_id=d.chat_id JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 JOIN project_worktrees w ON w.id=c.active_worktree_id JOIN workers a ON a.id=w.worker_id WHERE d.owner_id=$1 AND d.state='queued' AND c.archived_at IS NULL AND t.state<>'complete' ORDER BY d.fifo_created_at ASC,d.id ASC",&[&owner]).await?;
            let active=self::active_chats(ex,&owner).await?;
            let branches=all(ex,"SELECT json_build_object('projectId',b.project_id,'branch',b.branch_name,'chatId',l.chat_id)::text FROM project_branch_leases b JOIN projects p ON p.id=b.project_id LEFT JOIN chat_execution_lanes l ON l.id=b.chat_execution_lane_id WHERE p.owner_id=$1 AND b.state='active'",&[&owner]).await?;
            let mut reasons=crate::wire::value::Object::new();
            for worker in &workers {
                let active_count=*counts.get(&text(&worker["id"])?).unwrap_or(&0);
                if active_count>=worker["max_concurrency"].as_i64().context("Task worker capacity")? {
                    for candidate in &candidates {
                        let cycle=&candidate["cycle"];
                        if cycle["requested_task_worker_id"]==worker["id"] || cycle["requested_task_worker_id"].is_null() { reason(&mut reasons,cycle,"capacity-unavailable")?; }
                    }
                    continue;
                }
                let task_worker=worker_summary(worker,active_count)?;
                for candidate in &candidates {
                    let cycle=&candidate["cycle"]; let task=&candidate["task"];
                    if candidate["projectPaused"]==true { reason(&mut reasons,cycle,"project-paused")?; continue; }
                    if !candidate["archivedAt"].is_null() || active.contains(&text(&cycle["chat_id"])?) { continue; }
                    if crate::wire::coercion::truthy(candidate.get("branch")) && branches.iter().any(|b|b["projectId"]==candidate["projectId"] && b["branch"]==candidate["branch"] && b["chatId"]!=cycle["chat_id"]) { reason(&mut reasons,cycle,"capacity-unavailable")?; continue; }
                    if !cycle["requested_task_worker_id"].is_null() && cycle["requested_task_worker_id"]!=worker["id"] { continue; }
                    if task["plan_goal_enabled"]==true && worker["allows_plan_goal"]!=true { reason(&mut reasons,cycle,"plan-goal-unsupported")?; continue; }
                    if cycle["requested_task_worker_id"].is_null() && !task["continuity_family"].is_null() && task["continuity_family"]!=worker["continuity_family"] { reason(&mut reasons,cycle,"continuity-mismatch")?; continue; }
                    if candidate["worktreeState"]!="ready" || !candidate["physicalWorkerUnlinkedAt"].is_null() { reason(&mut reasons,cycle,"placement-unavailable")?; continue; }
                    let resolution=resolve(json!({"cycle":summary(cycle)?,"projectId":candidate["projectId"],"physicalWorkerId":candidate["physicalWorkerId"],"worktreeId":candidate["worktreeId"],"taskWorker":task_worker})).await?;
                    if resolution["eligible"]!=true { reasons.insert(text(&cycle["id"])?.into(),resolution["code"].clone()); continue; }
                    let now=clock(&options)?; let expires=expiry(&now,duration)?; let token=number_next(&cycle["fencing_token"])?;
                    let fields=json!({"state":"claimed","selected_task_worker_id":worker["id"],"task_worker_revision":worker["row_version"],"continuity_family":worker["continuity_family"],"model_configuration":model_configuration(worker),"model_route_id":resolution["modelRouteId"],"provider_account_id":resolution["providerAccountId"],"physical_worker_id":candidate["physicalWorkerId"],"worktree_id":candidate["worktreeId"],"codex_thread_id":resolution.get("codexThreadId").unwrap_or(&Value::Null),"lease_owner":lease_owner,"lease_expires_at":expires,"last_heartbeat_at":now,"fencing_token":token,"attempt_count":number_next(&cycle["attempt_count"])?,"eligibility_code":Value::Null,"claimed_at":now,"paused_at":Value::Null,"completed_at":Value::Null,"updated_at":now});
                    let Some(claimed)=change(ex,&text(&cycle["id"])?,&fields,Some("queued"),Some(&cycle["fencing_token"]),"").await? else { continue; };
                    let family=if task["requested_task_worker_id"].is_null() && task["continuity_family"].is_null() { &worker["continuity_family"] } else { &task["continuity_family"] };
                    let task_fields=json!({"last_task_worker_id":worker["id"],"continuity_family":family,"updated_at":now}).stringify();
                    tx.query("UPDATE tasks t SET last_task_worker_id=d.last_task_worker_id,continuity_family=d.continuity_family,scheduler_revision=t.scheduler_revision+1,updated_at=d.updated_at FROM jsonb_populate_record(NULL::tasks,$2::text::jsonb) d WHERE t.chat_id=$1",&[&text(&cycle["chat_id"])?,&task_fields]).await?;
                    let cycle=summary(&claimed)?;
                    return Ok(Some(json!({"lease":lease(&cycle)?,"cycle":cycle,"projectId":candidate["projectId"],"taskWorker":task_worker})));
                }
            }
            if workers.is_empty() { for candidate in &candidates { reason(&mut reasons,&candidate["cycle"],"task-worker-disabled")?; } }
            for (id,code) in &reasons { let now=clock(&options)?; change(ex,&id.lossy(),&json!({"eligibility_code":code,"updated_at":now}),Some("queued"),None,"").await?; }
            Ok(None)
        })).await
    }
}
fn reason(reasons: &mut crate::wire::value::Object, cycle: &Value, code: &str) -> Result<()> {
    reasons.insert(text(&cycle["id"])?.into(), json!(code));
    Ok(())
}
async fn active_chats(ex: Executor<'_, '_>, owner: &str) -> Result<HashSet<String>> {
    ex.query("SELECT DISTINCT l.chat_id FROM chat_execution_lanes l JOIN task_dispatch_cycles d ON d.chat_id=l.chat_id AND d.owner_id=$1 AND d.state='queued' WHERE l.state IN ('active','delivering')",&[&owner]).await?.iter().map(|r|r.get::<String>(0)).collect()
}
pub(super) async fn active_counts(
    ex: Executor<'_, '_>,
    owner: &str,
) -> Result<HashMap<String, i64>> {
    let rows=ex.query("SELECT selected_task_worker_id,count(*)::int FROM task_dispatch_cycles WHERE owner_id=$1 AND state IN ('claimed','running') GROUP BY selected_task_worker_id",&[&owner]).await?;
    let mut out = HashMap::new();
    for row in rows {
        if let Some(id) = row.get::<Option<String>>(0)? {
            out.insert(id, row.get::<i32>(1)? as i64);
        }
    }
    Ok(out)
}
