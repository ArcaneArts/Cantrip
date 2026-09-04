use crate::error::{CuaError, ErrorCode, Result};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
struct State {
    cancelled: AtomicBool,
    wake: Mutex<()>,
    signal: Condvar,
}

#[derive(Clone, Default)]
pub struct Cancellation(Arc<State>);

impl Cancellation {
    pub fn cancel(&self) {
        let _guard = self.0.wake.lock().unwrap();
        self.0.cancelled.store(true, Ordering::Release);
        self.0.signal.notify_all();
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    /// A bounded wait for cooperative native adapters and deterministic tests.
    /// Cancellation synchronizes with the waiter to avoid lost notifications.
    pub fn wait_cancelled(&self, timeout: std::time::Duration) -> bool {
        let guard = self.0.wake.lock().unwrap();
        let _result = self
            .0
            .signal
            .wait_timeout_while(guard, timeout, |_| !self.is_cancelled())
            .unwrap();
        self.is_cancelled()
    }
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(CuaError::new(
                ErrorCode::Cancelled,
                "CUA request cancelled.",
            ))
        } else {
            Ok(())
        }
    }
}
