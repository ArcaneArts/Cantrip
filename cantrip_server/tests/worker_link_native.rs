use anyhow::Result;
use cantrip_server::{
    relay::RelayQuotas,
    wire::Value,
    worker_links::{Coordinator, Options},
    workers::{
        bridge::{Continuity, Outgoing, Peer, WorkerBridge},
        command_bus::{CommandLimits, LimitedCommandBus},
    },
};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
fn json(value: impl serde::Serialize) -> Value {
    Value::from_serialize(&value)
}
fn input() -> Value {
    json(
        serde_json::json!({"ownerId":"owner","accountSessionId":"account","clientInstanceId":"client","workerId":"worker"}),
    )
}
fn identity(generation: &str) -> Continuity {
    Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: generation.into(),
    }
}
struct Fixture {
    core: Arc<Coordinator>,
    bridge: Arc<WorkerBridge>,
    peer: Arc<Peer>,
    output: mpsc::UnboundedReceiver<Outgoing>,
}
impl Fixture {
    fn new(grace: Duration, peers: bool) -> Self {
        let bridge = WorkerBridge::new(grace);
        let (peer, output) = Peer::new(identity("generation"));
        assert!(bridge.attach("worker", peer.clone(), None));
        let commands = LimitedCommandBus::with_parts(
            bridge.clone(),
            RelayQuotas::with_limits(100_000_000, 100_000_000, 100_000_000, 100_000_000, 10, 10),
            CommandLimits {
                account_concurrency: 100,
                account_rate_per_minute: 1000,
                worker_concurrency: 100,
                worker_rate_per_minute: 1000,
            },
            Arc::new(|_| Box::pin(async { Ok(Some("owner".into())) })),
            Arc::new(|| 0),
        );
        let mut options = Options::new("fixture".into(), "server-generation".into());
        if peers {
            let fixtures: Value = serde_json::from_str(include_str!(
                "../../scripts/server-rust/worker-command-fixtures.json"
            ))
            .unwrap();
            options.peer_configuration = Some(
                fixtures["commands"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["type"] == "worker-link.peer.install")
                    .unwrap()["input"]["command"]["configuration"]
                    .clone(),
            );
            options.peer_configuration.as_mut().unwrap()["directRoutes"]["lan"] = json(true);
        }
        let core = Coordinator::native(commands, bridge.clone(), options);
        Self {
            core,
            bridge,
            peer,
            output,
        }
    }
    async fn next(&mut self) -> Value {
        let Some(Outgoing::Text(text)) =
            tokio::time::timeout(Duration::from_secs(10), self.output.recv())
                .await
                .expect("Expected worker command before its acknowledgment deadline")
        else {
            panic!("Expected actual native worker request")
        };
        serde_json::from_str(&text).unwrap()
    }
    fn ack(&self, request: &Value, result: Value) {
        self.bridge.receive("worker",&self.peer,&json(serde_json::json!({"kind":"response","requestId":request["requestId"],"ok":true,"result":result})).stringify());
    }
    fn accepted(&self, request: &Value) {
        self.ack(request, json(serde_json::json!({"accepted":true})));
    }
    fn resolved(&self, request: &Value) {
        self.ack(request,json(serde_json::json!({"serverId":"fixture","ownerId":"owner","workerId":"worker","workerProcessGeneration":self.peer.identity.process_generation})));
    }
    async fn open(&mut self) -> Value {
        let core = self.core.clone();
        let task = tokio::spawn(async move { core.open_session(input()).await });
        let identity = self.next().await;
        assert_eq!(identity["command"]["type"], "worker-link.identity.resolve");
        self.resolved(&identity);
        let install = self.next().await;
        assert_eq!(install["command"]["type"], "worker-link.session.install");
        self.accepted(&install);
        task.await.unwrap().unwrap()
    }
    async fn close(self) {
        self.bridge.disconnect("worker", "fixture complete", 1000);
        self.core.close().await;
        self.core.drained().await;
        self.bridge.close();
    }
}
#[tokio::test]
async fn caller_disconnect_does_not_abandon_admitted_session_installation() -> Result<()> {
    let mut f = Fixture::new(Duration::from_millis(100), false);
    let core = f.core.clone();
    let operation = core.clone();
    let caller = tokio::spawn(async move {
        core.owned(async move { Ok(operation.open_session(input()).await?) })
            .await
    });
    let identity = f.next().await;
    f.resolved(&identity);
    let installation = f.next().await;
    assert_eq!(
        installation["command"]["type"],
        "worker-link.session.install"
    );
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let drain = {
        let core = f.core.clone();
        tokio::spawn(async move { core.drained().await })
    };
    tokio::task::yield_now().await;
    assert!(!drain.is_finished());
    f.accepted(&installation);
    drain.await?;
    let session = &installation["command"]["session"];
    assert!(
        f.core
            .session_for_authorization(
                session["sessionId"].as_str().unwrap(),
                &json("owner"),
                &json("account")
            )
            .is_some()
    );
    f.close().await;
    Ok(())
}
#[tokio::test(start_paused = true)]
async fn temporary_disconnect_keeps_authority_and_actual_grace_expiry_revokes_it() -> Result<()> {
    let mut f = Fixture::new(Duration::from_millis(100), false);
    let session = f.open().await;
    let id = session["sessionId"].as_str().unwrap();
    f.peer
        .open
        .store(false, std::sync::atomic::Ordering::Release);
    f.bridge.interrupted("worker", &f.peer);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(50)).await;
    assert!(
        f.core
            .session_for_authorization(id, &json("owner"), &json("account"))
            .is_some()
    );
    let (replacement, output) = Peer::new(identity("generation"));
    assert!(f.bridge.attach("worker", replacement.clone(), None));
    f.peer = replacement;
    f.output = output;
    assert!(
        f.core
            .session_for_authorization(id, &json("owner"), &json("account"))
            .is_some()
    );
    f.peer
        .open
        .store(false, std::sync::atomic::Ordering::Release);
    f.bridge.interrupted("worker", &f.peer);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    assert!(
        f.core
            .session_for_authorization(id, &json("owner"), &json("account"))
            .is_none()
    );
    f.close().await;
    Ok(())
}
#[tokio::test]
async fn replacement_revokes_old_authority_before_new_ready_and_retains_acknowledged_cleanup()
-> Result<()> {
    let mut f = Fixture::new(Duration::from_secs(15), false);
    let old = f.open().await;
    let id = old["sessionId"].as_str().unwrap();
    let (replacement, output) = Peer::new(identity("next-generation"));
    assert!(
        f.bridge
            .attach("worker", replacement.clone(), Some("ready".into()))
    );
    assert!(
        f.core
            .session_for_authorization(id, &json("owner"), &json("account"))
            .is_none()
    );
    f.peer = replacement;
    f.output = output;
    let Some(Outgoing::Text(ready)) = f.output.recv().await else {
        panic!("Expected ready before commands")
    };
    assert_eq!(&**ready, "ready");
    drop(ready);
    let revoke = f.next().await;
    assert_eq!(revoke["command"]["type"], "worker-link.session.revoke");
    assert_eq!(revoke["command"]["sessionId"], old["sessionId"]);
    f.accepted(&revoke);
    f.core.drained().await;
    let current = f.open().await;
    assert_eq!(
        current["identity"]["workerProcessGeneration"],
        "next-generation"
    );
    f.close().await;
    Ok(())
}
#[tokio::test]
async fn actual_bridge_delivers_peer_signals_before_the_install_acknowledgment() -> Result<()> {
    let mut f = Fixture::new(Duration::ZERO, true);
    let session = f.open().await;
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    let task = {
        let (core, id) = (f.core.clone(), session_id.clone());
        tokio::spawn(async move { core.open_peer(&id, json("lan"), json(1)).await })
    };
    let install = f.next().await;
    assert_eq!(install["command"]["type"], "worker-link.peer.install");
    let peer = install["command"]["peerSession"].clone();
    f.bridge.receive("worker",&f.peer,&json(serde_json::json!({"kind":"notification","notification":{"type":"worker-link.peer.signal","envelope":{"sessionId":session_id,"peerSessionId":peer["peerSessionId"],"routeGeneration":1,"route":"lan","sender":"worker","signalSequence":0,"signal":{"type":"answer","sdp":"v=0"}}}})).stringify());
    f.accepted(&install);
    task.await??;
    let mailbox = f.core.read_peer_mailbox(
        &session_id,
        peer["peerSessionId"].as_str().unwrap(),
        json(serde_json::json!({})),
    )?;
    assert_eq!(mailbox["signals"].as_array().unwrap().len(), 1);
    assert_eq!(
        mailbox["signals"].as_array().unwrap()[0]["signal"]["sdp"],
        "v=0"
    );
    f.close().await;
    Ok(())
}
