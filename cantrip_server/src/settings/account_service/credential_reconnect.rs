//! Reconnect migration retains owned lifetime and only logs public counters.
use super::AccountService;
use crate::{
    operations::logging::{self, LogCall},
    wire::value::json,
};
use anyhow::Result;
use futures::future::BoxFuture;
use std::sync::Arc;

impl AccountService {
    pub fn migrate_worker_credentials(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
    ) -> BoxFuture<'static, Result<()>> {
        let pending = self.migrations.migrate_worker(owner, worker);
        let worker = worker.to_owned();
        self.launch(move |_| async move {
            let logger = logging::server_logger();
            match pending.await {
                Ok(summary)
                    if summary.captured > 0
                        || summary.conflicts > 0
                        || summary.failed > 0
                        || summary.malformed > 0 =>
                {
                    logger(LogCall::event(
                        "info",
                        "Provider credential migration pass completed",
                        json!({"migration":summary,"workerId":worker}),
                    ));
                }
                Ok(_) => {}
                Err(_) => logger(LogCall::event(
                    "warn",
                    "Provider credential migration pass could not start",
                    json!({"workerId":worker}),
                )),
            }
            Ok(())
        })
    }
}
