use super::*;
use std::sync::{OnceLock, Weak, atomic::AtomicUsize};
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_requests_allow_a_reentrant_transport_reply() {
    let owner = Arc::new(OnceLock::<Weak<Inner>>::new());
    let observed = Arc::new(Mutex::new(Vec::new()));
    let capture = observed.clone();
    let callback = owner.clone();
    let requests = Requests::new(Ports {
        send: Arc::new(move |message| {
            let client = Requests(callback.get().unwrap().upgrade().unwrap());
            // The transport can synchronously reenter the registered request.
            let reply = json!({"id":message["id"],"result":message["params"]});
            capture
                .lock()
                .unwrap()
                .push(message["id"].as_u64().unwrap());
            assert!(client.handle_response(&reply, &reply));
            Ok(())
        }),
        record: Arc::new(|_, _| {}),
        policy: Policy::default(),
        runtime_id: None,
        logs: None,
    });
    assert!(owner.set(Arc::downgrade(&requests.0)).is_ok());
    let mut tasks = tokio::task::JoinSet::new();
    for index in 0..12 {
        let client = requests.clone();
        tasks.spawn(async move {
            assert_eq!(
                client
                    .request("echo".into(), Some(json!(index)), None, None)
                    .await
                    .unwrap(),
                Some(json!(index))
            );
        });
    }
    while let Some(task) = tasks.join_next().await {
        task.unwrap();
    }
    let mut ids = observed.lock().unwrap().clone();
    ids.sort_unstable();
    assert_eq!(ids, (1..=12).collect::<Vec<_>>());
    assert_eq!(requests.pending_count(), 0);
}
struct Observer {
    replied: AtomicUsize,
    not_sent: AtomicUsize,
}
impl Settlement for Observer {
    fn replied(&self) -> Result<()> {
        self.replied.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn not_sent(&self) -> Result<()> {
        self.not_sent.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observation_timeout_retains_private_settlement_until_the_native_reply() {
    let diagnostics = Arc::new(Mutex::new(Vec::<Value>::new()));
    let capture = diagnostics.clone();
    let requests = Requests::new(Ports {
        send: Arc::new(|_| Ok(())),
        record: Arc::new(move |value, _| {
            capture.lock().unwrap().push(value);
        }),
        policy: Policy::default(),
        runtime_id: None,
        logs: None,
    });
    let observer = Arc::new(Observer {
        replied: AtomicUsize::new(0),
        not_sent: AtomicUsize::new(0),
    });
    let error = requests
        .request(
            "cantrip/inference".into(),
            Some(json!({})),
            Some(Duration::from_millis(1)),
            Some(observer.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(error.downcast_ref::<Failure>().unwrap().kind, "observation");
    assert_eq!(requests.pending_count(), 0);
    assert_eq!(observer.replied.load(Ordering::SeqCst), 0);
    let reply = json!({"id":"01","error":json!({"code":-1,"message":"PRIVATE_NATIVE_LABEL","data":"private"})});
    let payload = requests.diagnostic_payload(&reply);
    assert_eq!(
        payload,
        json!({"id":"01","privateInference":true,"status":"failed"})
    );
    assert!(requests.handle_response(&reply, &payload));
    assert_eq!(observer.replied.load(Ordering::SeqCst), 1);
    assert!(
        !diagnostics
            .lock()
            .unwrap()
            .iter()
            .any(|v| v.stringify().contains("PRIVATE_NATIVE_LABEL"))
    );
    drop(requests.request(
        "cantrip/inference".into(),
        Some(json!({})),
        None,
        Some(observer.clone()),
    ));
    requests.reject_all("transport lost".into());
    assert_eq!(observer.replied.load(Ordering::SeqCst), 1);
    assert_eq!(observer.not_sent.load(Ordering::SeqCst), 0);
}
