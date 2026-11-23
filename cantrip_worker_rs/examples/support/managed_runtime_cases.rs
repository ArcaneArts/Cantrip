use super::*;
use cantrip_worker::{
    codex::{
        admission::Acquire,
        managed::{Host, Launch, Profile, Runtime, Worker},
        private_inference::{Context, Hooks},
    },
    inference::{
        admission::{Manager, Options as AdmissionOptions, Source},
        ownership::Scope,
    },
};
use futures::FutureExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::oneshot;

const LIMIT: Duration = Duration::from_secs(12);

fn host(binary: PathBuf, root: &std::path::Path) -> Host {
    Host {
        binary,
        cwd: root.into(),
        environment: std::env::vars().collect(),
        compatibility: json!({"initialize":json!({"experimentalApi":true})}),
        logs: None,
    }
}

fn launch(id: &str, home: PathBuf) -> Launch {
    Launch {
        profile: Profile::new(id.into(), home),
        private_inference: Hooks {
            overlay: Arc::new(|_| Context::default()),
            provider: Arc::new(|| Some(provider())),
            before_inference: None,
        },
        on_revoked: None,
        prepare_home: None,
        external_auth: None,
        observe: Arc::new(|_| Ok(())),
    }
}

fn provider() -> Value {
    json!({"id":"fixture","maxConcurrentInference":1})
}

fn acquisition(runtime: &Runtime, id: &str) -> Result<Acquire> {
    let source = Source::claimed(id.into(), None);
    Ok(Acquire::new(
        runtime.admission().lifetime_for_source(&source)?,
        provider(),
    ))
}

async fn call(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    Ok(runtime
        .request(method.into(), Some(params), Some(LIMIT), None)
        .await?
        .unwrap_or(Value::Null))
}

pub(super) async fn run(binary: PathBuf) -> Result<()> {
    let root = tempfile::tempdir()?;
    tokio::time::timeout(LIMIT * 3, async {
        routed_peer(root.path()).await?;
        real_worker(root.path(), binary).await
    })
    .await??;
    println!("{}", json!({"status":"passed","nativeRuntimeOwner":true,"bundledCodex":true,"keeper":true,"modelCalls":0}).stringify());
    Ok(())
}

