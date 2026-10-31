use super::{LaneRepository, branch_leases};
use anyhow::Result;
impl LaneRepository {
    pub async fn reset_interrupted(&self) -> Result<()> {
        let now = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            tx.query("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=$1,updated_at=$1 WHERE status='pending'",&[&now]).await?;
            let primary=tx.query("SELECT l.id FROM chat_execution_lanes l INNER JOIN project_worktrees w ON w.id=l.worktree_id WHERE l.state='active' AND w.is_primary=true",&[]).await?;
            tx.query("UPDATE chat_execution_lanes SET state='suspended',updated_at=$1 WHERE state='active'",&[&now]).await?;
            for row in primary {branch_leases::release(tx,&row.get::<String>(0)?).await?;}
            tx.query("UPDATE chats SET status='offline',updated_at=$1 WHERE experience='task' AND automation_paused=false AND status IN ('running','waiting-for-approval') AND id IN (SELECT chat_id FROM tasks WHERE plan_goal_enabled=true AND implementation_started_at IS NOT NULL)",&[&now]).await?;
            tx.query("UPDATE chats SET status='failed',has_unread_completion=true,updated_at=$1 WHERE status IN ('running','waiting-for-approval') AND automation_paused=false",&[&now]).await?;
            tx.query("UPDATE chats SET status='idle',has_unread_completion=true,updated_at=$1 WHERE status IN ('running','waiting-for-approval') AND automation_paused=true",&[&now]).await?;
            tx.query("UPDATE chat_runtime_sessions SET status='detached',updated_at=$1 WHERE status IN ('starting','running')",&[&now]).await?;
            Ok(())
        })).await
    }
}
