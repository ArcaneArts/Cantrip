//! A sealed unused reservation keeps its canonical claim until the actual
//! transfer owner acknowledges its durable handoff. Waiting owns no capacity.
use super::admission::{Complete, Phase, Promise};
use crate::metadata::{Guard, Signal};
use anyhow::Result;
use cantrip_history::projection::Work;
use std::sync::Arc;
struct Inner {
    acknowledge: Complete<()>,
    acknowledged: Promise<()>,
}
#[derive(Clone)]
pub struct Withdrawal(Arc<Inner>);
impl Default for Withdrawal {
    fn default() -> Self {
        Self::new()
    }
}
impl Withdrawal {
    pub fn new() -> Self {
        let (acknowledge, acknowledged) = Promise::pair();
        Self(Arc::new(Inner {
            acknowledge,
            acknowledged,
        }))
    }
    pub fn acknowledge(&self) {
        self.0.acknowledge.finish(Ok(()));
    }
    pub fn wait(&self, signal: Option<Signal>) -> Work<()> {
        self.wait_observed(signal, None)
    }
    pub fn wait_observed(
        &self,
        signal: Option<Signal>,
        observe: Option<Arc<dyn Fn(Phase) -> Result<()> + Send + Sync>>,
    ) -> Work<()> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let guard = Guard::request(signal);
            guard.check()?;
            if let Some(observe) = &observe {
                observe(Phase::Suspended)?;
            }
            let result = guard.run(this.0.acknowledged.work()).await;
            if let Some(observe) = observe {
                observe(Phase::Released)?;
            }
            result
        })
    }
    pub fn in_error(error: &anyhow::Error) -> Option<Self> {
        error
            .chain()
            .find_map(|error| error.downcast_ref::<Self>().cloned())
    }
}
impl std::fmt::Debug for Withdrawal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InferenceWithdrawalError")
    }
}
impl std::fmt::Display for Withdrawal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The queued inference is moving to another provider.")
    }
}
impl std::error::Error for Withdrawal {}
