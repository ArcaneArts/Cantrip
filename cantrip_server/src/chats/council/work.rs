use super::Repository;
use crate::wire::Value;
use anyhow::Result;

impl Repository {
    pub(crate) async fn council_linked_work(&self, owner: &str, agent: &str) -> Result<Vec<Value>> {
        let rows = self.database.query(
            r#"WITH owned AS (
                SELECT a.chat_id,a.owner_id FROM council_agents a
                JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id AND c.archived_at IS NULL
                WHERE a.chat_id=$2 AND a.owner_id=$1
            ), events AS (
                SELECT c.id AS chat_id,c.project_id,c.protected_label,'chat'::text AS target_kind,
                       CASE WHEN d.result_status IS NULL THEN d.received_message_id ELSE d.input_message_id END AS message_id,
                       coalesce(d.result_status,'delegated') AS status,d.created_at,d.operation_id::text AS event_id
                FROM owned a JOIN council_project_deliveries d ON d.source_chat_id=a.chat_id
                JOIN chats c ON c.id=d.target_chat_id AND c.owner_id=a.owner_id AND c.archived_at IS NULL
                WHERE c.project_id IS NOT NULL
                UNION ALL
                SELECT c.id,c.project_id,c.protected_label,'task'::text,NULL::text,
                       CASE d.state WHEN 'claimed' THEN 'queued' WHEN 'succeeded' THEN 'completed'
                            WHEN 'cancelled' THEN 'interrupted' WHEN 'expired' THEN 'failed' ELSE d.state END,
                       d.created_at,d.id
                FROM owned a JOIN council_task_dispatches origin ON origin.source_chat_id=a.chat_id
                JOIN task_dispatch_cycles d ON d.id=origin.dispatch_id AND d.owner_id=a.owner_id
                JOIN chats c ON c.id=d.chat_id AND c.owner_id=a.owner_id AND c.archived_at IS NULL
                WHERE c.project_id IS NOT NULL
                UNION ALL
                SELECT c.id,c.project_id,c.protected_label,created.kind,NULL::text,
                       CASE WHEN task.state='draft' THEN 'draft' ELSE 'created' END,
                       c.created_at,created.operation_id::text
                FROM owned a JOIN council_project_creations created ON created.source_chat_id=a.chat_id
                JOIN chats c ON c.id=created.target_chat_id AND c.owner_id=a.owner_id
                    AND c.project_id=created.project_id AND c.archived_at IS NULL
                LEFT JOIN tasks task ON task.chat_id=c.id
            ), latest AS (
                SELECT DISTINCT ON (chat_id) * FROM events ORDER BY chat_id,created_at DESC,event_id DESC
            )
            SELECT jsonb_build_object('chatId',chat_id,'projectId',project_id,'targetKind',target_kind,
                'messageId',message_id,'status',status,'titleProtection',protected_label)::text
            FROM latest ORDER BY created_at DESC,event_id DESC LIMIT 40"#,
            &[&owner, &agent],
        ).await?;
        rows.iter().map(super::super::catalog::raw).collect()
    }
}
