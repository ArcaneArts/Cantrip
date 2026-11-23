//! Each server remembers authenticated workers, including across disconnects.
use super::account_service::AccountService;
use indexmap::IndexMap;
use std::{
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::task::AbortHandle;

pub struct Refresh {
    workers: Arc<Mutex<IndexMap<String, String>>>,
    accounts: Weak<AccountService>,
    timer: AbortHandle,
}
impl Refresh {
    pub fn start(accounts: &Arc<AccountService>) -> Self {
        let workers = Arc::new(Mutex::new(IndexMap::<String, String>::new()));
        let accounts = Arc::downgrade(accounts);
        let (registry, service) = (workers.clone(), accounts.clone());
        let timer = tokio::spawn(async move {
            let period = Duration::from_secs(15 * 60);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let Some(accounts) = service.upgrade() else {
                    break;
                };
                let workers = registry.lock().unwrap().clone();
                for (worker, owner) in workers {
                    if accounts.worker_is_connected(&worker) {
                        drop(accounts.refresh_worker_catalogs(owner, worker, "periodic-refresh"));
                    }
                }
            }
        })
        .abort_handle();
        Self {
            workers,
            accounts,
            timer,
        }
    }
    pub fn worker_connected(&self, owner: String, worker: String) {
        self.workers
            .lock()
            .unwrap()
            .insert(worker.clone(), owner.clone());
        if let Some(accounts) = self.accounts.upgrade() {
            drop(accounts.refresh_worker_catalogs(owner, worker, "worker-reconnected"));
        }
    }
    pub fn stop(&self) {
        self.timer.abort();
    }
}
impl Drop for Refresh {
    fn drop(&mut self) {
        self.stop();
    }
}
