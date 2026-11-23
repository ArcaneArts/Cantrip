use super::*;
use crate::codex::rpc_requests::Failure;
use crate::history::live::observation::Hub;
use std::sync::{OnceLock, Weak};

pub(super) fn source(hub: Hub, runtime: Weak<Inner>) -> Arc<RuntimeHub> {
    Arc::new(RuntimeHub {
        hub,
        read: Arc::new(move |thread| {
            let runtime = runtime.upgrade().map(Runtime);
            Box::pin(async move {
                runtime
                    .ok_or_else(|| anyhow!("Native history runtime has closed."))?
                    .read_history(&thread)
                    .await
            })
        }),
    })
}

impl Runtime {
    /// Stable observation identity for the lifetime of this native transport.
    /// History retains its own subscriptions without keeping the child alive.
    pub fn history(&self) -> Arc<RuntimeHub> {
        self.0.history.clone()
    }

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
        let mut snapshot = cantrip_history::native::snapshot(&reply, thread)?;
        if let Some(attribution) = &self.0.attribution {
            attribution
                .lock()
                .unwrap()
                .add_to_snapshot(thread, &mut snapshot);
        }
        Ok(snapshot)
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
