use super::*;
use cantrip_worker::{
    codex::{
        admission::{Acquire, Adapter, Execution},
        private_inference::{Context, FirstInput, Hooks, Router, Routing},
    },
    inference::{
        admission::{Manager, Options as AdmissionOptions, Source},
        ownership::Scope,
    },
};
use futures::FutureExt;

const SCOPE: &str = "bc9c6e57-8c43-4f42-9acb-79731e3ae036";
const INDEPENDENT: &str = "38ab1b83-d123-47fa-8e8d-8d281e9a133c";
const REQUESTED: &str = "thread/managedExecution/requested";
const CLAIM: &str = "thread/managedExecution/inferenceClaim";
const RESOLVE: &str = "thread/managedExecution/resolve";
const LIMIT: Duration = Duration::from_secs(6);

fn provider() -> Value {
    json!({"id":"fixture-provider","maxConcurrentInference":1})
}

fn control(thread: &str, scope: &str, attempt: &str, phase: &str) -> Value {
    json!({"method":REQUESTED,"params":json!({
        "threadId":thread, "turnId":"turn", "runnerGeneration":"runner", "attemptId":attempt, "trigger":"inference",
        "input":json!({"phase":phase,"scopeId":scope,"rootThreadId":thread})
    })})
}

struct Fixture<'a> {
    session: &'a Session,
    events: tokio::sync::mpsc::UnboundedReceiver<Event>,
    router: &'a Router,
}

impl Fixture<'_> {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        Ok(self
            .session
            .request(method.into(), Some(params), Some(LIMIT), None)
            .await?
            .unwrap_or(Value::Null))
    }

    async fn route(&mut self, notice: Value) -> Result<Work<()>> {
        self.request("fixture/notify", json!({"notices":[notice]}))
            .await?;
        let event = tokio::time::timeout(LIMIT, self.events.recv())
            .await?
            .ok_or_else(|| anyhow!("The app-server event stream closed"))?;
        match self.router.route(&event) {
            Routing::Private(task) | Routing::Observe(task) => Ok(task),
            Routing::Pass => bail!("Expected an inference or turn observation"),
        }
    }

    async fn frames(&self) -> Result<Vec<Value>> {
        Ok(self
            .request("fixture/received", Value::Null)
            .await?
            .as_array()
            .unwrap()
            .to_vec())
    }

    async fn wait_for_deny(&self, attempt: &str) -> Result<Vec<Value>> {
        tokio::time::timeout(LIMIT, async {
            let mut frames = Vec::new();
            loop {
                frames.extend(self.frames().await?);
                if frames.iter().any(|frame| {
                    frame["method"] == RESOLVE
                        && frame["params"]["attemptId"] == attempt
                        && frame["params"]["allow"] == false
                }) {
                    return Ok(frames);
                }
                tokio::task::yield_now().await;
            }
        })
        .await?
    }
}

async fn dispatched_root(adapter: &Adapter, thread: &str) -> Result<Execution> {
    let mut acquire = Acquire::new(
        adapter.lifetime_for_source(&Source::claimed(thread.into(), None))?,
        provider(),
    );
    acquire.thread_id = Some(thread.into());
    let root = tokio::time::timeout(LIMIT, adapter.acquire(acquire)).await??;
    root.dispatched()?;
    Ok(root)
}

fn assert_allow(frames: &[Value], thread: &str, scope: &str, attempt: &str) {
    assert_eq!(frames[0]["method"], CLAIM);
    assert_eq!(
        frames[0]["params"],
        json!({"threadId":thread,"turnId":"turn","scopeId":scope,"runnerGeneration":"runner","attemptId":attempt})
    );
    assert_eq!(frames[1]["method"], RESOLVE);
    assert_eq!(
        frames[1]["params"],
        json!({
            "threadId":thread,"runnerGeneration":"runner","attemptId":attempt,
            "operationGeneration":format!("inference:{scope}:{attempt}"),"allow":true
        })
    );
}

