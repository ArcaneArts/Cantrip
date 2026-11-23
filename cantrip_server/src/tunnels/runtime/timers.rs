use super::*;
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior};

// Node's timer implementation turns an overflowing delay into one millisecond.
fn delay(milliseconds: f64) -> Duration {
    Duration::from_millis(
        if milliseconds > i32::MAX as f64 || milliseconds < 1.0 || !milliseconds.is_finite() {
            1
        } else {
            milliseconds.trunc() as u64
        },
    )
}
impl Runtime {
    pub(super) fn start_timers(self: &Arc<Self>) {
        let (weak, heartbeat) = (Arc::downgrade(self), delay(self.options.heartbeat_ms));
        let first = Instant::now() + heartbeat;
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(first, heartbeat);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(runtime) = weak.upgrade() else {
                    return;
                };
                runtime.heartbeat_sweep();
            }
        });
        self.state.lock().unwrap().heartbeat = Some(task.abort_handle());
        let weak = Arc::downgrade(self);
        let period = Duration::from_secs(60);
        let first = Instant::now() + period;
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(first, period);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(runtime) = weak.upgrade() else {
                    return;
                };
                let _serial = runtime.serial.lock();
                if runtime.state.lock().unwrap().closed {
                    return;
                }
                runtime.broker.sweep(None);
            }
        });
        self.state.lock().unwrap().sweep = Some(task.abort_handle());
    }
    pub(super) fn install_expiry(self: &Arc<Self>, active: &Arc<Active>) -> Result<()> {
        let expires = super::super::time(&active.authorization, "expiresAt")?
            .context("Tunnel expiry timestamp")?;
        let after = delay(
            (expires.timestamp_millis() - (self.options.clock)().timestamp_millis()).max(1) as f64,
        );
        let (weak, entry) = (Arc::downgrade(self), Arc::downgrade(active));
        let deadline = Instant::now() + after;
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let (Some(runtime), Some(active)) = (weak.upgrade(), entry.upgrade()) else {
                return;
            };
            let _serial = runtime.serial.lock();
            if runtime.close_exact(&active, "Attachment expired", 1008) {
                let ticket = runtime.reserve(
                    active.authorization["attachmentId"]
                        .as_str()
                        .expect("attachment id"),
                );
                let owner = runtime.clone();
                runtime.spawn(async move {
                    let _ = owner.expire(&active, ticket).await;
                });
            }
        });
        active.state.lock().unwrap().expiry = Some(task.abort_handle());
        Ok(())
    }
    fn heartbeat_sweep(self: &Arc<Self>) {
        let _serial = self.serial.lock();
        if self.state.lock().unwrap().closed {
            return;
        }
        let entries = self
            .state
            .lock()
            .unwrap()
            .active
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for active in entries {
            if !self.current(&active) {
                continue;
            }
            {
                let state = active.state.lock().unwrap();
                if !state.activated || state.token.is_some() {
                    continue;
                }
            }
            if active.endpoint.socket.state() != 1 {
                self.retire(&active, "Attachment disconnected", 1012);
                continue;
            }
            let mut token = [0; 16];
            if getrandom::fill(&mut token).is_err() {
                self.retire(&active, "Attachment heartbeat failed", 1012);
                continue;
            }
            let token: Arc<[u8]> = Arc::from(token);
            active.state.lock().unwrap().token = Some(token.clone());
            if active.endpoint.socket.ping(&token).is_err() {
                active.state.lock().unwrap().token = None;
                self.retire(&active, "Attachment heartbeat failed", 1012);
                continue;
            }
            if !active
                .state
                .lock()
                .unwrap()
                .token
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &token))
            {
                continue;
            }
            let (weak, entry, after) = (
                Arc::downgrade(self),
                Arc::downgrade(&active),
                delay(self.options.timeout_ms),
            );
            let deadline = Instant::now() + after;
            let task = tokio::spawn(async move {
                tokio::time::sleep_until(deadline).await;
                let (Some(runtime), Some(active)) = (weak.upgrade(), entry.upgrade()) else {
                    return;
                };
                let _serial = runtime.serial.lock();
                if !runtime.current(&active) {
                    return;
                }
                {
                    let mut state = active.state.lock().unwrap();
                    if !state
                        .token
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &token))
                        || state.heartbeat.is_none()
                    {
                        return;
                    }
                    state.heartbeat = None;
                    state.token = None;
                }
                runtime.retire(&active, "Attachment heartbeat timed out", 1012);
            });
            active.state.lock().unwrap().heartbeat = Some(task.abort_handle());
        }
    }
    pub(super) fn pong(self: &Arc<Self>, active: &Arc<Active>, bytes: &[u8]) {
        let _serial = self.serial.lock();
        if !self.current(active) {
            return;
        }
        {
            let mut state = active.state.lock().unwrap();
            if state
                .token
                .as_ref()
                .is_none_or(|token| token.as_ref() != bytes)
            {
                return;
            }
            if let Some(timer) = state.heartbeat.take() {
                timer.abort();
            }
            state.token = None;
        }
        if !self.broker.record_activity(
            &active.authorization["tunnelId"],
            &active.authorization["attachmentId"],
        ) {
            self.retire(active, "Attachment authority expired", 1008);
        }
    }
}
pub(super) fn reason_code(reason: &str) -> &'static str {
    for (needle, code) in [
        ("heartbeat timed out", "heartbeat_timeout"),
        ("heartbeat failed", "heartbeat_failed"),
        ("authority expired", "authority_expired"),
        ("expired", "expired"),
        ("replaced", "replaced"),
        ("disconnected", "worker_disconnected"),
        ("revoked", "revoked"),
        ("shutting down", "server_shutdown"),
        ("stale", "stale"),
        ("activate", "activation_failed"),
    ] {
        if reason.contains(needle) {
            return code;
        }
    }
    "closed"
}
