use anyhow::{Result, anyhow};
use cantrip_server::usage::background::{Followup, Job, Operation, Outcome};
use chrono::DateTime;
use futures::FutureExt;
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering::SeqCst},
    },
    time::Duration,
};
use tokio::sync::oneshot;
#[derive(Default)]
struct Probe {
    calls: AtomicUsize,
    followups: AtomicUsize,
    fail_followup: AtomicBool,
    clock: AtomicI64,
    replies: Mutex<VecDeque<oneshot::Sender<Result<Outcome>>>>,
}
impl Probe {
    fn job(self: &Arc<Self>) -> Arc<Job> {
        let probe = self.clone();
        let operation: Operation = Arc::new(move |_| {
            probe.calls.fetch_add(1, SeqCst);
            let (send, receive) = oneshot::channel();
            probe.replies.lock().unwrap().push_back(send);
            async move { receive.await? }.boxed()
        });
        let probe = self.clone();
        let followup: Followup = Arc::new(move |_, _| {
            probe.followups.fetch_add(1, SeqCst);
            let result = if probe.fail_followup.load(SeqCst) {
                Err(anyhow!("totals unavailable"))
            } else {
                Ok(Some(json!({"total":"123"})))
            };
            futures::future::ready(result).boxed()
        });
        let probe = self.clone();
        Job::with_clock(
            "test-maintenance",
            1000,
            operation,
            followup,
            Some(json!({"total":"0"})),
            Arc::new(move || {
                DateTime::from_timestamp_millis(1_793_059_200_000 + probe.clock.load(SeqCst))
                    .unwrap()
            }),
        )
        .unwrap()
    }
    fn reply(&self, acquired: bool) {
        assert!(
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap()
                .send(Ok(Outcome {
                    acquired,
                    value: json!({"acquired":acquired,"rows":7})
                }))
                .is_ok()
        );
    }
    fn fail(&self) {
        assert!(
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap()
                .send(Err(anyhow!("database failure")))
                .is_ok()
        );
    }
    async fn advance(&self, millis: i64) {
        self.clock.fetch_add(millis, SeqCst);
        tokio::time::advance(Duration::from_millis(millis as u64)).await;
        settle().await;
    }
}
async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn scheduled_runs_share_work_and_shutdown_drains_it_before_closing() {
    let probe = Arc::new(Probe::default());
    let job = probe.job();
    job.start(false);
    job.start(true);
    probe.advance(999).await;
    assert_eq!(probe.calls.load(SeqCst), 0);
    probe.advance(1).await;
    assert_eq!(probe.calls.load(SeqCst), 1);
    assert!(job.stats().running);
    let first = job.run();
    let second = job.run();
    probe.advance(1000).await;
    assert_eq!(probe.calls.load(SeqCst), 1);
    let closing_job = job.clone();
    let closing = tokio::spawn(async move { closing_job.close().await });
    settle().await;
    assert!(!closing.is_finished());
    assert!(job.run().await.is_none());
    probe.reply(true);
    let a = first.await.unwrap();
    let b = second.await.unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    closing.await.unwrap();
    let stats = job.stats();
    assert_eq!(stats.completion_count, 1.0);
    assert_eq!(stats.failure_count, 0.0);
    assert_eq!(stats.last_duration_ms, Some(1000));
    assert!(!stats.running);
    assert_eq!(stats.totals, Some(json!({"total":"123"})));
    job.start(true);
    probe.advance(10_000).await;
    assert_eq!(probe.calls.load(SeqCst), 1);
}
#[tokio::test(start_paused = true)]
async fn contention_still_refreshes_totals_without_counting_a_successful_lease() {
    let probe = Arc::new(Probe::default());
    let job = probe.job();
    let running = job.run();
    settle().await;
    probe.reply(false);
    assert_eq!(
        running.await.unwrap().as_ref(),
        &json!({"acquired":false,"rows":7})
    );
    let stats = job.stats();
    assert_eq!(stats.completion_count, 0.0);
    assert_eq!(stats.lease_contention_count, 1.0);
    assert_eq!(stats.last_successful_at, None);
    assert!(stats.last_completed_at.is_some());
    assert_eq!(stats.totals, Some(json!({"total":"123"})));
    assert_eq!(probe.followups.load(SeqCst), 1);
    job.close().await;
}
#[tokio::test(start_paused = true)]
async fn totals_or_callback_failure_keeps_committed_result_and_also_records_failure() {
    let probe = Arc::new(Probe::default());
    probe.fail_followup.store(true, SeqCst);
    let job = probe.job();
    let running = job.run();
    settle().await;
    probe.clock.store(20, SeqCst);
    probe.reply(true);
    assert!(running.await.is_none());
    let stats = job.stats();
    assert_eq!(stats.completion_count, 1.0);
    assert_eq!(stats.failure_count, 1.0);
    assert_eq!(stats.last_result, Some(json!({"acquired":true,"rows":7})));
    assert_eq!(stats.last_successful_at, stats.last_completed_at);
    assert_eq!(stats.last_error_at, stats.last_completed_at);
    assert_eq!(stats.last_duration_ms, Some(20));
    assert_eq!(stats.totals, Some(json!({"total":"0"})));
    job.close().await;
}
#[tokio::test(start_paused = true)]
async fn repository_failure_does_not_publish_or_replace_previous_totals_and_can_retry() {
    let probe = Arc::new(Probe::default());
    let job = probe.job();
    let running = job.run();
    settle().await;
    probe.fail();
    assert!(running.await.is_none());
    let stats = job.stats();
    assert_eq!(stats.failure_count, 1.0);
    assert_eq!(stats.last_completed_at, None);
    assert_eq!(stats.last_result, None);
    assert_eq!(probe.followups.load(SeqCst), 0);
    let retry = job.run();
    settle().await;
    probe.reply(true);
    assert!(retry.await.is_some());
    assert_eq!(job.stats().failure_count, 1.0);
    assert_eq!(job.stats().completion_count, 1.0);
    job.close().await;
}