pub(super) async fn run() -> Result<()> {
    let data = tempfile::tempdir()?;
    let mut options = Options::local(data.path().into(), std::env::vars().collect());
    let rpc_error = json!({"code":-32000,"message":"Controlled resolve rejection"});
    let mut config = json!({"inference":json!({
        "acknowledged":json!({"allow":json!({"error":rpc_error}),"deny":json!({"hold":true})}),
        "uncertain":json!({"allow":json!({"error":rpc_error}),"deny":json!({"error":rpc_error})}),
        "resume":json!({"allow":json!({"error":rpc_error})}),
        "parked":json!({"claim":json!({"result":json!({"claimed":true,"goalEpoch":"goal","inferenceOnly":true})})})
    })});
    let exit_release = data.path().join("release-exit");
    config["exitReleaseFile"] = json!(exit_release.to_str().unwrap());
    config["ignoreInterrupt"] = json!(cfg!(unix));
    options
        .environment
        .insert("CANTRIP_CODEX_SESSION_FIXTURE".into(), config.stringify());
    options.startup_timeout = LIMIT;
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let recorded = diagnostics.clone();
    options.record = Arc::new(move |entry, _| recorded.lock().unwrap().push(entry));
    let (session, events) =
        Session::launch(std::env::current_exe()?, vec!["app-server".into()], options).await?;
    let manager = Manager::new(AdmissionOptions::local(Scope {
        server_id: "server".into(),
        owner_id: "owner".into(),
        worker_id: "worker".into(),
        worker_generation: uuid::Uuid::new_v4().to_string().into(),
    }));
    let adapter = Adapter::new(manager.clone(), None)?;
    let first_input = FirstInput::default();
    let parked = first_input.clone();
    let router = Router::new(
        session.clone(),
        adapter.clone(),
        Hooks {
            overlay: Arc::new(move |gate| {
                let first_input =
                    (gate.key.attempt_id.as_str() == Some("parked")).then(|| parked.clone());
                Context {
                    first_input,
                    ..Context::default()
                }
            }),
            provider: Arc::new(|| Some(provider())),
            before_inference: None,
        },
    )?;
    let mut fixture = Fixture {
        session: &session,
        events,
        router: &router,
    };
    let result = tokio::time::timeout(LIMIT * 4, async {
        exercise(&mut fixture, &adapter, first_input).await?;
        #[cfg(unix)]
        exercise_observation_loss(&mut fixture, &adapter, &exit_release).await?;
        Ok::<_, anyhow::Error>(())
    })
    .await;
    // Let a waiting peer shut down even if the exercise timed out.
    tokio::fs::write(&exit_release, b"exit").await?;
    let close = router.close().await;
    let shutdown = manager.close().await;
    result??;
    close?;
    shutdown?;
    assert!(session.process_exited());
    assert!(
        diagnostics
            .lock()
            .unwrap()
            .iter()
            .all(|entry| entry["method"] != REQUESTED)
    );
    println!(
        "{}",
        json!({"status":"passed","nativeProcess":true,"nativeWebSocket":true,"providerCalls":0})
            .stringify()
    );
    Ok(())
}

