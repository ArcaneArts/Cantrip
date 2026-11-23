//! Agent conversation keysets and per-client usage receipts retain SQL precision.
mod cursor;
use super::{
    Repository,
    archive::archived_project_summary,
    catalog::{iso, raw},
    summary::wire_summary,
};
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Debug)]
pub struct CursorError(pub &'static str);
impl std::fmt::Display for CursorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for CursorError {}
#[derive(Debug)]
pub struct UsageConflict;
impl std::fmt::Display for UsageConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Usage operation was already used for different input.")
    }
}
impl std::error::Error for UsageConflict {}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Conversation text")?
        .lossy()
        .into_owned())
}
impl Repository {
    pub async fn list_conversations(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        if self
            .database
            .query(
                "SELECT id FROM projects WHERE id=$1 AND owner_id=$2",
                &[&project, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let cursor = if let Some(encoded) = input.get("cursor") {
            let cursor =
                cursor::decode(encoded).ok_or(CursorError("Invalid conversation cursor."))?;
            if cursor["projectId"] != project || cursor["state"] != input["state"] {
                return Err(CursorError("Conversation cursor does not match this list.").into());
            }
            Some(cursor)
        } else {
            None
        };
        let active = input["state"] == "active";
        let scope = format!(
            "c.project_id=$1 AND c.owner_id=$2 AND c.context_kind='project' AND c.experience='agent' AND c.archived_at IS {}NULL",
            if active { "" } else { "NOT " }
        );
        let at = if active {
            "c.last_used_at"
        } else {
            "c.archived_at"
        };
        let keyset = if active {
            "(c.last_used_at,c.created_at,c.id)<($3::text::timestamptz,$4::text::timestamptz,$5)"
        } else {
            "(c.archived_at,c.id)<($3::text::timestamptz,$4)"
        };
        let order = if active {
            "c.last_used_at DESC,c.created_at DESC,c.id DESC"
        } else {
            "c.archived_at DESC,c.id DESC"
        };
        let count = if active {
            "0"
        } else {
            "(SELECT count(*)::int FROM chat_messages m WHERE m.chat_id=c.id)"
        };
        let limit = input["limit"].as_i64().context("Conversation page limit")?;
        let after_at = cursor.as_ref().map(|v| text(&v["at"])).transpose()?;
        let after_created = cursor.as_ref().map(|v| text(&v["createdAt"])).transpose()?;
        let after_id = cursor.as_ref().map(|v| text(&v["id"])).transpose()?;
        // Both queries share the Source scope, but the total ignores pagination.
        let limit_parameter = if active { "$6" } else { "$5" };
        let rows_sql = format!(
            "SELECT to_jsonb(c)::text,to_char({at} at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),to_char(c.created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),{count} FROM chats c WHERE {scope} AND ($3::text IS NULL OR {keyset}) ORDER BY {order} LIMIT {limit_parameter}::bigint"
        );
        let count_sql = format!("SELECT count(*)::int FROM chats c WHERE {scope}");
        let more = limit + 1;
        let active_parameters: crate::database::Parameters<'_> = &[
            &project,
            &owner,
            &after_at,
            &after_created,
            &after_id,
            &more,
        ];
        let archived_parameters: crate::database::Parameters<'_> =
            &[&project, &owner, &after_at, &after_id, &more];
        let parameters = if active {
            active_parameters
        } else {
            archived_parameters
        };
        let count_parameters: crate::database::Parameters<'_> = &[&project, &owner];
        let (rows, counts) = tokio::try_join!(
            self.database.query(&rows_sql, parameters),
            self.database.query(&count_sql, count_parameters)
        )?;
        let mut items = Vec::new();
        let mut next = Value::Null;
        for row in rows.iter().take(limit as usize) {
            let chat = raw(row)?;
            let mut item = if active {
                wire_summary(&chat)?
            } else {
                archived_project_summary(&chat, row.get::<i32>(3)?)?
            };
            item["lastUsedAt"] = iso(&chat["last_used_at"])?;
            items.push(item);
            if rows.len() > limit as usize {
                next=json!(URL_SAFE_NO_PAD.encode(json!({"version":1,"projectId":project,"state":input["state"],"at":row.get::<String>(1)?,"createdAt":row.get::<String>(2)?,"id":chat["id"]}).stringify()));
            }
        }
        let page = json!({"state":input["state"],"total":counts.first().map(|r|r.get::<i32>(0)).transpose()?.unwrap_or(0),"nextCursor":next,"items":items});
        Ok(Some(crate::settings::parse_response(
            "conversationCatalogWirePageSchema",
            Some(&page),
        )?))
    }
    pub async fn record_conversation_usage(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (owner, chat, client, operation, sequence) = (
            owner.to_owned(),
            chat.to_owned(),
            text(&input["clientId"])?,
            text(&input["operationId"])?,
            input["sequence"]
                .as_i64()
                .context("Conversation usage sequence")?,
        );
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 AND context_kind='project' AND experience='agent' AND archived_at IS NULL FOR UPDATE",&[&chat,&owner]).await?;
            let Some(row)=rows.first() else {return Ok(None)};
            let current=raw(row)?;
            tx.query("INSERT INTO conversation_usage_clients(owner_id,client_id) VALUES($1,$2) ON CONFLICT DO NOTHING",&[&owner,&client]).await?;
            let clients=tx.query("SELECT sequence FROM conversation_usage_clients WHERE owner_id=$1 AND client_id=$2 FOR UPDATE",&[&owner,&client]).await?;
            let previous=clients.first().context("Conversation usage client")?.get::<i64>(0)?;
            let receipts=tx.query("SELECT chat_id,sequence,last_used_at::text,applied FROM conversation_usage_receipts WHERE owner_id=$1 AND client_id=$2 AND operation_id=$3",&[&owner,&client,&operation]).await?;
            if let Some(receipt)=receipts.first() {
                if receipt.get::<String>(0)?!=chat || receipt.get::<i64>(1)?!=sequence {return Err(UsageConflict.into())}
                return Ok(Some(json!({"applied":receipt.get::<bool>(3)?,"lastUsedAt":iso(&json!(receipt.get::<String>(2)?))?})));
            }
            let applied=sequence>previous;
            let milliseconds=current["last_used_at"].as_js_string().and_then(crate::wire::date_milliseconds).context("Conversation usage timestamp")?;
            let at=if applied {crate::auth::now().timestamp_millis().max(milliseconds+1)} else {milliseconds};
            let last_used=crate::wire::date_iso_milliseconds(at).context("Conversation usage timestamp")?;
            if applied {
                tx.query("UPDATE conversation_usage_clients SET sequence=$3 WHERE owner_id=$1 AND client_id=$2",&[&owner,&client,&sequence]).await?;
                tx.query("UPDATE chats SET last_used_at=$2::text::timestamptz WHERE id=$1",&[&chat,&last_used]).await?;
            }
            tx.query("INSERT INTO conversation_usage_receipts(owner_id,client_id,operation_id,chat_id,sequence,last_used_at,applied) VALUES($1,$2,$3,$4,$5,$6::text::timestamptz,$7)",&[&owner,&client,&operation,&chat,&sequence,&last_used,&applied]).await?;
            Ok(Some(json!({"applied":applied,"lastUsedAt":last_used})))
        })).await
    }
}
