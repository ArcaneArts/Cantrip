use super::*;
use cantrip_history::cursor::Tracker;
use std::collections::VecDeque;
pub(super) type Reply<T> = oneshot::Sender<std::result::Result<T, Failure>>;
pub(super) struct Pending {
    pub frame: Value,
    pub revision: Option<u64>,
}
pub(super) struct Timer {
    pub id: u64,
    pub abort: tokio::task::AbortHandle,
}
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Read = 0,
    Write = 1,
    Notify = 2,
}
pub(super) struct State {
    pub ready: bool,
    pub observing: bool,
    pub stopped: bool,
    pub writing: bool,
    pub reading: bool,
    pub notifying: bool,
    pub dirty: bool,
    pub revision: u64,
    pub write_failures: u32,
    pub read_failures: u32,
    pub notify_failures: u32,
    pub pending: VecDeque<Pending>,
    pub cursors: Tracker,
    pub awaiting_context: Option<JsString>,
    pub notification: Option<Arc<Value>>,
    pub next_timer: u64,
    pub timers: [Option<Timer>; 3],
    pub snapshots: Vec<(u64, Reply<Snapshot>)>,
    pub flushes: Vec<Reply<()>>,
    pub stopped_waiters: Vec<Reply<()>>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            ready: false,
            observing: true,
            stopped: false,
            writing: false,
            reading: false,
            notifying: false,
            dirty: false,
            revision: 0,
            write_failures: 0,
            read_failures: 0,
            notify_failures: 0,
            pending: VecDeque::new(),
            cursors: Tracker::default(),
            awaiting_context: None,
            notification: None,
            next_timer: 0,
            timers: [None, None, None],
            snapshots: Vec::new(),
            flushes: Vec::new(),
            stopped_waiters: Vec::new(),
        }
    }
}
impl State {
    pub fn cancel_timer(&mut self, kind: Kind) {
        if let Some(timer) = self.timers[kind as usize].take() {
            timer.abort.abort();
        }
    }
    pub fn end_observation(&mut self, error: Failure) {
        self.observing = false;
        self.dirty = false;
        self.cancel_timer(Kind::Read);
        for (_, waiter) in self.snapshots.drain(..) {
            let _ = waiter.send(Err(error.clone()));
        }
    }
    pub fn check_flushed(&mut self) {
        if self.stopped && !self.writing && !self.notifying {
            for waiter in self.stopped_waiters.drain(..) {
                let _ = waiter.send(Ok(()));
            }
        }
        if !self.pending.is_empty()
            || self.writing
            || self.notification.is_some()
            || self.notifying
            || (self.observing
                && (self.reading || self.dirty || self.timers[Kind::Read as usize].is_some()))
        {
            return;
        }
        for waiter in self.flushes.drain(..) {
            let _ = waiter.send(Ok(()));
        }
    }
}
