use crate::{
    config::ServerConfig,
    workers::limits::{ActiveLimit, ByteWindow},
};
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct RelayLimitError {
    pub message: &'static str,
    pub retry_after_seconds: u64,
}
impl RelayLimitError {
    pub fn new(message: &'static str, retry_after_seconds: u64) -> Self {
        Self {
            message,
            retry_after_seconds,
        }
    }
}
impl std::fmt::Display for RelayLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for RelayLimitError {}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayQuotaStats {
    pub active_remote_surfaces: usize,
    pub rejected_relay_bandwidth: f64,
    pub rejected_remote_surfaces: f64,
    pub rejected_uploads: f64,
    pub relay_bytes: f64,
    pub upload_bytes: f64,
}
struct State {
    account_relay: ByteWindow,
    worker_relay: ByteWindow,
    account_upload: ByteWindow,
    worker_upload: ByteWindow,
    account_surfaces: ActiveLimit,
    worker_surfaces: ActiveLimit,
    stats: RelayQuotaStats,
}
pub struct RelayQuotas {
    state: Mutex<State>,
}
pub struct SurfacePermit {
    quotas: Arc<RelayQuotas>,
    owner: String,
    worker: String,
}
impl Drop for SurfacePermit {
    fn drop(&mut self) {
        let mut state = self.quotas.state.lock().unwrap();
        state.worker_surfaces.release(&self.worker);
        state.account_surfaces.release(&self.owner);
    }
}
impl RelayQuotas {
    pub fn new(config: &ServerConfig) -> Arc<Self> {
        Self::with_limits(
            config.account_relay_bytes_per_minute,
            config.worker_relay_bytes_per_minute,
            config.account_upload_bytes_per_minute,
            config.worker_upload_bytes_per_minute,
            config.account_remote_surface_limit as usize,
            config.worker_remote_surface_limit as usize,
        )
    }
    pub fn with_limits(
        account_relay: u64,
        worker_relay: u64,
        account_upload: u64,
        worker_upload: u64,
        account_surfaces: usize,
        worker_surfaces: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                account_relay: ByteWindow::new(account_relay),
                worker_relay: ByteWindow::new(worker_relay),
                account_upload: ByteWindow::new(account_upload),
                worker_upload: ByteWindow::new(worker_upload),
                account_surfaces: ActiveLimit::new(account_surfaces),
                worker_surfaces: ActiveLimit::new(worker_surfaces),
                stats: RelayQuotaStats::default(),
            }),
        })
    }
    pub fn acquire_surface(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
    ) -> Result<SurfacePermit, RelayLimitError> {
        let mut state = self.state.lock().unwrap();
        if !state.account_surfaces.acquire(owner) {
            state.stats.rejected_remote_surfaces += 1.0;
            return Err(RelayLimitError::new(
                "Account Remote Surface connection quota reached.",
                1,
            ));
        }
        if !state.worker_surfaces.acquire(worker) {
            state.account_surfaces.release(owner);
            state.stats.rejected_remote_surfaces += 1.0;
            return Err(RelayLimitError::new(
                "Worker Remote Surface connection quota reached.",
                1,
            ));
        }
        Ok(SurfacePermit {
            quotas: self.clone(),
            owner: owner.into(),
            worker: worker.into(),
        })
    }
    pub fn consume_upload_at(
        &self,
        owner: &str,
        worker: &str,
        bytes: u64,
        now: i64,
    ) -> Result<(), RelayLimitError> {
        let mut state = self.state.lock().unwrap();
        let account = state
            .account_upload
            .retry_after(owner, bytes, now)
            .unwrap_or(0);
        let worker_retry = state
            .worker_upload
            .retry_after(worker, bytes, now)
            .unwrap_or(0);
        let retry = account.max(worker_retry);
        if retry > 0 {
            state.stats.rejected_uploads += 1.0;
            return Err(RelayLimitError::new(
                "Attachment upload byte quota reached. Retry later.",
                retry,
            ));
        }
        state.account_upload.consume(owner, bytes, now);
        state.worker_upload.consume(worker, bytes, now);
        state.stats.upload_bytes += bytes as f64;
        Ok(())
    }
    pub fn consume_relay_at(&self, owner: &str, worker: &str, bytes: u64, now: i64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.account_relay.retry_after(owner, bytes, now).is_some()
            || state.worker_relay.retry_after(worker, bytes, now).is_some()
        {
            state.stats.rejected_relay_bandwidth += 1.0;
            return false;
        }
        state.account_relay.consume(owner, bytes, now);
        state.worker_relay.consume(worker, bytes, now);
        state.stats.relay_bytes += bytes as f64;
        true
    }
    pub fn stats(&self) -> RelayQuotaStats {
        let state = self.state.lock().unwrap();
        RelayQuotaStats {
            active_remote_surfaces: state.account_surfaces.total(),
            ..state.stats.clone()
        }
    }
}
