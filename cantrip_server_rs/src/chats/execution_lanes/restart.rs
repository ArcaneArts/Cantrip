use super::{LaneRepository, branch_leases};
use anyhow::Result;
impl LaneRepository {
    pub async fn reset_interrupted(&self) -> Result<()> {
        let now = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            // Preserve the exact unfinished native GUI writer, even when its
            // dispatch receipt was lost. Only its authenticated native outcome
            // or explicit recovery may release the lane/branch authority.
            let retained=tx.query("SELECT l.id,l.chat_id,l.runtime_session_id FROM chat_execution_lanes l WHERE l.state='active' AND EXISTS (SELECT 1 FROM native_command_activations a JOIN native_commands h ON h.operation_id=a.operation_id JOIN native_commands r ON r.operation_id=h.logical_operation_id JOIN chats c ON c.id=a.chat_id AND c.owner_id=h.owner_id WHERE a.chat_id=l.chat_id AND a.execution_lane_id=l.id AND a.worker_id=l.worker_id AND a.active=true AND h.chat_id=a.chat_id AND h.worker_id=a.worker_id AND h.execution_lane_id=a.execution_lane_id AND h.activation_generation=a.generation AND h.status IN ('accepted','dispatched','applied','uncertain') AND r.chat_id=h.chat_id AND r.owner_id=h.owner_id AND r.worker_id=h.worker_id AND r.execution_lane_id=a.execution_lane_id AND r.origin='gui' AND r.kind='start' AND r.logical_operation_id=r.operation_id AND r.logical_completed_at IS NULL)",&[]).await?;
            let lanes=retained.iter().map(|row|row.get::<String>(0)).collect::<Result<Vec<_>>>()?;
            let chats=retained.iter().map(|row|row.get::<String>(1)).collect::<Result<Vec<_>>>()?;
            let runtimes=retained.iter().map(|row|row.get::<Option<String>>(2)).collect::<Result<Vec<_>>>()?.into_iter().flatten().collect::<Vec<_>>();
            tx.query("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=$1,updated_at=$1 WHERE status='pending' AND (execution_lane_id IS NULL OR execution_lane_id<>ALL($2::text[]))",&[&now,&lanes]).await?;
            let primary=tx.query("SELECT l.id FROM chat_execution_lanes l INNER JOIN project_worktrees w ON w.id=l.worktree_id WHERE l.state='active' AND w.is_primary=true AND l.id<>ALL($1::text[])",&[&lanes]).await?;
            tx.query("UPDATE chat_execution_lanes SET state='suspended',updated_at=$1 WHERE state='active' AND id<>ALL($2::text[])",&[&now,&lanes]).await?;
            for row in primary {branch_leases::release(tx,&row.get::<String>(0)?).await?;}
            tx.query("UPDATE chats SET status='offline',updated_at=$1 WHERE id=ANY($2::text[]) AND status IN ('running','waiting-for-approval')",&[&now,&chats]).await?;
            tx.query("UPDATE chats SET status='offline',updated_at=$1 WHERE experience='task' AND automation_paused=false AND status IN ('running','waiting-for-approval') AND id IN (SELECT chat_id FROM tasks WHERE plan_goal_enabled=true AND implementation_started_at IS NOT NULL)",&[&now]).await?;
            tx.query("UPDATE chats SET status='failed',has_unread_completion=true,updated_at=$1 WHERE status IN ('running','waiting-for-approval') AND automation_paused=false",&[&now]).await?;
            tx.query("UPDATE chats SET status='idle',has_unread_completion=true,updated_at=$1 WHERE status IN ('running','waiting-for-approval') AND automation_paused=true",&[&now]).await?;
            tx.query("UPDATE chat_runtime_sessions SET status='detached',updated_at=$1 WHERE status IN ('starting','running') AND id<>ALL($2::text[])",&[&now,&runtimes]).await?;
            Ok(())
        })).await
    }
}
