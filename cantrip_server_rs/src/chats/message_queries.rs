//! Message reads retain the source's owner joins and turn-aware page boundaries.
use super::{Repository, catalog, messages};
use crate::{
    database::Row,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

#[derive(Clone, Copy)]
pub enum MessageKind {
    Plain,
    Encrypted,
    Task,
    AgentWire,
}
impl MessageKind {
    pub(super) fn map(self, raw: &Value) -> Result<Value> {
        match self {
            Self::Plain => messages::plain(raw),
            Self::Encrypted => messages::opaque(raw),
            Self::Task => messages::task(raw),
            Self::AgentWire if truthy(raw.get("protected_content")) => messages::opaque(raw),
            Self::AgentWire => messages::plain(raw),
        }
    }
}
fn checked(result: Result<Vec<Row>>, params: &[&str]) -> Result<Vec<Row>> {
    result.map_err(|cause| catalog::statement_failure(cause, params))
}
fn mapped(rows: Vec<Row>, kind: MessageKind) -> Result<Vec<Value>> {
    rows.iter()
        .map(|row| kind.map(&catalog::raw(row)?))
        .collect()
}
impl Repository {
    pub async fn list_messages(
        &self,
        owner: &str,
        chat: &str,
        kind: MessageKind,
    ) -> Result<Vec<Value>> {
        // Legacy/plain and Task reads authorize through the project. Protected
        // Agent reads instead authorize on the Chat, including standalone rows.
        let (joins, filter) = match kind {
            MessageKind::Encrypted => (
                "",
                "c.owner_id=$1 AND c.experience='agent' AND m.protected_content IS NOT NULL",
            ),
            MessageKind::Task => (
                "INNER JOIN projects p ON p.id=c.project_id",
                "p.owner_id=$1 AND c.experience='task'",
            ),
            _ => (
                "INNER JOIN projects p ON p.id=c.project_id",
                "p.owner_id=$1 AND c.experience='agent'",
            ),
        };
        let sql = format!(
            "SELECT to_jsonb(m)::text FROM chat_messages m INNER JOIN chats c ON c.id=m.chat_id {joins} WHERE {filter} AND m.chat_id=$2 ORDER BY m.sequence ASC"
        );
        mapped(
            checked(
                self.database.query(&sql, &[&owner, &chat]).await,
                &[owner, chat],
            )?,
            kind,
        )
    }

    pub async fn latest_encrypted_user_message(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let rows=checked(self.database.query("SELECT to_jsonb(m)::text FROM chat_messages m INNER JOIN chats c ON c.id=m.chat_id AND c.experience='agent' AND c.archived_at IS NULL WHERE c.owner_id=$1 AND m.chat_id=$2 AND m.role='user' AND m.protected_content IS NOT NULL ORDER BY m.sequence DESC LIMIT 1",&[&owner,&chat]).await,&[owner,chat])?;
        rows.first()
            .map(|row| messages::opaque(&catalog::raw(row)?))
            .transpose()
    }

    pub async fn trim_latest_encrypted_turn(
        &self,
        owner: &str,
        chat: &str,
        message: &str,
    ) -> Result<bool> {
        let (owner, chat, message) = (owner.to_owned(), chat.to_owned(), message.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            let chats=checked(tx.query("SELECT id FROM chats WHERE id=$1 AND owner_id=$2 AND experience='agent' AND archived_at IS NULL LIMIT 1 FOR UPDATE",&[&chat,&owner]).await,&[&chat,&owner])?;
            if chats.is_empty(){return Ok(false)}
            let rows=checked(tx.query("SELECT id,sequence FROM chat_messages WHERE chat_id=$1 AND role='user' AND protected_content IS NOT NULL ORDER BY sequence DESC LIMIT 1",&[&chat]).await,&[&chat])?;
            let Some(latest)=rows.first() else{return Ok(false)};
            if latest.get::<String>(0)?!=message{return Ok(false)}
            let boundary=latest.get::<i64>(1)?;
            checked(tx.query("DELETE FROM chat_messages WHERE chat_id=$1 AND sequence>=$2",&[&chat,&boundary]).await,&[&chat,&boundary.to_string()])?;
            let now=crate::auth::now();
            checked(tx.query("UPDATE chats SET protected_plan=NULL,has_pending_plan_question=false,updated_at=$1 WHERE id=$2",&[&now,&chat]).await,&[&crate::auth::iso(now),&chat])?;
            Ok(true)
        })).await
    }

    pub async fn message_headers(&self, owner: &str, chat: &str) -> Result<Vec<Value>> {
        let rows=checked(self.database.query("SELECT jsonb_build_object('id',m.id,'execution_lane_id',m.execution_lane_id,'role',m.role,'created_at',m.created_at)::text FROM chat_messages m INNER JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND c.owner_id=$2 ORDER BY m.sequence ASC",&[&chat,&owner]).await,&[chat,owner])?;
        rows.iter().map(|row|{let m=catalog::raw(row)?;Ok(json!({"id":m["id"],"executionLaneId":m["execution_lane_id"],"role":m["role"],"createdAt":catalog::iso(&m["created_at"])?}))}).collect()
    }

    pub async fn opaque_message_page(
        &self,
        owner: &str,
        chat: &str,
        task: bool,
        query: &Value,
    ) -> Result<Value> {
        let experience = if task { "task" } else { "agent" };
        let column = if task {
            "task_protected_content"
        } else {
            "protected_content"
        };
        let base = format!(
            "FROM chat_messages m INNER JOIN chats c ON c.id=m.chat_id AND c.experience=$3 WHERE c.owner_id=$1 AND m.chat_id=$2 AND m.{column} IS NOT NULL"
        );
        let rows = if truthy(query.get("beforeSequence")) {
            let boundary = query["beforeSequence"]
                .as_i64()
                .context("Message page cursor")?;
            checked(self.database.query(&format!("SELECT m.role,m.sequence {base} AND m.sequence<$4 ORDER BY m.sequence DESC LIMIT 501"),&[&owner,&chat,&experience,&boundary]).await,&[owner,chat,experience,&boundary.to_string()])?
        } else {
            checked(
                self.database
                    .query(
                        &format!(
                            "SELECT m.role,m.sequence {base} ORDER BY m.sequence DESC LIMIT 501"
                        ),
                        &[&owner, &chat, &experience],
                    )
                    .await,
                &[owner, chat, experience],
            )?
        };
        if rows.is_empty() {
            return Ok(
                json!({"messages":Vec::<Value>::new(),"page":json!({"hasMore":false,"nextBeforeSequence":Value::Null,"oldestSequence":Value::Null,"newestSequence":Value::Null,"startsAtUserTurn":true})}),
            );
        }
        let headers = rows
            .iter()
            .map(|r| Ok((r.get::<String>(0)?, r.get::<i64>(1)?)))
            .collect::<Result<Vec<_>>>()?;
        let nominal =
            (query["limit"].as_u64().context("Message page limit")? as usize).min(headers.len());
        let mut selected = nominal;
        let mut starts = headers
            .get(nominal.wrapping_sub(1))
            .is_some_and(|(role, _)| role == "user");
        if !starts {
            for (i, (role, _)) in headers.iter().enumerate().take(500).skip(nominal) {
                if role == "user" {
                    selected = i + 1;
                    starts = true;
                    break;
                }
            }
        }
        let sequences = headers
            .iter()
            .take(selected)
            .map(|(_, sequence)| *sequence)
            .collect::<Vec<_>>();
        let rows=checked(self.database.query(&format!("SELECT to_jsonb(m)::text {base} AND m.sequence=ANY($4) ORDER BY m.sequence ASC"),&[&owner,&chat,&experience,&sequences]).await,&[owner,chat,experience])?;
        let oldest = sequences.last().copied();
        let has_more = headers.len() > selected;
        Ok(
            json!({"messages":mapped(rows,if task{MessageKind::Task}else{MessageKind::Encrypted})?,"page":json!({"hasMore":has_more,"nextBeforeSequence":if has_more{oldest}else{None},"oldestSequence":oldest,"newestSequence":headers[0].1,"startsAtUserTurn":starts})}),
        )
    }
}
