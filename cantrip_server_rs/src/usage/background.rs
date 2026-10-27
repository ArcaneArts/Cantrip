//! Shared lifecycle for the two account-usage background services. Completion
//! is recorded before callbacks/operational totals, matching their Node order.
use super::{meter::MAX_SAFE_INTEGER, meter_service::Clock, types::iso};
use anyhow::{Result, ensure};
use chrono::{DateTime, Utc};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::AbortHandle;

pub struct Outcome {
    pub acquired: bool,
    pub value: Value,
}
pub type Operation =
    Arc<dyn Fn(DateTime<Utc>) -> BoxFuture<'static, Result<Outcome>> + Send + Sync>;
pub type Followup =
    Arc<dyn Fn(Arc<Value>, bool) -> BoxFuture<'static, Result<Option<Value>>> + Send + Sync>;
pub type Completion = Shared<BoxFuture<'static, Option<Arc<Value>>>>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub completion_count: f64,
    pub failure_count: f64,
    pub last_completed_at: Option<String>,
    pub last_duration_ms: Option<i64>,
    pub last_error_at: Option<String>,
    pub last_result: Option<Value>,
    pub last_successful_at: Option<String>,
    pub lease_contention_count: f64,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totals: Option<Value>,
}
struct Control {
    closed: bool,
    in_flight: Option<Completion>,
    timer: Option<AbortHandle>,
    stats: Stats,
}
pub struct Job {
    control: Mutex<Control>,
    interval_ms: u64,
    operation: Operation,
    followup: Followup,
    now: Clock,
    name: &'static str,
}
impl Job {
    pub fn new(
        name: &'static str,
        interval_ms: u64,
        operation: Operation,
        followup: Followup,
        totals: Option<Value>,
    ) -> Result<Arc<Self>> {
        Self::with_clock(
            name,
            interval_ms,
            operation,
            followup,
            totals,
            Arc::new(crate::auth::now),
        )
    }
    pub fn with_clock(
        name: &'static str,
        interval_ms: u64,
        operation: Operation,
        followup: Followup,
        totals: Option<Value>,
        now: Clock,
    ) -> Result<Arc<Self>> {
        ensure!(
            (1..=MAX_SAFE_INTEGER).contains(&interval_ms),
            "Account usage maintenance interval is invalid."
        );
        Ok(Arc::new(Self {
            control: Mutex::new(Control {
                closed: false,
                in_flight: None,
                timer: None,
                stats: Stats {
                    completion_count: 0.0,
                    failure_count: 0.0,
                    last_completed_at: None,
                    last_duration_ms: None,
                    last_error_at: None,
                    last_result: None,
                    last_successful_at: None,
                    lease_contention_count: 0.0,
                    running: false,
                    totals,
                },
            }),
            interval_ms,
            operation,
            followup,
            now,
            name,
        }))
    }
    pub fn start(self: &Arc<Self>, immediately: bool) {
        let mut control = self.control.lock().unwrap();
        if control.closed || control.timer.is_some() {
            return;
        }
        let delay = Duration::from_millis(if self.interval_ms > i32::MAX as u64 {
            1
        } else {
            self.interval_ms
        });
        let mut deadline = tokio::time::Instant::now() + delay;
        let weak = Arc::downgrade(self);
        control.timer = Some(
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep_until(deadline).await;
                    let Some(job) = weak.upgrade() else {
                        break;
                    };
                    drop(job.run());
                    drop(job);
                    deadline = tokio::time::Instant::now() + delay;
                }
            })
            .abort_handle(),
        );
        drop(control);
        if immediately {
            drop(self.run());
        }
    }
    pub fn run(self: &Arc<Self>) -> Completion {
        let mut control = self.control.lock().unwrap();
        if control.closed {
            return futures::future::ready(None).boxed().shared();
        }
        if let Some(in_flight) = &control.in_flight {
            return in_flight.clone();
        }
        let started = (self.now)();
        let job = self.clone();
        let completion = async move {
            let result = async {
                let result = (job.operation)(started).await?;
                let completed = (job.now)();
                let value = Arc::new(result.value);
                {
                    let mut control = job.control.lock().unwrap();
                    control.stats.last_completed_at = Some(iso(&completed));
                    control.stats.last_duration_ms = Some(completed.timestamp_millis() - started.timestamp_millis());
                    control.stats.last_result = Some(value.as_ref().clone());
                    if result.acquired {
                        control.stats.completion_count += 1.0;
                        control.stats.last_successful_at = control.stats.last_completed_at.clone();
                    } else { control.stats.lease_contention_count += 1.0; }
                }
                if let Some(totals) = (job.followup)(value.clone(),result.acquired).await? {
                    job.control.lock().unwrap().stats.totals = Some(totals);
                }
                eprintln!("{}",serde_json::json!({"event":format!("account-usage.{}.{}",job.name,if result.acquired{"completed"}else{"lease-unavailable"}),"subsystem":"account-usage","status":if result.acquired{"completed"}else{"skipped"}}));
                Ok::<_,anyhow::Error>(value)
            }.await;
            let value = match result {
                Ok(value) => Some(value),
                Err(_) => {
                    let failed = (job.now)();
                    let mut control = job.control.lock().unwrap();
                    control.stats.failure_count += 1.0;
                    control.stats.last_error_at = Some(iso(&failed));
                    control.stats.last_duration_ms = Some(failed.timestamp_millis() - started.timestamp_millis());
                    eprintln!("{}",serde_json::json!({"event":format!("account-usage.{}.failed",job.name),"subsystem":"account-usage","reasonCode":"database-error","status":"failed"}));
                    None
                }
            };
            job.control.lock().unwrap().in_flight = None;
            value
        }.boxed().shared();
        control.in_flight = Some(completion.clone());
        drop(control);
        tokio::spawn(completion.clone());
        completion
    }
    pub fn stats(&self) -> Stats {
        let control = self.control.lock().unwrap();
        Stats {
            running: control.in_flight.is_some(),
            ..control.stats.clone()
        }
    }
    pub async fn close(&self) {
        let running = {
            let mut control = self.control.lock().unwrap();
            control.closed = true;
            if let Some(timer) = control.timer.take() {
                timer.abort();
            }
            control.in_flight.clone()
        };
        if let Some(running) = running {
            running.await;
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(timer) = self.control.get_mut().unwrap().timer.take() {
            timer.abort();
        }
    }
}
