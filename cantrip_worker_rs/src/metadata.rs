//! Idempotent metadata recovery only. Never replay native/model input here.
use anyhow::Result;
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{sync::watch, time::Instant};

/// Retains the owning runtime's original reason through cancellation races.
#[derive(Clone, Debug)]
pub struct Cancelled {
    error: Arc<anyhow::Error>,
    at: Instant,
}
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.error, f)
    }
}
impl std::error::Error for Cancelled {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.error.as_ref().as_ref())
    }
}
#[derive(Clone)]
pub struct Signal(watch::Receiver<Option<Cancelled>>);
pub struct Abort(watch::Sender<Option<Cancelled>>);
impl Abort {
    pub fn new() -> (Self, Signal) {
        let (send, receive) = watch::channel(None);
        (Self(send), Signal(receive))
    }
    pub fn abort(&self, reason: anyhow::Error) {
        let reason = Cancelled {
            error: Arc::new(reason),
            at: Instant::now(),
        };
        self.0.send_if_modified(|current| {
            if current.is_none() {
                *current = Some(reason);
                true
            } else {
                false
            }
        });
    }
}
impl Signal {
    fn reason(&self) -> Option<Cancelled> {
        self.0.borrow().clone()
    }
    pub fn check(&self) -> Result<()> {
        match self.reason() {
            Some(reason) => Err(reason.into()),
            None => Ok(()),
        }
    }
    async fn cancelled(&self) -> Cancelled {
        let mut receiver = self.0.clone();
        loop {
            if let Some(reason) = receiver.borrow_and_update().clone() {
                return reason;
            }
            if receiver.changed().await.is_err() {
                // Dropping a controller is not an abort, as with AbortSignal.
                return std::future::pending().await;
            }
        }
    }
}
#[derive(Debug)]
pub struct TimedOut;
impl std::fmt::Display for TimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The operation was aborted due to timeout")
    }
}
impl std::error::Error for TimedOut {}

/// Node timers/promises wraps cancellation during backoff, retaining its cause.
#[derive(Debug)]
pub struct DelayAborted(anyhow::Error);
impl std::fmt::Display for DelayAborted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The operation was aborted")
    }
}
impl std::error::Error for DelayAborted {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}

#[derive(Clone)]
pub(crate) struct Guard {
    caller: Option<Signal>,
    transport: Option<Signal>,
    deadline: Option<Instant>,
    initial: Option<Cancelled>,
}
async fn cancelled(signal: &Option<Signal>) -> Cancelled {
    match signal {
        Some(signal) => signal.cancelled().await,
        None => std::future::pending().await,
    }
}
impl Guard {
    pub fn request(caller: Option<Signal>) -> Self {
        let initial = caller.as_ref().and_then(Signal::reason);
        Self {
            caller,
            transport: None,
            deadline: None,
            initial,
        }
    }
    pub fn metadata(caller: Option<Signal>, transport: Option<Signal>) -> Self {
        // AbortSignal.any selects the first already-aborted input in input order.
        let initial = caller
            .as_ref()
            .and_then(Signal::reason)
            .or_else(|| transport.as_ref().and_then(Signal::reason));
        Self {
            caller,
            transport,
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            initial,
        }
    }
    pub fn check(&self) -> Result<()> {
        if let Some(reason) = &self.initial {
            return Err(reason.clone().into());
        }
        let reason = [self.caller.as_ref(), self.transport.as_ref()]
            .into_iter()
            .flatten()
            .filter_map(Signal::reason)
            .min_by_key(|reason| reason.at);
        if self.deadline.is_some_and(|deadline| {
            Instant::now() >= deadline && reason.as_ref().is_none_or(|reason| deadline <= reason.at)
        }) {
            return Err(TimedOut.into());
        }
        if let Some(reason) = reason {
            return Err(reason.into());
        }
        Ok(())
    }
    pub async fn delay(&self, milliseconds: u64) -> Result<()> {
        self.run(async {
            tokio::time::sleep(Duration::from_millis(milliseconds)).await;
            Ok(())
        })
        .await
        .map_err(|error| DelayAborted(error).into())
    }
    pub async fn run<T>(&self, operation: impl Future<Output = Result<T>>) -> Result<T> {
        self.check()?;
        let deadline = async {
            match self.deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            _ = cancelled(&self.caller) => { self.check()?; unreachable!() },
            _ = cancelled(&self.transport) => { self.check()?; unreachable!() },
            () = deadline => { self.check()?; unreachable!() },
            result = operation => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    #[tokio::test]
    async fn live_parent_order_and_backoff_cause_survive_late_observation() {
        let (caller, caller_signal) = Abort::new();
        let (transport, transport_signal) = Abort::new();
        let guard = Guard::metadata(Some(caller_signal), Some(transport_signal));
        transport.abort(crate::error::WireError("first transport stop".into()).into());
        caller.abort(anyhow!("later caller stop"));
        let error = guard
            .run(std::future::pending::<Result<()>>())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "first transport stop");
        let error = guard.delay(1).await.unwrap_err();
        assert!(error.is::<DelayAborted>());
        assert_eq!(error.to_string(), "The operation was aborted");
        assert_eq!(
            crate::error::message(&error),
            "The operation was aborted".into()
        );
        assert!(
            error
                .chain()
                .any(|cause| cause.to_string() == "first transport stop")
        );
    }

    #[tokio::test]
    async fn already_aborted_inputs_use_input_order_without_dispatch() {
        let (caller, caller_signal) = Abort::new();
        let (transport, transport_signal) = Abort::new();
        transport.abort(anyhow!("older transport stop"));
        caller.abort(anyhow!("first input stop"));
        let guard = Guard::metadata(Some(caller_signal), Some(transport_signal));
        let error = guard
            .run::<()>(async { panic!("aborted request dispatched") })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "first input stop");
    }

    #[tokio::test]
    async fn expired_deadline_wins_over_a_later_parent_abort() {
        let (caller, signal) = Abort::new();
        let mut guard = Guard::metadata(Some(signal), None);
        guard.deadline = Some(Instant::now());
        tokio::task::yield_now().await;
        caller.abort(anyhow!("later abort"));
        let error = guard
            .run(std::future::pending::<Result<()>>())
            .await
            .unwrap_err();
        assert!(error.is::<TimedOut>());
    }
}