async fn exercise(
    fixture: &mut Fixture<'_>,
    adapter: &Adapter,
    first_input: FirstInput,
) -> Result<()> {
    let root = dispatched_root(adapter, "normal").await?;
    fixture
        .route(control("normal", SCOPE, "normal", "begin"))
        .await?
        .await?;
    assert_allow(&fixture.frames().await?, "normal", SCOPE, "normal");

    let mut child = fixture
        .route(control("child", INDEPENDENT, "child", "begin-independent"))
        .await?;
    let pending = fixture
        .router
        .pending()
        .into_iter()
        .find(|p| p.gate().key.attempt_id.as_str() == Some("child"))
        .unwrap();
    assert!(child.as_mut().now_or_never().is_none());
    let mut cancel = control("child", INDEPENDENT, "cancel", "cancel");
    cancel["params"]["input"]["requestId"] = json!("different");
    fixture.route(cancel.clone()).await?.await?;
    assert!(pending.signal().check().is_ok());
    cancel["params"]["input"]["requestId"] = json!("child");
    fixture.route(cancel).await?.await?;
    pending.denied().await?;
    assert!(child.await.is_err());
    assert!(root.settled().now_or_never().is_none());
    fixture.frames().await?;

    fixture
        .route(control("normal", SCOPE, "suspend", "suspend"))
        .await?
        .await?;
    assert!(
        fixture
            .route(control("normal", SCOPE, "resume", "resume"))
            .await?
            .await
            .is_err()
    );
    assert!(
        root.settled().now_or_never().is_none(),
        "denied resume retains its admitted scope"
    );
    fixture.route(json!({"method":"turn/completed","params":json!({"threadId":"normal","turn":json!({"id":"turn","status":"completed"})})})).await?.await?;
    assert!(root.settled().now_or_never().is_none());
    fixture
        .route(control("normal", SCOPE, "finish", "finish"))
        .await?
        .await?;
    root.settled().await?;
    fixture.frames().await?;

    let root = dispatched_root(adapter, "acknowledged").await?;
    let begin = fixture
        .route(control("acknowledged", SCOPE, "acknowledged", "begin"))
        .await?;
    let frames = fixture.wait_for_deny("acknowledged").await?;
    assert_allow(&frames, "acknowledged", SCOPE, "acknowledged");
    assert_eq!(frames[2]["params"]["operationGeneration"], Value::Null);
    let pending = fixture
        .router
        .pending()
        .into_iter()
        .find(|p| p.gate().key.attempt_id.as_str() == Some("acknowledged"))
        .unwrap();
    assert!(pending.denied().now_or_never().is_none());
    assert!(root.settled().now_or_never().is_none());
    fixture.request("fixture/release", Value::Null).await?;
    assert!(begin.await.is_err());
    pending.denied().await?;
    root.settled().await?;

    let root = dispatched_root(adapter, "uncertain").await?;
    assert!(
        fixture
            .route(control("uncertain", SCOPE, "uncertain", "begin"))
            .await?
            .await
            .is_err()
    );
    assert!(
        root.settled().now_or_never().is_none(),
        "failed negative resolve proves no settlement"
    );
    assert!(fixture.router.pending().is_empty());
    let mut cancel = control("uncertain", SCOPE, "late-cancel", "cancel");
    cancel["params"]["input"]["requestId"] = json!("uncertain");
    cancel["params"]["runnerGeneration"] = json!("foreign-runner");
    fixture.route(cancel.clone()).await?.await?;
    assert!(root.settled().now_or_never().is_none());
    cancel["params"]["runnerGeneration"] = json!("runner");
    fixture.route(cancel).await?.await?;
    root.settled().await?;
    fixture.frames().await?;

    let mut parked = control("parked", SCOPE, "parked", "begin");
    parked["params"]["goalEpoch"] = json!("goal");
    let begin = fixture.route(parked).await?;
    let pending = fixture
        .router
        .pending()
        .into_iter()
        .find(|p| p.gate().key.attempt_id.as_str() == Some("parked"))
        .unwrap();
    assert!(pending.first_input().unwrap().same(&first_input));
    first_input.set_dispatching(true);
    assert!(
        fixture
            .router
            .deny_for_first_input(&pending, || Ok(()))
            .await?
    );
    begin.await?;
    let frames = fixture.frames().await?;
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["method"], CLAIM);
    assert_eq!(frames[1]["method"], RESOLVE);
    assert_eq!(frames[1]["params"]["allow"], false);

    let mut invalid = control("invalid", "not-a-uuid", "invalid", "begin");
    invalid["params"]["input"]["rootThreadId"] = Value::Null;
    fixture.route(invalid).await?.await?;
    let frames = fixture.frames().await?;
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["method"], RESOLVE);
    assert_eq!(frames[0]["params"]["allow"], false);
    assert_eq!(frames[0]["params"]["attemptId"], "invalid");
    Ok(())
}

#[cfg(unix)]
async fn exercise_observation_loss(
    fixture: &mut Fixture<'_>,
    adapter: &Adapter,
    exit_release: &std::path::Path,
) -> Result<()> {
    let root = dispatched_root(adapter, "lost").await?;
    fixture
        .route(control("lost", SCOPE, "lost", "begin"))
        .await?
        .await?;
    assert!(fixture.request("fixture/close", json!({})).await.is_err());
    let lost = fixture
        .events
        .recv()
        .await
        .ok_or_else(|| anyhow!("No transport loss"))?;
    assert!(matches!(lost.kind, EventKind::TransportLost(_)));
    let Routing::Observe(observation) = fixture.router.route(&lost) else {
        bail!("No loss observer");
    };
    observation.await?;
    assert!(!fixture.session.process_exited());
    assert!(
        root.settled().now_or_never().is_none(),
        "socket loss proves no settlement"
    );
    tokio::fs::write(exit_release, b"exit").await?;
    let exited = fixture
        .events
        .recv()
        .await
        .ok_or_else(|| anyhow!("No actual process exit"))?;
    assert!(matches!(exited.kind, EventKind::ProcessExited(_)));
    let Routing::Observe(retirement) = fixture.router.route(&exited) else {
        bail!("No retirement observer");
    };
    retirement.await?;
    root.settled().await?;
    Ok(())
}
