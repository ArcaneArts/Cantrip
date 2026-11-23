//! Pinned opaque archives include every owned writer for the same Chat/thread.
mod batches;
mod turns;
use super::*;
use crate::wire::value::json;

async fn snapshot(tx: &Transaction<'_>, binding: &Value, owner: &str) -> Result<String> {
    let chat = text(&binding["chatId"])?;
    let thread = text(&binding["threadId"])?;
    let streams=all(tx,"SELECT jsonb_build_object('id',s.id,'sequence',s.acknowledged_sequence,'digest',s.acknowledged_digest)::text FROM native_history_streams s INNER JOIN native_history_bindings b ON b.id=s.binding_id WHERE b.chat_id=$1 AND b.thread_id=$2 AND b.owner_id=$3 ORDER BY s.id ASC",&[&chat,&thread,&owner]).await?;
    Ok(payload_digest(&Value::Array(vec![
        binding["id"].clone(),
        Value::Array(streams),
    ])))
}
fn assert_snapshot(snapshot: &str, input: &Value) -> Result<()> {
    if input
        .get("snapshotId")
        .is_some_and(|v| v != &json!(snapshot))
        || input
            .get("cursor")
            .filter(|v| !v.is_null())
            .is_some_and(|c| c["snapshotId"] != json!(snapshot))
    {
        return reject("archive-snapshot-changed", 409);
    }
    Ok(())
}
pub(super) async fn prepare(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
) -> Result<(Value, String)> {
    let worker = text(&input["workerId"])?;
    let chat = text(&input["chatId"])?;
    let id = text(&input["bindingId"])?;
    let binding = bindings::owned(tx, owner, &worker, &chat, &id).await?;
    let snapshot = snapshot(tx, &binding, owner).await?;
    assert_snapshot(&snapshot, input)?;
    Ok((binding, snapshot))
}
impl Repository {
    pub async fn archive_items(&self, owner: &str, raw: &Value) -> Result<Value> {
        let input = crate::settings::parse_response("nativeHistoryArchiveReadSchema", Some(raw))?;
        let owner = owner.to_owned();
        self.database.transaction(|tx|Box::pin(async move{
            let (binding,snapshot)=prepare(tx,&owner,&input).await?;
            let chat=text(&binding["chatId"])?;let thread=text(&binding["threadId"])?;
            let cursor=input.get("cursor").filter(|v|!v.is_null()).map(|c|text(&c["key"])).transpose()?;
            let limit=input["limit"].as_f64().context("Archive page size")? as usize;let count=(limit+1)as i64;
            let rows=all(tx,"SELECT to_jsonb(i)::text FROM native_history_items i WHERE chat_id=$1 AND thread_id=$2 AND revision>0 AND($3::text IS NULL OR key>$3::text) ORDER BY key ASC LIMIT $4::bigint",&[&chat,&thread,&cursor,&count]).await?;
            let page=&rows[..rows.len().min(limit)];let ids=page.iter().map(|r|text(&r["message_id"])).collect::<Result<Vec<_>>>()?;let refs=references::read(tx,&chat,&ids).await?;
            let mut items=Vec::new();
            for row in page{
                let Some(attachments)=refs.get(&text(&row["message_id"])?)else{return reject("archived-message-unavailable",409)};
                items.push(json!({"key":row["key"],"identity":json!({"threadId":row["thread_id"],"turnId":row["turn_id"],"itemId":row["item_id"],"component":row["component"],"identityKind":row["identity_kind"]}),"messageId":row["message_id"],"attachments":attachments,"revision":row["revision"],"state":row["state"],"order":json!({"turn":row["turn_ordinal"],"item":row["item_ordinal"],"component":row["component_ordinal"]}),"evidence":row["protected_evidence"]}));
            }
            let cursor=if rows.len()>limit{json!({"snapshotId":snapshot,"key":page.last().unwrap()["key"]})}else{Value::Null};
            crate::settings::parse_response("nativeHistoryArchivePageSchema",Some(&json!({"binding":binding,"snapshotId":snapshot,"items":items,"nextCursor":cursor})))
        })).await
    }
}
