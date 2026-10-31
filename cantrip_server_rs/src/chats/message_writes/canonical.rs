use super::*;
use sha2::{Digest, Sha256};
#[derive(Debug)]
pub struct HistoryError {
    pub code: &'static str,
    pub status_code: u16,
}
impl std::fmt::Display for HistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Native history request failed: {}.", self.code)
    }
}
impl std::error::Error for HistoryError {}
impl HistoryError {
    pub fn new(code: &'static str, status_code: u16) -> Self {
        Self { code, status_code }
    }
}
pub(crate) fn event_id(chat: &str, key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"cantrip:protected-agent-event\0");
    hash.update(chat.as_bytes());
    hash.update(b"\0");
    hash.update(key.as_bytes());
    let hash = hash.finalize();
    let mut bytes: [u8; 16] = hash[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    uuid::Uuid::from_bytes(bytes).to_string()
}
pub(super) async fn committed(
    executor: Executor<'_, '_>,
    chat: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let id = text(&input["id"])?;
    let key = text(&input["idempotencyKey"])?;
    let prefix = "(CASE WHEN n.component='assistant' THEN 'agent-message' WHEN n.component='activity' THEN 'activity' END)";
    let rows=checked(executor.query(&format!("SELECT to_jsonb(m)::text FROM native_history_items n INNER JOIN chat_messages m ON m.id=n.message_id AND m.chat_id=n.chat_id WHERE n.chat_id=$1 AND n.revision>0 AND (n.message_id=$2 OR(n.identity_kind='canonical' AND n.output_operation_id IS NOT NULL AND($3={prefix}||':root:'||n.turn_id||':'||n.item_id OR $3={prefix}||':'||n.turn_id||':'||n.thread_id||':'||n.turn_id||':'||n.item_id)))"),&[&chat,&id,&key]).await,&[json!(chat),input["id"].clone(),input["idempotencyKey"].clone()])?;
    if rows.len() > 1 {
        return Err(HistoryError::new("output-alias-ambiguous", 409).into());
    }
    let Some(saved) = rows.first().map(catalog::raw).transpose()? else {
        return Ok(None);
    };
    let same = input["id"] == saved["id"];
    if !truthy(saved.get("protected_content"))
        || saved["role"] != input["classification"]["role"]
        || saved["mode"] != input["classification"]["mode"]
        || if same {
            input["idempotencyKey"] != saved["idempotency_key"]
        } else {
            input["id"] != json!(event_id(chat, &key))
        }
    {
        return Err(HistoryError::new("item-canonical-message-conflict", 409).into());
    }
    messages::opaque(&saved).map(Some)
}
