use anyhow::{Result, anyhow};
use cantrip_server::usage::{
    FlushBatch, FlushResult,
    meter::{Counter, MAX_SAFE_INTEGER, Measurement, Options},
    meter_service::{Meter, Observer, Publisher, Sink},
};
use chrono::{DateTime, Utc};
use futures::FutureExt;
use num_bigint::BigInt;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicUsize, Ordering::SeqCst},
    },
    time::Duration,
};
use tokio::sync::oneshot;

#[derive(Default)]
struct Probe {
    batches: Mutex<Vec<FlushBatch>>,
    replies: Mutex<VecDeque<oneshot::Sender<Result<FlushResult>>>>,
    // Immediate success, immediate error, or an explicitly controlled reply.
    mode: AtomicU8,
    observations: AtomicUsize,
    publications: Mutex<Vec<Vec<String>>>,
    reject_callbacks: AtomicBool,
    clock: AtomicI64,
    clock_reads: AtomicUsize,
}
fn success() -> FlushResult {
    FlushResult {
        applied: true,
        owner_ids: vec!["owner".into()],
    }
}
impl Probe {
    fn count(&self) -> usize {
        self.batches.lock().unwrap().len()
    }
    fn reply(&self, result: Result<FlushResult>) {
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap()
            .send(result)
            .unwrap();
    }
    async fn advance(&self, millis: i64) {
        self.clock.fetch_add(millis, SeqCst);
        tokio::time::advance(Duration::from_millis(millis as u64)).await;
        settle().await;
    }
    fn meter(self: &Arc<Self>, options: Options) -> Arc<Meter> {
        let probe = self.clone();
        let sink: Sink = Arc::new(move |batch| {
            probe.batches.lock().unwrap().push(batch);
            match probe.mode.load(SeqCst) {
                0 => futures::future::ready(Ok(success())).boxed(),
                1 => futures::future::ready(Err(anyhow!("ambiguous commit"))).boxed(),
                _ => {
                    let (send, receive) = oneshot::channel();
                    probe.replies.lock().unwrap().push_back(send);
                    async move { receive.await? }.boxed()
                }
            }
        });
        let probe = self.clone();
        let observe: Observer = Arc::new(move |_| {
            probe.observations.fetch_add(1, SeqCst);
            if probe.reject_callbacks.load(SeqCst) {
                anyhow::bail!("observer error")
            }
            Ok(())
        });
        let probe = self.clone();
        let publish: Publisher = Arc::new(move |owners| {
            probe.publications.lock().unwrap().push(owners);
            if probe.reject_callbacks.load(SeqCst) {
                anyhow::bail!("publisher error")
            }
            Ok(())
        });
        let clock = self.clone();
        let wall = self.clone();
        Meter::with_clocks(
            options,
            sink,
            Some(observe),
            Some(publish),
            Arc::new(move || {
                clock.clock_reads.fetch_add(1, SeqCst);
                DateTime::<Utc>::from_timestamp_millis(1_793_059_200_123 + clock.clock.load(SeqCst))
                    .unwrap()
            }),
            Arc::new(move || wall.clock.load(SeqCst)),
        )
        .unwrap()
    }
}
async fn settle() {
    // Drain spawned work without advancing virtual time or waiting on a DB.
    for _ in 0..24 {
        tokio::task::yield_now().await;
    }
}
fn measurement(bytes: u64) -> Measurement {
    Measurement {
        owner_id: "owner".into(),
        bytes: Counter::Integer(bytes.into()),
        operation_count: None,
        channel: "http".into(),
        direction: "ingress".into(),
        notify_change: None,
    }
}
fn options() -> Options {
    Options {
        meter_id: "meter-service-fixture".into(),
        ..Options::default()
    }
}

