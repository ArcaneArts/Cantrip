use super::*;
use crate::chats::execution_lanes::branch_leases;
impl Repository {
    pub async fn commit(&self, id: &str, command: &str, attempt: f64) -> Result<Value> {
        let id = id.to_owned();
        let command = command.to_owned();
        let attempt = Value::Number(attempt).stringify();
        self.database.transaction(move|tx|Box::pin(async move{
            let rows=tx.query("SELECT to_jsonb(j)::text FROM chat_relocation_jobs j WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state='ready-to-commit' LIMIT 1",&[&id,&command,&attempt]).await?;
            let job=first(&rows)?;let target=&job["target_placement"];let source=&job["source_placement"];
            if !crate::wire::coercion::truthy(job.get("target_runtime_thread_id")) || !crate::wire::coercion::truthy(job.get("target_model_route_id")) || !crate::wire::coercion::truthy(target.get("worktreeId")) {return Err(conflict("The target runtime is not ready to commit."))}
            if tx.query("SELECT id FROM chat_relocation_snapshots WHERE job_id=$1 LIMIT 1",&[&id]).await?.is_empty(){return Err(conflict("The relocation context snapshot is missing."))}
            let project=text(&job["project_id"])?;let chat=text(&job["chat_id"])?;let worker=text(&target["workerId"])?;let worktree=text(&target["worktreeId"])?;let source_worker=text(&source["workerId"])?;let source_tree=text(&source["worktreeId"])?;
            let rows=tx.query("SELECT to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$1 WHERE w.id=$2 AND w.worker_id=$3 AND w.lifecycle_state='ready' LIMIT 1",&[&project,&worktree,&worker]).await?;
            let root=rows.first().map(raw).transpose()?.ok_or_else(||conflict("The target worktree is no longer ready to receive this chat."))?;
            let at=crate::auth::now();let revision=job["source_placement_revision"].stringify();
            let chats=tx.query("UPDATE chats SET active_worker_id=$3,active_worktree_id=$4,placement_revision=placement_revision+1,updated_at=$5 WHERE id=$1 AND project_id=$2 AND status='idle' AND (active_worker_id=$6 OR active_worker_id IS NULL) AND active_worktree_id=$7 AND placement_revision=$8::text::integer RETURNING to_jsonb(chats)::text",&[&chat,&project,&worker,&worktree,&at,&source_worker,&source_tree,&revision]).await?;
            if chats.is_empty() {
                let p=progress("failed",json!(100),at).stringify();
                let failed=tx.query("UPDATE chat_relocation_jobs SET state='failed',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$3::text::jsonb,last_error_code='stale-attempt',error_retryable=false,completed_at=$2,updated_at=$2 WHERE id=$1 RETURNING to_jsonb(chat_relocation_jobs)::text",&[&id,&at,&p]).await?;
                let current=tx.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 LIMIT 1",&[&chat]).await?;
                return Ok(json!({"chat":mapping::chat(&first(&current)?)?,"job":mapping::job(&first(&failed)?)?}));
            }
            tx.query("UPDATE chat_runtime_sessions SET status='detached',updated_at=$4 WHERE chat_id=$1 AND worker_id=$2 AND worktree_id=$3",&[&chat,&source_worker,&source_tree,&at]).await?;
            let runtime=uuid::Uuid::new_v4().to_string();let thread=text(&job["target_runtime_thread_id"])?;let model=text(&job["target_model_route_id"])?;let account=optional(&job["target_provider_account_id"])?;
            let runtime_rows=tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id,model_route_id,provider_account_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'ready') ON CONFLICT(chat_id,worker_id,worktree_id) WHERE worktree_id IS NOT NULL DO UPDATE SET codex_thread_id=$5,model_route_id=$6,provider_account_id=$7,status='ready',updated_at=$8 RETURNING to_jsonb(chat_runtime_sessions)::text",&[&runtime,&chat,&worker,&worktree,&thread,&model,&account,&at]).await?;
            let runtime=text(&first(&runtime_rows)?["id"])?;
            tx.query("UPDATE chat_execution_lanes SET state='suspended',updated_at=$2 WHERE chat_id=$1 AND state<>'released'",&[&chat,&at]).await?;
            let target_lanes=tx.query("SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND worktree_id=$2 AND state<>'released' LIMIT 1",&[&chat,&worktree]).await?;
            let purpose=format!("Relocated by job {id}");
            let lane=if let Some(row)=target_lanes.first() {
                let lane=row.get::<String>(0)?;
                tx.query("UPDATE chat_execution_lanes SET worker_id=$2,purpose=$3,state='suspended',runtime_session_id=$4,codex_thread_id=$5,updated_at=$6 WHERE id=$1",&[&lane,&worker,&purpose,&runtime,&thread,&at]).await?;lane
            } else {
                let lane=uuid::Uuid::new_v4().to_string();let exclusive=!root["is_primary"].as_bool().context("Relocation primary worktree")?;
                tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,runtime_session_id,codex_thread_id) VALUES($1,$2,$3,$4,'user',$5,$6,'suspended',$7,$8)",&[&lane,&chat,&worktree,&worker,&exclusive,&purpose,&runtime,&thread]).await?;lane
            };
            if let Err(error)=branch_leases::acquire(tx,&project,&chat,&lane,&root).await {
                if error.downcast_ref::<branch_leases::LeaseError>().is_some(){return Err(conflict(&error.to_string()))}
                return Err(error)
            }
            if root["is_primary"]==true {branch_leases::release(tx,&lane).await?;}
            tx.query("UPDATE terminals SET active_worker_id=$2,worktree_id=$3,status='idle',updated_at=$4 WHERE linked_chat_id=$1",&[&chat,&worker,&worktree,&at]).await?;
            let p=progress("succeeded",json!(100),at).stringify();
            let completed=tx.query("UPDATE chat_relocation_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$4::text::jsonb,completed_at=$5,updated_at=$5 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state='ready-to-commit' RETURNING to_jsonb(chat_relocation_jobs)::text",&[&id,&command,&attempt,&p,&at]).await?;
            Ok(json!({"chat":mapping::chat(&first(&chats)?)?,"job":mapping::job(&first(&completed)?)?}))
        })).await
    }
}
