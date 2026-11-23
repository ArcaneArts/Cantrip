use super::*;
use crate::codex::admission::Revoked;

pub(super) fn interrupt(session: Arc<OnceLock<Session>>, logs: Option<Arc<Logs>>) -> OnRevoked {
    Arc::new(move |revoked: Revoked| {
        let session = session
            .get()
            .ok_or_else(|| anyhow!("The revoked native execution has no session."))?
            .clone();
        let Some(generation) = session.generation().map(str::to_owned) else {
            // The owned session's retirement path handles executions after transport loss.
            return Ok(());
        };
        let logs = logs.clone();
        tokio::spawn(async move {
            let mut settled = revoked.settled.work();
            let mut delay = Duration::from_millis(250);
            let mut reported = false;
            while session.generation() == Some(generation.as_str()) {
                let interruption = session.request(
                    "turn/interrupt".into(),
                    Some(json!({"threadId":revoked.thread_id,"turnId":revoked.turn_id})),
                    Some(RPC_TIMEOUT),
                    None,
                );
                let reply = tokio::select! {
                    biased;
                    _ = &mut settled => return,
                    reply = interruption => reply,
                };
                if reply.is_ok() {
                    // Native turn completion or process retirement still owns settlement.
                    return;
                }
                if !reported && let Some(logs) = &logs {
                    reported = true;
                    logs.event(
                        "warn",
                        "Native inference interruption will retry",
                        json!({"event":"inference.resource-interrupt-retry","threadId":revoked.thread_id,"turnId":revoked.turn_id}),
                    );
                }
                tokio::select! {
                    _ = &mut settled => return,
                    _ = tokio::time::sleep(delay) => {},
                }
                delay = (delay * 2).min(Duration::from_secs(5));
            }
        });
        Ok(())
    })
}