#[tokio::test(start_paused = true)]
async fn default_deadline_starts_at_construction_even_before_the_timer_task_is_polled() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(options());
    assert!(meter.record(measurement(1)));
    // Deliberately do not yield between construction and clock advancement.
    probe.advance(59_999).await;
    assert_eq!(probe.count(), 0);
    probe.advance(1).await;
    assert_eq!(probe.count(), 1);
    assert_eq!(meter.stats().buffered_entries, 0);
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn repeated_threshold_crossings_coalesce_until_the_next_cadence() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(Options {
        flush_interval_ms: 5_000,
        flush_threshold_bytes: 10.into(),
        ..options()
    });
    assert!(meter.record(measurement(10)));
    settle().await;
    assert_eq!(probe.count(), 1);
    for _ in 0..20 {
        assert!(meter.record(measurement(10)));
        probe.advance(100).await;
    }
    assert_eq!(probe.count(), 1);
    probe.advance(2_999).await;
    assert_eq!(probe.count(), 1);
    probe.advance(1).await;
    assert_eq!(probe.count(), 2);
    assert_eq!(
        probe.batches.lock().unwrap()[1].entries[0].bytes,
        BigInt::from(200)
    );
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn failed_automatic_flush_waits_for_cadence_and_retries_the_identical_receipt() {
    let probe = Arc::new(Probe::default());
    probe.mode.store(1, SeqCst);
    let meter = probe.meter(Options {
        flush_interval_ms: 5_000,
        flush_threshold_bytes: 10.into(),
        ..options()
    });
    meter.record(measurement(10));
    settle().await;
    assert_eq!(meter.stats().flush_failure_count, 1.0);
    probe.advance(4_999).await;
    assert_eq!(probe.count(), 1);
    probe.mode.store(0, SeqCst);
    probe.advance(1).await;
    assert_eq!(probe.count(), 2);
    let batches = probe.batches.lock().unwrap().clone();
    assert_eq!(
        serde_json::to_value(&batches[0]).unwrap(),
        serde_json::to_value(&batches[1]).unwrap()
    );
    assert_eq!(meter.stats().flush_count, 1.0);
    assert_eq!(meter.stats().buffered_entries, 0);
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn shared_flush_has_one_sink_call_and_preserves_measurements_arriving_in_flight() {
    let probe = Arc::new(Probe::default());
    probe.mode.store(2, SeqCst);
    let meter = probe.meter(options());
    meter.record(measurement(12));
    let first = meter.flush();
    let second = meter.flush();
    settle().await;
    assert_eq!(probe.count(), 1);
    meter.record(measurement(7));
    probe.reply(Ok(FlushResult {
        applied: false,
        ..success()
    }));
    assert!(first.await);
    assert!(second.await);
    assert_eq!(meter.stats().buffered_bytes, BigInt::from(7));
    assert_eq!(
        *probe.publications.lock().unwrap(),
        vec![vec!["owner".to_owned()]]
    );
    let next = meter.flush();
    settle().await;
    assert_eq!(
        probe.batches.lock().unwrap()[1].entries[0].bytes,
        BigInt::from(7)
    );
    probe.reply(Ok(success()));
    assert!(next.await);
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn flush_is_driven_without_awaiting_its_returned_completion() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(options());
    meter.record(measurement(12));
    drop(meter.flush());
    settle().await;
    assert_eq!(probe.count(), 1);
    assert_eq!(meter.stats().buffered_entries, 0);
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_waits_for_pending_work_and_retries_once_before_finishing() {
    let probe = Arc::new(Probe::default());
    probe.mode.store(2, SeqCst);
    let meter = probe.meter(options());
    meter.record(measurement(12));
    drop(meter.flush());
    settle().await;
    let closing_meter = meter.clone();
    let closing = tokio::spawn(async move { closing_meter.close().await });
    settle().await;
    assert!(!closing.is_finished());
    assert!(!meter.record(measurement(1)));
    probe.reply(Err(anyhow!("lost commit reply")));
    settle().await;
    assert!(!closing.is_finished());
    assert_eq!(probe.count(), 2);
    probe.reply(Ok(success()));
    closing.await.unwrap();
    assert_eq!(meter.stats().flush_failure_count, 1.0);
    assert_eq!(meter.stats().buffered_entries, 0);
    probe.advance(60_000).await;
    assert_eq!(probe.count(), 2);
}

#[tokio::test(start_paused = true)]
async fn failed_shutdown_is_bounded_and_repeated_close_does_not_retry_again() {
    let probe = Arc::new(Probe::default());
    probe.mode.store(1, SeqCst);
    let meter = probe.meter(options());
    meter.record(measurement(12));
    meter.close().await;
    assert_eq!(probe.count(), 2);
    assert_eq!(meter.stats().flush_failure_count, 2.0);
    assert_eq!(meter.stats().buffered_bytes, BigInt::from(12));
    meter.close().await;
    probe.advance(120_000).await;
    assert_eq!(probe.count(), 2);
}

#[tokio::test(start_paused = true)]
async fn observation_precedes_drops_and_callback_errors_do_not_undo_successful_flushes() {
    let probe = Arc::new(Probe::default());
    probe.reject_callbacks.store(true, SeqCst);
    let meter = probe.meter(Options {
        max_buffered_entries: 1,
        ..options()
    });
    assert!(meter.record(measurement(1)));
    let mut other = measurement(10);
    other.owner_id = "another-owner".into();
    assert!(!meter.record(other));
    assert!(!meter.record(measurement(i64::MAX as u64)));
    assert_eq!(probe.observations.load(SeqCst), 3);
    assert_eq!(meter.stats().dropped_measurements, BigInt::from(2));
    assert!(meter.flush().await);
    assert_eq!(meter.stats().flush_failure_count, 0.0);
    assert_eq!(meter.stats().flush_count, 1.0);
    assert_eq!(probe.publications.lock().unwrap().len(), 1);
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn observer_traffic_is_durable_without_publishing_another_usage_refresh() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(options());
    let mut input = measurement(12);
    input.notify_change = Some(false);
    assert!(meter.record(input));
    assert!(meter.flush().await);
    assert_eq!(probe.observations.load(SeqCst), 1);
    assert_eq!(probe.count(), 1);
    assert!(probe.publications.lock().unwrap().is_empty());
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn zero_and_rejected_records_do_not_schedule_a_threshold_flush_after_a_wall_clock_jump() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(Options {
        flush_interval_ms: 5_000,
        flush_threshold_bytes: 10.into(),
        ..options()
    });
    meter.record(measurement(10));
    settle().await;
    meter.record(measurement(10));
    probe.clock.store(10_000, SeqCst);
    let mut zero = measurement(0);
    zero.operation_count = Some(Counter::Number(0.0));
    assert!(meter.record(zero));
    let mut invalid = measurement(1);
    invalid.direction = "invalid".into();
    assert!(!meter.record(invalid));
    settle().await;
    assert_eq!(probe.count(), 1);
    assert_eq!(meter.stats().buffered_bytes, BigInt::from(10));
    meter.record(measurement(1));
    settle().await;
    assert_eq!(probe.count(), 2);
    meter.close().await;
}

#[tokio::test(start_paused = true)]
async fn empty_and_retry_flushes_and_closed_records_do_not_read_the_measurement_clock() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(options());
    assert_eq!(probe.clock_reads.load(SeqCst), 0);
    assert!(meter.flush().await);
    assert_eq!(probe.clock_reads.load(SeqCst), 0);
    meter.record(measurement(1));
    probe.mode.store(1, SeqCst);
    assert!(!meter.flush().await);
    assert_eq!(probe.clock_reads.load(SeqCst), 2);
    assert!(!meter.flush().await);
    assert_eq!(probe.clock_reads.load(SeqCst), 2);
    probe.mode.store(0, SeqCst);
    meter.close().await;
    assert_eq!(probe.clock_reads.load(SeqCst), 3);
    assert!(!meter.record(measurement(1)));
    assert_eq!(probe.clock_reads.load(SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn oversized_but_valid_node_timer_delay_is_clamped_to_one_millisecond() {
    let probe = Arc::new(Probe::default());
    let meter = probe.meter(Options {
        flush_interval_ms: MAX_SAFE_INTEGER,
        ..options()
    });
    meter.record(measurement(1));
    probe.advance(1).await;
    assert_eq!(probe.count(), 1);
    meter.close().await;
}
