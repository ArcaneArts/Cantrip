use super::*;
use crate::{
    history::live::observation::{Hub, RuntimeHub},
    native_items::{obj, s},
};
use std::sync::atomic::{AtomicUsize, Ordering};
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timers_claim_one_writer_while_notifications_arrive_on_another_thread() -> Result<()> {
    let hub = Hub::default();
    hub.replace(Some("generation".into()));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let stored = Arc::new(Mutex::new(Vec::new()));
    let output = stored.clone();
    let working = active.clone();
    let max = maximum.clone();
    let capture = Capture::new(Options {
        runtime: Arc::new(RuntimeHub {
            hub: hub.clone(),
            read: Arc::new(|thread| {
                ready(Ok(obj([
                    ("thread", obj([("id", s(thread))])),
                    ("history", Value::Null),
                ])))
            }),
        }),
        thread_id: "thread".into(),
        append: Arc::new(move |frame| {
            let stored = output.clone();
            let active = working.clone();
            let maximum = max.clone();
            cantrip_transport::lifecycle::owned(async move {
                let simultaneous = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(simultaneous, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(1)).await;
                let ordinal = {
                    let mut stored = stored.lock().unwrap();
                    stored.push(frame);
                    stored.len()
                };
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(obj([("sequence", Value::Number(ordinal as f64))]))
            })
        }),
        on_persisted: None,
        on_error: None,
        timing: Timing::new(Some(1.), Some(2.), Some(0.))?,
    })?;
    capture.flush().await?;
    for _ in 0..50 {
        hub.notification(
            "item/completed".into(),
            obj([("threadId", s("thread"))]),
            None,
        );
    }
    capture.close().await?;
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
    let frames = stored.lock().unwrap();
    assert_eq!(frames.len(), 51);
    for (index, frame) in frames.iter().skip(1).enumerate() {
        assert_eq!(frame["sequence"].as_u64(), Some(index as u64 + 1));
    }
    Ok(())
}

#[test]
fn scheduling_limits_match_node_timer_ranges() {
    for (retry, max, snapshot) in [
        (0., 1., 0.),
        (2., 1., 0.),
        (1., 2., -1.),
        (1., 2., f64::NAN),
        (1., 2., 2147483648.),
    ] {
        assert!(Timing::new(Some(retry), Some(max), Some(snapshot)).is_err());
    }
    let timing = Timing::new(Some(2.), Some(10.), Some(0.)).unwrap();
    assert_eq!(
        [
            timing.delay(1),
            timing.delay(2),
            timing.delay(3),
            timing.delay(100)
        ],
        [2, 4, 8, 10]
    );
}