async fn routed_peer(root: &std::path::Path) -> Result<()> {
    let manager = Manager::new(AdmissionOptions::local(Scope {
        server_id: "server".into(),
        owner_id: "owner".into(),
        worker_id: "peer".into(),
        worker_generation: uuid::Uuid::new_v4().to_string().into(),
    }));
    let mut options = launch("peer", root.join("peer-home"));
    let observed = Arc::new(Mutex::new(Vec::new()));
    let notice = observed.clone();
    options.observe = Arc::new(move |event| {
        if let EventKind::Message(payload) = event.kind {
            notice.lock().unwrap().push(payload);
        }
        Ok(())
    });
    let runtime = Runtime::launch(
        host(std::env::current_exe()?, root),
        manager.clone(),
        options,
    )
    .await?;
    let result = async {
        let scope = "a282233a-59bc-47d9-9af2-05bb1eac8359";
        let notice = |phase: &str, attempt: &str| json!({
            "method":"thread/managedExecution/requested",
            "params":json!({"threadId":"thread","turnId":"turn","runnerGeneration":"runner","attemptId":attempt,
                "trigger":"inference","input":json!({"phase":phase,"scopeId":scope})})
        });
        let gate = notice("begin-independent", "begin");
        let marker = json!({"method":"fixture/marker","params":json!({})});
        call(&runtime, "fixture/notify", json!({"notices":[gate, marker.clone()]})).await?;
        let mut received = Vec::new();
        loop {
            let frames = call(&runtime, "fixture/received", Value::Null).await?;
            received.extend_from_slice(frames.as_array().unwrap());
            if received.iter().any(|frame| frame["method"] == "thread/managedExecution/resolve") {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(received.iter().any(|frame| frame["method"] == "thread/managedExecution/inferenceClaim"
            && frame["params"]["scopeId"] == scope));
        let resolve = received.iter().find(|frame| frame["method"] == "thread/managedExecution/resolve").unwrap();
        assert_eq!(resolve["params"]["allow"], true);
        assert_eq!(*observed.lock().unwrap(), vec![marker]);
        call(&runtime, "fixture/notify", json!({"notices":[notice("finish","finish")]})).await?;
        Ok::<_, anyhow::Error>(())
    }.await;
    let closed = runtime.close().await;
    let fenced = manager.close().await;
    result?;
    closed?;
    fenced?;
    runtime.retired().await?;
    assert!(!runtime.is_live());
    Ok(())
}

async fn real_worker(root: &std::path::Path, binary: PathBuf) -> Result<()> {
    let worker = Worker::new(
        host(binary, root),
        root.join("profile"),
        "worker".into(),
        uuid::Uuid::new_v4().to_string().into(),
        Arc::new(|| Ok(("server".into(), "owner".into()))),
    );
    let result = async {
        let home = root.join("runtime-home");
        let mut first_launch = launch("first", home.clone());
        let prepare_calls = Arc::new(AtomicUsize::new(0));
        let calls = prepare_calls.clone();
        let (unblock, barrier) = oneshot::channel();
        let barrier = Mutex::new(Some(barrier));
        first_launch.prepare_home = Some(Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            let barrier = barrier.lock().unwrap().take().unwrap();
            Box::pin(async {
                barrier.await?;
                Ok(())
            })
        }));
        let first = worker.launch(first_launch);
        let mut duplicate = worker.launch(launch("first", home.clone()));
        assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
        assert!(duplicate.as_mut().now_or_never().is_none());
        assert!(
            worker
                .launch(launch("first", root.join("wrong-home")))
                .await
                .is_err()
        );
        unblock.send(()).unwrap();
        let first = first.await?;
        let duplicate = duplicate.await?;
        assert_eq!(first.generation(), duplicate.generation());
        let result = call(
            &first,
            "thread/list",
            json!({"cursor":Value::Null,"limit":10,"archived":false}),
        )
        .await?;
        assert_eq!(result["data"], Value::Array(Vec::new()));

        let other = worker
            .launch(launch("other", root.join("other-home")))
            .await?;
        assert_ne!(other.generation(), first.generation());
        let ticket = first
            .admission()
            .acquire(acquisition(&first, "first-operation")?)
            .await?;
        let mut waiting = other
            .admission()
            .acquire(acquisition(&other, "second-operation")?);
        assert!(
            waiting.as_mut().now_or_never().is_none(),
            "both profiles share one provider slot"
        );
        ticket.not_dispatched()?;
        ticket.settled().await?;
        let second = waiting.await?;
        second.not_dispatched()?;
        second.settled().await?;

        first.close().await?;
        let replacement = worker.launch(launch("first", home)).await?;
        assert_ne!(replacement.generation(), first.generation());
        assert!(
            call(&first, "thread/list", json!({"limit":1}))
                .await
                .is_err()
        );

        let mut late = launch("closing", root.join("closing-home"));
        let (unblock, barrier) = oneshot::channel();
        let barrier = Mutex::new(Some(barrier));
        late.prepare_home = Some(Arc::new(move |_| {
            let barrier = barrier.lock().unwrap().take().unwrap();
            Box::pin(async {
                barrier.await?;
                Ok(())
            })
        }));
        let late = worker.launch(late);
        let mut closed = worker.close();
        assert!(
            closed.as_mut().now_or_never().is_none(),
            "shutdown waits for accepted startup"
        );
        assert!(
            worker
                .launch(launch("blocked", root.join("blocked-home")))
                .await
                .is_err()
        );
        unblock.send(()).unwrap();
        assert!(late.await.is_err());
        closed.await?;
        replacement.retired().await?;
        other.retired().await?;
        assert!(!replacement.is_live() && !other.is_live());
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let closed = worker.close().await;
    result?;
    closed
}
