use super::*;
use crate::codex::rpc_requests::Failure;
use std::sync::OnceLock;

impl Runtime {
    /// Observe the existing thread without loading, resuming or configuring it.
    pub async fn read_history(&self, thread: &JsString) -> Result<Value> {
        let read = |include_metadata| {
            let mut params = json!({"threadId":thread,"includeTurns":true});
            if include_metadata {
                params["includeHistoryMetadata"] = json!(true);
            }
            self.request("thread/read".into(), Some(params), Some(RPC_TIMEOUT), None)
        };
        let reply = match read(true).await {
            Err(error) if unsupported_metadata(&error) => read(false).await?,
            reply => reply?,
        }
        .ok_or_else(|| anyhow!("Native history read returned no result."))?;
        cantrip_history::native::snapshot(&reply, thread)
    }
}

fn unsupported_metadata(error: &anyhow::Error) -> bool {
    static UNKNOWN_FIELD: OnceLock<regress::Regex> = OnceLock::new();
    let Some(native) = error
        .downcast_ref::<Failure>()
        .and_then(|error| error.native_error.as_ref())
    else {
        return false;
    };
    if native["code"].as_i64() != Some(-32602) {
        return false;
    }
    let Some(message) = native["message"].as_str() else {
        return false;
    };
    (message.contains("includeHistoryMetadata") || message.contains("include_history_metadata"))
        && UNKNOWN_FIELD
            .get_or_init(|| {
                regress::Regex::with_flags(
                    r"(?:unknown|unrecognized|unsupported)\s+(?:field|parameter)",
                    "iu",
                )
                .expect("native history compatibility pattern")
            })
            .find(message)
            .is_some()
}
