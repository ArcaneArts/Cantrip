//! The global expiry producer is independent of project-alert LISTEN health.
use crate::{
    chats::live_mutations,
    operations::logging::{self, LogCall},
    wire::value::json,
    workers::maintenance,
};
use std::{sync::Arc, time::Duration};
use tokio::task::AbortHandle;

pub struct Expiry {
    timer: AbortHandle,
}
impl Expiry {
    pub fn start(
        mutations: &Arc<live_mutations::Service>,
        tasks: &Arc<maintenance::Service>,
    ) -> Self {
        let (mutations, tasks) = (Arc::downgrade(mutations), Arc::downgrade(tasks));
        let timer = tokio::spawn(async move {
            let period = Duration::from_secs(1);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let (Some(mutations), Some(tasks)) = (mutations.upgrade(), tasks.upgrade()) else {
                    break;
                };
                // Like setInterval, a later tick does not cancel an earlier SQL
                // operation. Started sweeps belong to the existing shutdown drain.
                drop(tasks.admit_owned(async move {
                    if let Err(cause) = mutations.expire_interactions().await {
                        logging::server_logger()(LogCall::event(
                            "error",
                            "Failed to expire pending agent interaction requests",
                            json!({"err":logging::error_details(&cause)}),
                        ));
                    }
                    Ok(())
                }));
            }
        })
        .abort_handle();
        Self { timer }
    }
    pub fn stop(&self) {
        self.timer.abort();
    }
}
impl Drop for Expiry {
    fn drop(&mut self) {
        self.stop();
    }
}
