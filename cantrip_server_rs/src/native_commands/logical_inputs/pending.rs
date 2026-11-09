use crate::{
    database::Executor,
    native_commands::{Repository, admit::text, context},
};
use anyhow::Result;

impl Repository {
    /// Preserve uncertain execution only while its original GUI authority is live.
    pub async fn pending_logical_gui_after_transport_loss(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        generation: &str,
    ) -> Result<bool> {
        let (owner, worker, operation, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            operation.to_owned(),
            generation.to_owned(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let captured = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let chat = text(&captured["chat_id"])?;
            context::lock_chat(tx, &owner, &chat).await?;
            Ok(!tx.query(
                "SELECT n.operation_id FROM native_commands r \
                 INNER JOIN native_command_activations a ON a.chat_id=r.chat_id \
                 INNER JOIN native_commands n ON n.operation_id=a.operation_id AND n.activation_generation=a.generation AND n.execution_lane_id=a.execution_lane_id \
                 INNER JOIN chat_execution_lanes l ON l.id=n.execution_lane_id \
                 WHERE r.owner_id=$1 AND r.worker_id=$2 AND r.operation_id=$3 AND r.operation_generation=$4 \
                 AND r.origin='gui' AND r.kind='start' AND r.logical_operation_id=r.operation_id AND r.logical_completed_at IS NULL \
                 AND a.worker_id=$2 AND a.active AND NOT a.logical_cancelled \
                 AND n.owner_id=$1 AND n.worker_id=$2 AND n.chat_id=r.chat_id AND n.origin='gui' AND n.kind='start' \
                 AND n.logical_operation_id=r.operation_id AND n.execution_lane_id=r.execution_lane_id \
                 AND n.status IN ('dispatched','applied','uncertain') AND n.execution_completed_at IS NULL \
                 AND l.chat_id=r.chat_id AND l.worker_id=$2 AND l.state='active'",
                &[&owner, &worker, &operation, &generation],
            ).await?.is_empty())
        })).await
    }
}
