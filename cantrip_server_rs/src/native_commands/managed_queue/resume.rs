use super::*;

impl QueueRepository {
    // The deployed worker derives this ID from the eligible head and queue
    // revision it read. A different revision belongs to a different attempt.
    pub(crate) async fn next_resume_operation(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<String>> {
        let rows = self
            .database
            .query(
                "SELECT 'queue-resume:' || c.id || ':' || p.id || ':' ||
                        p.revision::text || ':' || s.revision::text
                 FROM chats c
                 JOIN managed_queue_states s ON s.chat_id=c.id
                 JOIN queued_prompts p ON p.chat_id=c.id
                 WHERE c.id=$1 AND c.owner_id=$2 AND c.experience='agent'
                   AND c.archived_at IS NULL AND NOT c.automation_paused
                   AND NOT c.managed_autonomy_stopped
                   AND p.state='pending' AND NOT p.frozen
                   AND NOT EXISTS (SELECT 1 FROM managed_queue_claims q
                       WHERE q.prompt_id=p.id AND q.prompt_revision=p.revision
                         AND q.status='rejected')
                 ORDER BY p.position, p.created_at LIMIT 1",
                &[&chat, &owner],
            )
            .await?;
        rows.first().map(|row| row.get(0)).transpose()
    }

    pub(crate) async fn applied_resume_pause_state(
        &self,
        owner: &str,
        chat: &str,
        worker: &str,
        thread: &str,
        operation: &str,
    ) -> Result<Option<bool>> {
        let rows = self
            .database
            .query(
                "SELECT c.automation_paused
                 FROM chats c
                 JOIN managed_queue_claims q ON q.chat_id=c.id
                 JOIN native_commands request ON request.operation_id=q.request_operation_id
                   AND request.chat_id=c.id AND request.owner_id=c.owner_id
                 JOIN native_commands turn ON turn.operation_id=q.operation_id
                   AND turn.operation_generation=q.operation_generation
                   AND turn.chat_id=c.id AND turn.owner_id=c.owner_id
                 JOIN native_command_turns t ON t.operation_id=turn.operation_id
                   AND t.chat_id=c.id AND t.turn_id=q.native_turn_id
                 WHERE c.id=$1 AND c.owner_id=$2 AND c.archived_at IS NULL
                   AND request.worker_id=$3 AND turn.worker_id=$3
                   AND t.thread_id=$4 AND request.identity->>'threadId'=$4
                   AND q.request_operation_id=$5 AND q.status='consumed'
                   AND request.method='thread/queue/start' AND request.status='applied'
                   AND turn.method='turn/start' AND turn.status='applied'
                   AND turn.protected_result IS NOT NULL AND turn.result_digest IS NOT NULL
                 LIMIT 1",
                &[&chat, &owner, &worker, &thread, &operation],
            )
            .await?;
        rows.first().map(|row| row.get(0)).transpose()
    }
}
