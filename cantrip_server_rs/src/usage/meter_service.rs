//! Retry-safe asynchronous flushes, cadence, callback isolation and shutdown.
use super::{
    FlushBatch, FlushResult,
    meter::{Measurement, NormalizedMeasurement, Options, State, Stats},
};
use anyhow::Result;
use chrono::{DateTime, Utc};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::AbortHandle;

pub type Sink = Arc<dyn Fn(FlushBatch) -> BoxFuture<'static, Result<FlushResult>> + Send + Sync>;
pub type Observer = Arc<dyn Fn(&NormalizedMeasurement) -> Result<()> + Send + Sync>;
pub type Publisher = Arc<dyn Fn(Vec<String>) -> Result<()> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;
pub type WallClock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Completion = Shared<BoxFuture<'static, bool>>;
struct Control {
    state: State,
    in_flight: Option<Completion>,
    timer: Option<AbortHandle>,
    scheduled: bool,
    last_automatic_start: Option<i64>,
}
pub struct Meter {
    control: Mutex<Control>,
    sink: Sink,
    observe: Option<Observer>,
    publish: Option<Publisher>,
    now: Clock,
    wall: WallClock,
}
fn log(event: &str, reason: &str) {
    eprintln!(
        "{}",
        serde_json::json!({"event":event,"subsystem":"account-usage","reasonCode":reason})
    );
}
impl Meter {
    pub fn new(
        options: Options,
        sink: Sink,
        observe: Option<Observer>,
        publish: Option<Publisher>,
    ) -> Result<Arc<Self>> {
        Self::with_clocks(
            options,
            sink,
            observe,
            publish,
            Arc::new(crate::auth::now),
            Arc::new(|| Utc::now().timestamp_millis()),
        )
    }
    pub fn with_clocks(
        options: Options,
        sink: Sink,
        observe: Option<Observer>,
        publish: Option<Publisher>,
        now: Clock,
        wall: WallClock,
    ) -> Result<Arc<Self>> {
        let meter = Arc::new(Self {
            control: Mutex::new(Control {
                state: State::new(options)?,
                in_flight: None,
                timer: None,
                scheduled: false,
                last_automatic_start: None,
            }),
            sink,
            observe,
            publish,
            now,
            wall,
        });
        meter.schedule_interval();
        Ok(meter)
    }
    pub fn record(self: &Arc<Self>, measurement: Measurement) -> bool {
        let outcome = {
            let mut control = self.control.lock().unwrap();
            if control.state.closed {
                return false;
            }
            control.state.record_with_hooks(
                measurement,
                Some((self.now)()),
                |value| {
                    if self
                        .observe
                        .as_ref()
                        .is_some_and(|observe| observe(value).is_err())
                    {
                        log("account-usage.observer.failed", "observer-failed");
                    }
                },
                |_| log("account-usage.meter.dropped", "buffer-capacity-reached"),
            )
        };
        if outcome == super::meter::RecordOutcome::Recorded {
            self.schedule_threshold();
        }
        outcome.accepted()
    }
    pub fn stats(&self) -> Stats {
        self.control.lock().unwrap().state.stats()
    }
    pub fn flush(self: &Arc<Self>) -> Completion {
        let mut control = self.control.lock().unwrap();
        if let Some(in_flight) = &control.in_flight {
            return in_flight.clone();
        }
        if !control.state.has_work() {
            return futures::future::ready(true).boxed().shared();
        }
        let batch = if let Some(pending) = control.state.pending_batch() {
            pending
        } else {
            control
                .state
                .capture((self.now)())
                .expect("buffered usage batch")
        };
        let meter = self.clone();
        let started = (self.wall)();
        let completion = async move {
            let result = (meter.sink)(batch).await;
            let duration = (meter.wall)() - started;
            let (success, owners) = {
                let mut control = meter.control.lock().unwrap();
                match result {
                    Ok(result) => match control.state.committed(result, (meter.now)(), duration) {
                        Ok(owners) => (true, owners),
                        Err(_) => {
                            log(
                                "account-usage.bandwidth-flush.failed",
                                "completion-state-failed",
                            );
                            (false, vec![])
                        }
                    },
                    Err(_) => {
                        control.state.failed(duration);
                        log(
                            "account-usage.bandwidth-flush.failed",
                            "database-write-failed",
                        );
                        (false, vec![])
                    }
                }
            };
            if !owners.is_empty()
                && meter
                    .publish
                    .as_ref()
                    .is_some_and(|publish| publish(owners).is_err())
            {
                log("account-usage.live-invalidation.failed", "callback-failed");
            }
            meter.control.lock().unwrap().in_flight = None;
            meter.schedule_threshold();
            success
        }
        .boxed()
        .shared();
        control.in_flight = Some(completion.clone());
        drop(control);
        // Drive the shared operation even when its caller intentionally does
        // not await it, as the Node meter does for automatic flushes.
        tokio::spawn(completion.clone());
        completion
    }
    pub async fn close(self: &Arc<Self>) {
        {
            let mut control = self.control.lock().unwrap();
            if control.state.closed {
                return;
            }
            control.state.closed = true;
            if let Some(timer) = control.timer.take() {
                timer.abort();
            }
        }
        let succeeded = self.flush().await;
        let retry = !succeeded && self.control.lock().unwrap().state.has_work();
        if retry {
            self.flush().await;
        }
    }
    fn automatic_due(&self, control: &Control) -> bool {
        control.last_automatic_start.is_none_or(|last| {
            (self.wall)() - last >= control.state.options.flush_interval_ms as i64
        })
    }
    fn schedule_threshold(self: &Arc<Self>) {
        {
            let mut control = self.control.lock().unwrap();
            if control.state.closed
                || control.scheduled
                || !control.state.flush_due()
                || !self.automatic_due(&control)
            {
                return;
            }
            control.scheduled = true;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            let Some(meter) = weak.upgrade() else {
                return;
            };
            let due = {
                let mut control = meter.control.lock().unwrap();
                control.scheduled = false;
                meter.automatic_due(&control)
            };
            if due {
                meter.start_automatic();
            }
        });
    }
    fn start_automatic(self: &Arc<Self>) {
        if self.control.lock().unwrap().state.closed {
            return;
        }
        self.schedule_interval();
        {
            let mut control = self.control.lock().unwrap();
            if !control.state.has_work() {
                return;
            }
            control.last_automatic_start = Some((self.wall)());
        }
        drop(self.flush());
    }
    fn schedule_interval(self: &Arc<Self>) {
        let mut control = self.control.lock().unwrap();
        if control.state.closed {
            return;
        }
        if let Some(timer) = control.timer.take() {
            timer.abort();
        }
        // Node's timer API clamps an otherwise valid oversized delay to 1 ms.
        let configured = control.state.options.flush_interval_ms;
        let delay = if configured > i32::MAX as u64 {
            1
        } else {
            configured
        };
        let weak = Arc::downgrade(self);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(delay);
        control.timer = Some(
            tokio::spawn(async move {
                tokio::time::sleep_until(deadline).await;
                if let Some(meter) = weak.upgrade() {
                    meter.start_automatic();
                }
            })
            .abort_handle(),
        );
    }
}
impl Drop for Meter {
    fn drop(&mut self) {
        if let Some(timer) = self.control.get_mut().unwrap().timer.take() {
            timer.abort();
        }
    }
}
