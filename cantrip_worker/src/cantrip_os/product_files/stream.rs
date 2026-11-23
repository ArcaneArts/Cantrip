//! Retain the actual guest executor session while Explorer imports are open.
use super::{CLIENT, EXECUTABLE, LIMITS, Records, Transport, process, text};
use crate::{
    cantrip_os::session::Session,
    filesystem::{Scope, explorer::imports},
};
use anyhow::{Context, Result, anyhow, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, watch},
    time::{Instant, sleep_until, timeout},
};
use uuid::Uuid;

// The stage expires at five minutes. Keep its carrier available briefly to
// answer a late continuation with the ordinary unavailable receipt.
pub(super) const IDLE: Duration = Duration::from_secs(imports::IDLE.as_secs() + 15);
pub(super) type Placement = Mutex<Option<Helper>>;

pub(super) struct Helper {
    pub session: Session,
    id: String,
    after: Option<u64>,
    lease: Option<watch::Sender<Instant>>,
}

impl Helper {
    pub async fn start(
        records: &Records,
        identity: &str,
        transport: &Transport,
        binding: Value,
        scope: &Value,
        lifetime: &Scope,
    ) -> Result<Self> {
        let (session, session_id) =
            Session::connect(transport, binding, CLIENT, None, lifetime).await?;
        let mut helper = Self {
            session,
            id: Uuid::new_v4().to_string(),
            after: None,
            lease: None,
        };
        let cwd = text(scope, "guestPath")?;
        records.start(identity, &helper.session.binding, &session_id, &helper.id)?;
        let result = async {
            process::start(
                &mut helper.session,
                &helper.id,
                &[EXECUTABLE, cwd, identity, "--stream"],
                cwd,
                json!({"HOME":scope["homeGuestPath"]}),
                true,
            )
            .await?;
            let ready = helper.line().await?;
            ensure!(
                ready["ready"] == true && ready["identity"] == identity,
                "The OS file helper did not identify its captured root."
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            helper.session.close().await;
            return Err(error);
        }
        Ok(helper)
    }

    pub async fn send(&mut self, frame: &Value) -> Result<Value> {
        let input = frame.stringify() + "\n";
        ensure!(
            input.len() <= LIMITS.output,
            "Linux file request exceeded its limit."
        );
        timeout(LIMITS.deadline, async {
            process::write(&mut self.session, &self.id, input.as_bytes()).await?;
            self.line().await
        })
        .await
        .context("The Linux file request timed out.")?
    }

    async fn line(&mut self) -> Result<Value> {
        let mut buffer = Vec::new();
        let deadline = Instant::now() + LIMITS.deadline;
        loop {
            let after = self.after;
            let page = self
                .session
                .request_with_timeout(
                    "process/read",
                    json!({
                        "processId":self.id,"afterSeq":after,"maxBytes":65536,"waitMs":200,
                    }),
                    deadline.saturating_duration_since(Instant::now()),
                )
                .await?;
            let previous = after.unwrap_or(0);
            let cursor = page["nextSeq"]
                .as_u64()
                .context("Linux file cursor")?
                .saturating_sub(1);
            ensure!(
                cursor >= previous
                    && page["outputEvictedThroughSeq"].as_u64().unwrap_or(0) <= previous,
                "The Linux file helper lost output."
            );
            self.after = Some(cursor);
            let chunks = page["chunks"]
                .as_array()
                .context("Linux file helper output")?;
            let start = buffer.len();
            for chunk in chunks {
                if chunk["stream"] == "stdout" {
                    let bytes = STANDARD.decode(text(chunk, "chunk")?)?;
                    ensure!(
                        buffer.len() + bytes.len() <= LIMITS.output,
                        "Linux file helper response exceeded its limit."
                    );
                    buffer.extend_from_slice(&bytes);
                }
            }
            if let Some(end) = buffer[start..].iter().position(|byte| *byte == b'\n') {
                let end = start + end;
                ensure!(
                    end + 1 == buffer.len(),
                    "Unexpected extra Linux file response."
                );
                return parse_json_text(std::str::from_utf8(&buffer[..end])?)
                    .map_err(|_| anyhow!("Invalid OS file helper receipt."));
            }
            ensure!(
                page["failure"].is_null()
                    && !(page["closed"] == true && page["exited"] == true && chunks.is_empty()),
                "The Linux file helper did not complete."
            );
            ensure!(
                Instant::now() < deadline,
                "The Linux file helper did not respond."
            );
        }
    }

    pub fn retain(&mut self, placement: &Arc<Placement>, records: Arc<Records>, identity: String) {
        let deadline = Instant::now() + IDLE;
        if let Some(lease) = &self.lease {
            lease.send_replace(deadline);
            return;
        }
        let (lease, mut expiry) = watch::channel(deadline);
        self.lease = Some(lease);
        let placement = Arc::downgrade(placement);
        let id = self.id.clone();
        tokio::spawn(async move {
            loop {
                let deadline = *expiry.borrow_and_update();
                tokio::select! {
                    updated = expiry.changed() => {
                        if updated.is_err() { return; }
                    }
                    _ = sleep_until(deadline) => {
                        let Some(placement) = placement.upgrade() else { return; };
                        let mut current = placement.lock().await;
                        if current.as_ref().is_none_or(|helper| helper.id != id) { return; }
                        if *expiry.borrow() == deadline {
                            current.take().unwrap().close(&records, &identity).await;
                            return;
                        }
                    }
                }
            }
        });
    }

    pub async fn close(mut self, records: &Records, identity: &str) {
        self.session.allow_cleanup();
        if process::terminate(&mut self.session, &self.id)
            .await
            .is_ok()
        {
            let _ = records.finished(identity);
        }
        self.session.close().await;
    }
}
