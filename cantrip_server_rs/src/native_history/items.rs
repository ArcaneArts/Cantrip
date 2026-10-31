use super::*;
use crate::wire::{coercion::truthy, value::json};

pub(super) fn key(chat: &Value, identity: &Value) -> String {
    payload_digest(&Value::Array(vec![
        json!("native-history-item-v1"),
        chat.clone(),
        identity.clone(),
    ]))
}
fn mapped(row: &Value) -> Result<Value> {
    let value = json!({"key":row["key"],"identity":json!({"threadId":row["thread_id"],"turnId":row["turn_id"],"itemId":row["item_id"],"component":row["component"],"identityKind":row["identity_kind"]}),"messageId":row["message_id"],"idempotencyKey":row["idempotency_key"],"preservedInput":row["preserved_input"]});
    crate::settings::parse_response("nativeHistoryItemMappingSchema", Some(&value))
}
impl Repository {
    /// Reserve canonical identities before the worker encrypts them. This never
    /// commits content, advances ingestion or acquires execution authority.
    pub async fn resolve_items(&self, owner: &str, raw: &Value) -> Result<Value> {
        let input = crate::settings::parse_response("nativeHistoryResolveSchema", Some(raw))?;
        let owner = owner.to_owned();
        self.database.transaction(|tx|Box::pin(async move{
            let worker=text(&input["workerId"])?;let chat=text(&input["chatId"])?;let id=text(&input["bindingId"])?;
            let binding=bindings::owned(tx,&owner,&worker,&chat,&id).await?;
            let mut result=Vec::new();
            for raw_item in input["items"].as_array().context("History reservation items")?{
                let mut item=raw_item.clone();
                if item["identity"]["threadId"]!=binding["threadId"]{return reject("item-thread-mismatch",409)}
                let key=key(&binding["chatId"],&item["identity"]);
                let existing=one(tx,"SELECT to_jsonb(i)::text FROM native_history_items i WHERE key=$1",&[&key]).await?;
                let kind=item["association"]["kind"].as_str().context("History association")?;
                if kind=="existing"||(matches!(kind,"observed-input"|"observed-output"|"output")&&existing.is_some()){
                    let Some(row)=existing.filter(|r|r["chat_id"]==binding["chatId"])else{return reject("item-not-reserved",404)};
                    result.push(mapped(&row)?);continue;
                }
                if kind=="observed-input"{item["association"]=input_alias::observed(tx,&owner,&binding,&item).await?;}
                let preserved=match input_alias::command_input(tx,&owner,&binding,&item).await?{Some(v)=>Some(v),None=>queue_alias::find(tx,&owner,&binding,&item).await?};
                let output=output_alias::find(tx,&owner,&binding,&item).await?;
                if output.as_ref().is_some_and(|o|truthy(Some(&o.claimed))&&o.claimed!=json!(key.clone())){return reject("output-alias-already-claimed",409)}
                let output_operation=output.as_ref().map(|o|o.operation.clone()).unwrap_or(Value::Null);
                let kind=item["association"]["kind"].as_str().context("Resolved history association")?;
                let alias_operation=if matches!(kind,"command-input"|"queue-input"|"queue-goal"){item["association"]["operationId"].clone()}else{Value::Null};
                let alias_claim=if matches!(kind,"queue-input"|"queue-goal"){item["association"]["claimId"].clone()}else{Value::Null};
                if let Some(row)=existing{
                    if row["chat_id"]!=binding["chatId"]||row["alias_operation_id"]!=alias_operation||row["alias_claim_id"]!=alias_claim||row["output_operation_id"]!=output_operation{return reject("item-association-conflict",409)}
                    result.push(mapped(&row)?);continue;
                }
                if truthy(Some(&alias_operation)){
                    let operation=text(&alias_operation)?;
                    if !tx.query("SELECT key FROM native_history_items WHERE alias_operation_id=$1",&[&operation]).await?.is_empty(){return reject("input-alias-already-claimed",409)}
                }
                let message=preserved.as_ref().map(|v|v["id"].clone()).or_else(||output.as_ref().map(|o|o.message["id"].clone())).unwrap_or(json!(uuid::Uuid::new_v4().to_string()));
                let idempotency=preserved.as_ref().map(|v|v["idempotencyKey"].clone()).or_else(||output.as_ref().map(|o|o.message["idempotency_key"].clone())).unwrap_or(json!(format!("native-history:{key}")));
                let identity=&item["identity"];let thread=text(&identity["threadId"])?;let turn=text(&identity["turnId"])?;let native_item=text(&identity["itemId"])?;let component=text(&identity["component"])?;let identity_kind=text(&identity["identityKind"])?;
                let message=text(&message)?;let idempotency=text(&idempotency)?;let alias_operation=optional(&alias_operation)?;let output_operation=optional(&output_operation)?;let alias_claim=optional(&alias_claim)?;let preserved=preserved.as_ref().map(Value::stringify);
                let row=one(tx,"INSERT INTO native_history_items(key,chat_id,thread_id,turn_id,item_id,component,identity_kind,message_id,idempotency_key,alias_operation_id,output_operation_id,alias_claim_id,preserved_input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::jsonb) RETURNING to_jsonb(native_history_items)::text",&[&key,&chat,&thread,&turn,&native_item,&component,&identity_kind,&message,&idempotency,&alias_operation,&output_operation,&alias_claim,&preserved]).await?.context("No row returned reserving historical item")?;
                result.push(mapped(&row)?);
            }
            let ids=result.iter().map(|v|text(&v["messageId"])).collect::<Result<Vec<_>>>()?;
            let attachments=references::read(tx,&chat,&ids).await?;
            for item in &mut result{
                if let Some(refs)=attachments.get(&text(&item["messageId"])?).filter(|r|!r.is_empty()){item["attachments"]=json!(refs);}
            }
            Ok(Value::Array(result))
        })).await
    }
}
