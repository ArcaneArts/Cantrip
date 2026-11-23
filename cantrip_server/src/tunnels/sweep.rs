//! The two reference expiry passes run independently every minute. Admitted
//! database work remains owned and is drained before the database closes.
use super::*;
use std::sync::Mutex;
use tokio::sync::Notify;
struct State {
    stopped: bool,
    active: usize,
    timer: Option<tokio::task::AbortHandle>,
}
pub struct LeaseSweeper {
    repository: Repository,
    live: Arc<crate::live::LiveService>,
    runtime: Arc<super::runtime::Runtime>,
    state: Mutex<State>,
    changed: Notify,
}
struct Pending(Arc<LeaseSweeper>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active -= 1;
        self.0.changed.notify_waiters();
    }
}
impl LeaseSweeper {
    pub fn start(
        repository: Repository,
        live: Arc<crate::live::LiveService>,
        runtime: Arc<super::runtime::Runtime>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            repository,
            live,
            runtime,
            state: Mutex::new(State {
                stopped: false,
                active: 0,
                timer: None,
            }),
            changed: Notify::new(),
        });
        let weak = Arc::downgrade(&service);
        let timer = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let Some(service) = weak.upgrade() else { break };
                service.tick();
            }
        });
        service.state.lock().unwrap().timer = Some(timer.abort_handle());
        service
    }
    pub fn tick(self: &Arc<Self>) {
        // Node admits both promises in one synchronous timer callback. Closing
        // the Rust service must likewise retain the whole admitted pair.
        {
            let mut state = self.state.lock().unwrap();
            if state.stopped {
                return;
            }
            state.active += 2;
        }
        for direct in [true, false] {
            let service = self.clone();
            let pending = Pending(service.clone());
            tokio::spawn(async move {
                let _pending = pending;
                let now = service.repository.now();
                let result = if direct {
                    service.repository.expire_direct(now).await
                } else {
                    service.repository.expire_attachments(now).await
                };
                match result {
                    Ok(changes) => {
                        for change in changes {
                            if !direct {
                                service.runtime.close_active(
                                    change["attachmentId"].as_str().expect("Expired attachment"),
                                    "Attachment expired",
                                    1008,
                                );
                            }
                            publish(&service.live, &change);
                        }
                    }
                    Err(error) => (crate::operations::logging::server_logger())(
                        crate::operations::logging::LogCall::event(
                            "error",
                            if direct {
                                "Could not expire direct tunnel attachment leases"
                            } else {
                                "Could not expire tunnel attachments"
                            },
                            json!({"err":crate::operations::logging::error_details(&error)}),
                        ),
                    ),
                }
            });
        }
    }
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stopped = true;
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().unwrap().active == 0 {
                return;
            }
            notified.await;
        }
    }
}
impl Drop for LeaseSweeper {
    fn drop(&mut self) {
        if let Some(timer) = self.state.get_mut().unwrap().timer.take() {
            timer.abort();
        }
    }
}
