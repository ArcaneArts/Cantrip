use super::{Repository, RosterError};
use crate::{
    database::Row,
    wire::{Value, value::json},
};
use anyhow::{Result, bail};

const RECORD_COLUMNS: &str =
    "m.id, m.sequence, m.role, m.mode, m.attachment_ids, m.protected_content, m.created_at";
const RECORD_JSON: &str = "jsonb_build_object('id',id,'sequence',sequence,'role',role,'mode',mode,
    'attachmentIds',attachment_ids,'protectedContent',protected_content,'createdAt',created_at)";
// Allow the largest valid encrypted message and keep every response below the
// managed MCP relay's 8 MiB response limit, even with JSON metadata.
const PAGE_BYTES: i64 = 6 * 1024 * 1024;

fn decode_records(rows: Vec<Row>) -> Result<Vec<Value>> {
    rows.iter()
        .map(|row| {
            let mut record = crate::chats::catalog::raw(row)?;
            record["createdAt"] = crate::chats::catalog::iso(&record["createdAt"])?;
            Ok(record)
        })
        .collect()
}

impl Repository {
    pub(crate) async fn delete_council_history_message(
        &self,
        owner: &str,
        agent: &str,
        message: &str,
    ) -> Result<bool> {
        let (owner, agent, message) = (owner.to_owned(), agent.to_owned(), message.to_owned());
        self.database.transaction(|tx| Box::pin(async move {
            use crate::chats::guard::{self, Access, NativeCommandError};
            guard::lock_chat(tx, &owner, &agent).await?;
            let scope = tx.query(
                "SELECT (c.status IN ('running','waiting-for-approval')
                     OR EXISTS(SELECT 1 FROM chat_execution_lanes l WHERE l.chat_id=c.id AND l.state IN ('active','delivering'))
                     OR EXISTS(SELECT 1 FROM native_command_activations t WHERE t.chat_id=c.id AND t.active=true)
                     OR EXISTS(SELECT 1 FROM managed_queue_claims q WHERE q.chat_id=c.id AND q.status IN ('claimed','accepted','dispatched','uncertain'))
                     OR COALESCE(c.native_suspension_state->>'phase' NOT IN ('idle','completed','failed','stopped'),false))
                 FROM chats c JOIN council_agents a ON a.chat_id=c.id AND a.owner_id=c.owner_id
                 WHERE c.id=$1 AND c.owner_id=$2 AND c.archived_at IS NULL",
                &[&agent,&owner],
            ).await?;
            let Some(scope) = scope.first() else { return Ok(false); };
            if scope.get::<bool>(0)? {
                bail!(NativeCommandError::new("council-history-in-use", Some("Finish or stop the active turn before deleting a Council message."), 409));
            }
            guard::assert_runtime_writable(tx, &agent, None, None, Access::Write).await?;
            if tx.query("DELETE FROM chat_messages WHERE chat_id=$1 AND id=$2 AND protected_content IS NOT NULL RETURNING id", &[&agent,&message]).await?.is_empty() {
                return Ok(false);
            }
            // Native summaries can include any earlier message. Move the live
            // binding to a new history epoch while keeping all retained rows
            // except the selected message and its revisioned index entry.
            let epoch = uuid::Uuid::new_v4().to_string();
            tx.query("UPDATE council_agents SET native_history_epoch=$2::text::uuid WHERE chat_id=$1", &[&agent,&epoch]).await?;
            tx.query("UPDATE chat_runtime_sessions SET codex_thread_id=NULL WHERE chat_id=$1 AND scratch_root_id IS NOT NULL", &[&agent]).await?;
            tx.query("DELETE FROM native_settings_states WHERE chat_id=$1", &[&agent]).await?;
            tx.query("UPDATE chats SET native_suspension_state=NULL,updated_at=$2 WHERE id=$1", &[&agent,&crate::auth::now()]).await?;
            Ok(true)
        })).await
    }

    pub(crate) async fn council_history_worker(
        &self,
        owner: &str,
        agent: &str,
    ) -> Result<Option<String>> {
        let rows = self.database.query(
            "SELECT c.active_worker_id FROM council_agents a JOIN chats c ON c.id=a.chat_id AND c.owner_id=a.owner_id
             WHERE a.owner_id=$1 AND a.chat_id=$2 AND c.archived_at IS NULL",
            &[&owner,&agent],
        ).await?;
        Ok(rows
            .first()
            .map(|row| row.get::<Option<String>>(0))
            .transpose()?
            .flatten())
    }

    pub(crate) async fn council_history_head(&self, owner: &str, agent: &str) -> Result<Value> {
        let rows = self
            .database
            .query(
                "SELECT COALESCE(h.revision,0), COALESCE((SELECT m.sequence FROM chat_messages m
              WHERE m.chat_id=a.chat_id AND m.protected_content IS NOT NULL
              ORDER BY m.sequence DESC LIMIT 1),0)
             FROM council_agents a LEFT JOIN council_history_state h ON h.chat_id=a.chat_id
             WHERE a.owner_id=$1 AND a.chat_id=$2",
                &[&owner, &agent],
            )
            .await?;
        let row = rows.first().ok_or(RosterError::NotFound)?;
        Ok(json!({"revision":row.get::<i64>(0)?,"throughSequence":row.get::<i64>(1)?}))
    }

    pub(crate) async fn council_history_page(
        &self,
        owner: &str,
        agent: &str,
        after: i64,
        through: i64,
    ) -> Result<Value> {
        let sql = format!("WITH candidates AS (
                SELECT {RECORD_COLUMNS} FROM chat_messages m JOIN council_agents a ON a.chat_id=m.chat_id
                WHERE a.owner_id=$1 AND a.chat_id=$2 AND m.protected_content IS NOT NULL
                  AND m.sequence>$3 AND m.sequence<=$4 ORDER BY m.sequence LIMIT 128
            ), packed AS (
                SELECT c.*, sum(octet_length(protected_content::text)+2048)
                    OVER(ORDER BY sequence) AS used_bytes FROM candidates c
            ) SELECT {RECORD_JSON}::text FROM packed WHERE used_bytes<=$5 ORDER BY sequence");
        let rows = self
            .database
            .query(&sql, &[&owner, &agent, &after, &through, &PAGE_BYTES])
            .await?;
        Ok(json!({"records":decode_records(rows)?}))
    }

    pub(crate) async fn council_history_changes(
        &self,
        owner: &str,
        agent: &str,
        after: (i64, i64),
        through: i64,
    ) -> Result<Value> {
        let sql = format!("WITH candidates AS (
                SELECT c.message_id,c.sequence AS change_sequence,c.revision,{RECORD_COLUMNS}
                FROM council_history_changes c JOIN council_agents a ON a.chat_id=c.chat_id
                LEFT JOIN chat_messages m ON m.chat_id=c.chat_id AND m.id=c.message_id
                WHERE a.owner_id=$1 AND a.chat_id=$2 AND (c.revision,c.sequence)>($3,$4) AND c.revision<=$5
                ORDER BY c.revision,c.sequence LIMIT 128
            ), packed AS (
                SELECT c.*, sum(coalesce(octet_length(protected_content::text),0)+2048)
                    OVER(ORDER BY revision,change_sequence) AS used_bytes FROM candidates c
            ) SELECT jsonb_build_object('messageId',message_id,'revision',revision,'sequence',change_sequence,
                'record',CASE WHEN protected_content IS NOT NULL THEN {RECORD_JSON} END)::text
            FROM packed WHERE used_bytes<=$6 ORDER BY revision,change_sequence");
        let rows = self
            .database
            .query(
                &sql,
                &[&owner, &agent, &after.0, &after.1, &through, &PAGE_BYTES],
            )
            .await?;
        let changes = rows
            .iter()
            .map(|row| {
                let mut change = crate::chats::catalog::raw(row)?;
                if change["record"].is_object() {
                    change["record"]["createdAt"] =
                        crate::chats::catalog::iso(&change["record"]["createdAt"])?;
                }
                Ok(change)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"changes":changes}))
    }

    pub(crate) async fn council_history_range(
        &self,
        owner: &str,
        agent: &str,
        message: &str,
    ) -> Result<Value> {
        let sql = format!("WITH anchor AS (
                SELECT m.sequence FROM chat_messages m JOIN council_agents a ON a.chat_id=m.chat_id
                WHERE a.owner_id=$1 AND a.chat_id=$2 AND m.id=$3 AND m.protected_content IS NOT NULL
            ), candidates AS (
                (SELECT {RECORD_COLUMNS},a.sequence AS target FROM chat_messages m CROSS JOIN anchor a
                  WHERE m.chat_id=$2 AND m.protected_content IS NOT NULL AND m.sequence<=a.sequence
                  ORDER BY m.sequence DESC LIMIT 5)
                UNION ALL
                (SELECT {RECORD_COLUMNS},a.sequence AS target FROM chat_messages m CROSS JOIN anchor a
                  WHERE m.chat_id=$2 AND m.protected_content IS NOT NULL AND m.sequence>a.sequence
                  ORDER BY m.sequence LIMIT 4)
            ), packed AS (
                SELECT c.*, sum(octet_length(protected_content::text)+2048)
                    OVER(ORDER BY abs(sequence-target),sequence) AS used_bytes FROM candidates c
            ) SELECT {RECORD_JSON}::text FROM packed WHERE used_bytes<=$4 ORDER BY sequence");
        let rows = self
            .database
            .query(&sql, &[&owner, &agent, &message, &PAGE_BYTES])
            .await?;
        let availability = if rows.is_empty() {
            "unavailable"
        } else {
            "available"
        };
        Ok(json!({"availability":availability,"records":decode_records(rows)?}))
    }
}
