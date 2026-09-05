use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

const LIMIT: usize = 16;
const DEADLINE: Duration = Duration::from_secs(10);

#[derive(Default, Clone)]
pub(super) struct NativeCalls(Arc<AtomicUsize>);
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct Pending<T> {
    _permit: Permit,
    cancellation: Cancellation,
    retired: AtomicBool,
    sender: crossbeam_channel::Sender<Result<T>>,
}

type PendingReceiver<T> = (Arc<Pending<T>>, crossbeam_channel::Receiver<Result<T>>);

impl NativeCalls {
    pub(super) fn begin<T>(&self, cancellation: &Cancellation) -> Result<PendingReceiver<T>> {
        cancellation.check()?;
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < LIMIT).then_some(count + 1)
            })
            .map_err(|_| {
                CuaError::new(
                    ErrorCode::Capacity,
                    "macOS is still finishing previous capture requests.",
                )
            })?;
        let (sender, receiver) = crossbeam_channel::bounded(1);
        Ok((
            Arc::new(Pending {
                _permit: Permit(self.0.clone()),
                cancellation: cancellation.clone(),
                retired: AtomicBool::new(false),
                sender,
            }),
            receiver,
        ))
    }
}

impl<T> Pending<T> {
    pub(super) fn cancelled(&self) -> bool {
        self.retired.load(Ordering::Acquire) || self.cancellation.is_cancelled()
    }
    pub(super) fn deliver(&self, result: Result<T>) {
        if !self.cancelled() {
            let _ = self.sender.try_send(result);
        }
    }
    pub(super) fn wait(&self, receiver: &crossbeam_channel::Receiver<Result<T>>) -> Result<T> {
        self.wait_for(receiver, DEADLINE)
    }
    fn wait_for(
        &self,
        receiver: &crossbeam_channel::Receiver<Result<T>>,
        timeout: Duration,
    ) -> Result<T> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Err(error) = self.cancellation.check() {
                self.retired.store(true, Ordering::Release);
                return Err(error);
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                self.retired.store(true, Ordering::Release);
                return Err(CuaError::new(
                    ErrorCode::CaptureFailed,
                    "macOS did not complete capture before its deadline.",
                ));
            };
            match receiver.recv_timeout(remaining.min(Duration::from_millis(10))) {
                Ok(result) => {
                    self.cancellation.check()?;
                    return result;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    return Err(CuaError::new(
                        ErrorCode::CaptureFailed,
                        "macOS capture ended without a result.",
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sixteen_unresolved_completions_are_bounded_until_the_native_callback_drops() {
        let calls = NativeCalls::default();
        let cancel = Cancellation::default();
        let mut pending = Vec::new();
        for _ in 0..16 {
            pending.push(calls.begin::<()>(&cancel).unwrap());
        }
        assert_eq!(
            calls.begin::<()>(&cancel).err().unwrap().code,
            ErrorCode::Capacity
        );
        pending.pop();
        assert!(calls.begin::<()>(&cancel).is_ok());
        pending.clear();
        assert_eq!(calls.0.load(Ordering::Acquire), 0);
    }
    #[test]
    fn cancellation_and_deadline_release_waiter_without_accepting_late_results() {
        let calls = NativeCalls::default();
        let cancel = Cancellation::default();
        let (pending, receiver) = calls.begin::<u8>(&cancel).unwrap();
        cancel.cancel();
        assert_eq!(
            pending.wait(&receiver).unwrap_err().code,
            ErrorCode::Cancelled
        );
        pending.deliver(Ok(1));
        assert!(receiver.try_recv().is_err());
        let (pending, receiver) = calls.begin::<u8>(&Cancellation::default()).unwrap();
        assert_eq!(
            pending
                .wait_for(&receiver, Duration::ZERO)
                .unwrap_err()
                .code,
            ErrorCode::CaptureFailed
        );
        pending.deliver(Ok(1));
        assert!(receiver.try_recv().is_err());
    }
    #[test]
    fn callback_delivery_never_blocks_or_replays() {
        let (pending, receiver) = NativeCalls::default()
            .begin(&Cancellation::default())
            .unwrap();
        pending.deliver(Ok(1));
        pending.deliver(Ok(2));
        assert_eq!(pending.wait(&receiver).unwrap(), 1);
    }
}
