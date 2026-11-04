use anyhow::{Context, Result};
use cantrip_server::{
    auth::service::AuthService,
    config::{Environment, ServerConfig},
    database::Database,
    http,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    workers::bridge::{Continuity, Outgoing, Peer},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot};
// Keep the production reqwest feature set; JSON encoding is explicit here.
trait RequestJson {
    fn json(self, value: &Value) -> Self;
}
impl RequestJson for reqwest::RequestBuilder {
    fn json(self, value: &Value) -> Self {
        self.header("content-type", "application/json")
            .body(value.to_string())
    }
}
trait ResponseJson {
    async fn json(self) -> Result<Value>;
}
impl ResponseJson for reqwest::Response {
    async fn json(self) -> Result<Value> {
        Ok(serde_json::from_str(&self.text().await?)?)
    }
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tokio::test]
async fn native_http_owns_attachment_source_and_recovery_dispatch() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?);
    let runtime = ManagedPostgres::start_with_owner(
        root.path(),
        &bin,
        std::path::Path::new(env!("CARGO_BIN_EXE_cantrip-server")),
    )
    .await?;
    let database = Arc::new(Database::postgres(runtime.configuration()).await?);
    migrate(&database).await?;
    let config = ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "none".into()),
            (
                "CANTRIP_DATA_DIR".into(),
                root.path().join("data").to_string_lossy().into_owned(),
            ),
            (
                "CANTRIP_WORKER_TOKEN".into(),
                "unused-os-fixture-bootstrap".into(),
            ),
        ]),
        root.path(),
    )?;
    let service = AuthService::initialize(database.clone(), Arc::new(config)).await?;
    let owner = service.local_user.as_ref().unwrap().id.clone();
    let worker = id();
    let project = id();
    database.query("INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','linux','x64',now(),now())", &[&worker,&owner]).await?;
    database.query("INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES($1,$2,'{}','managed-folder','external','direct',true,false)", &[&project,&owner]).await?;
    let (peer, mut output) = Peer::new(Continuity {
        owner: owner.clone(),
        credential: "fixture".into(),
        process_generation: id(),
    });
    assert!(service.workers.bridge.attach(&worker, peer.clone(), None));
    let provisions = Arc::new(AtomicUsize::new(0));
    let count = provisions.clone();
    let bridge = service.workers.bridge.clone();
    let target = worker.clone();
    let actual_owner = owner.clone();
    let responder = tokio::spawn(async move {
        let guest = id();
        let generation = id();
        let mut attached = false;
        let mut profiles = Vec::new();
        let mut operations = HashMap::new();
        while let Some(frame) = output.recv().await {
            let Outgoing::Text(encoded) = frame else {
                break;
            };
            let request: Value = serde_json::from_str(&encoded)?;
            let command = &request["command"];
            let observed = |attached: bool, profiles: &Vec<Value>| json!({"guestInstanceId":guest,"runtimeGeneration":generation,"attachment":if attached {json!({"ownerId":actual_owner,"workerId":target})}else{Value::Null},"workspaces":profiles});
            let result = match command["type"].as_str().context("OS fixture command")? {
                "cantrip-os.run-definition" => {
                    assert!(command.get("sourcePath").is_none());
                    assert!(command["request"].get("sourcePath").is_none());
                    json!({"operation":"capabilities","operationId":command["request"]["operationId"],"projectId":command["request"]["projectId"],"capabilities":[]})
                }
                "cantrip-os.inspect" => observed(attached, &profiles),
                "cantrip-os.attach" => {
                    attached = true;
                    observed(attached, &profiles)
                }
                "cantrip-os.workspaces.create" => {
                    let uid = 20000 + profiles.len();
                    let name = command["guestWorkspaceId"].as_str().unwrap();
                    let workspace = json!({"guestWorkspaceId":name,"uid":uid,"gid":uid,"homeGuestPath":format!("/home/{name}")});
                    profiles.push(workspace.clone());
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    json!({"operationId":command["operationId"],"state":"ready","startedAt":now,"updatedAt":now,"error":null,"receipt":{"kind":"workspace","workspace":workspace}})
                }
                "cantrip-os.source.provision" | "cantrip-os.source.inspect" => {
                    let s = &command["scope"];
                    let source = json!({"bindingId":s["bindingId"],"workspaceId":s["workspaceId"],"guestWorkspaceId":s["guestWorkspaceId"],"mode":s["mode"],"guestPath":s["guestPath"],"runtimeGeneration":generation,"uid":s["uid"],"homeGuestPath":s["homeGuestPath"],"head":"a".repeat(40),"branch":null,"detached":true,"repositoryFingerprint":"fixture-fingerprint","gitCommonGuestPath":format!("{}/.git",s["guestPath"].as_str().unwrap()),"recreated":false,"interruptedGuestWorkspaces":[],"dependencyOverlays":[],"cleanupWarnings":[]});
                    if command["type"] == "cantrip-os.source.inspect" {
                        source
                    } else {
                        count.fetch_add(1, Ordering::SeqCst);
                        let now =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        let result = json!({"operationId":command["operationId"],"state":"ready","startedAt":now,"updatedAt":now,"error":null,"receipt":{"kind":"source","source":source}});
                        operations.insert(
                            command["operationId"].as_str().unwrap().to_owned(),
                            result.clone(),
                        );
                        result
                    }
                }
                "cantrip-os.operation.inspect" => operations
                    .get(command["operationId"].as_str().unwrap())
                    .context("Saved OS fixture operation")?
                    .clone(),
                other => anyhow::bail!("Unexpected OS fixture command: {other}"),
            };
            bridge.receive(&target,&peer,&json!({"kind":"response","requestId":request["requestId"],"ok":true,"result":result}).to_string());
        }
        Ok::<_, anyhow::Error>(())
    });
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let app = http::router(service.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let base = format!("http://{address}");
    assert_eq!(
        client
            .get(format!("{base}/api/cantrip-os"))
            .send()
            .await?
            .status(),
        200
    );
    let inspected = client
        .post(format!("{base}/api/cantrip-os/inspect"))
        .json(&json!({"workerId":worker,"transport":{"kind":"docker","container":"fixture"}}))
        .send()
        .await?;
    assert_eq!(inspected.status(), 200);
    let inspected: Value = inspected.json().await?;
    let response=client.post(format!("{base}/api/cantrip-os/attach")).json(&json!({"workerId":worker,"guestInstanceId":inspected["guestInstanceId"],"name":"Fixture","transport":{"kind":"docker","container":"fixture"},"expectedAttachmentGeneration":null})).send().await?;
    let status = response.status();
    let attached: Value = response.json().await?;
    assert_eq!(status, 200, "{attached}");
    let instance = attached["instance"]["id"].as_str().unwrap();
    let response = client
        .post(format!("{base}/api/cantrip-os/{instance}/workspaces"))
        .json(&json!({"guestWorkspaceId":"alpha","operationId":id(),"uid":0}))
        .send()
        .await?;
    assert_eq!(response.status(), 400);
    let response = client
        .post(format!("{base}/api/cantrip-os/{instance}/workspaces"))
        .json(&json!({"guestWorkspaceId":"alpha","operationId":id()}))
        .send()
        .await?;
    assert_eq!(response.status(), 200);
    let workspaces: Value = client
        .get(format!("{base}/api/cantrip-os/{instance}/workspaces"))
        .send()
        .await?
        .json()
        .await?;
    let path = format!("{base}/api/projects/{project}/cantrip-os/bindings");
    let response = client
        .post(&path)
        .json(&json!({"mode":"linux-owned","workspaceId":workspaces[0]["id"],"sourceKind":"git"}))
        .send()
        .await?;
    let status = response.status();
    let binding: Value = response.json().await?;
    assert_eq!(status, 200, "{binding}");
    let path = format!("{path}/{}", binding["id"].as_str().unwrap());
    let input = json!({"operationId":id(),"bindingGeneration":binding["bindingGeneration"],"protectedRequest":{"formatVersion":1,"keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}}});
    for _ in 0..2 {
        let response = client
            .post(format!("{path}/provision"))
            .json(&input)
            .send()
            .await?;
        let status = response.status();
        let result: Value = response.json().await?;
        assert_eq!(status, 200, "{result}");
        assert_eq!(result["state"], "ready");
    }
    assert_eq!(provisions.load(Ordering::SeqCst), 1);
    assert_eq!(
        client
            .post(format!("{path}/recover"))
            .json(&json!({}))
            .send()
            .await?
            .status(),
        200
    );
    assert_eq!(
        client
            .post(format!("{path}/verify"))
            .json(&json!({}))
            .send()
            .await?
            .status(),
        200
    );
    let response = client.post(format!("{path}/run-definitions"))
        .json(&json!({"runtimeGeneration":attached["instance"]["runtimeGeneration"],"request":{
            "type":"project.run-configuration-definitions.capabilities","operationId":id(),"projectId":project
        }})).send().await?;
    let status = response.status();
    let run: Value = response.json().await?;
    assert_eq!(status, 200, "{run}");
    assert_eq!(run["source"]["bindingId"], binding["id"]);
    assert_eq!(run["source"]["worktreeId"], binding["worktreeId"]);
    assert_eq!(run["result"]["operation"], "capabilities");
    assert_eq!(
        client
            .post(format!("{base}/api/cantrip-os/inspect"))
            .json(
                &json!({"workerId":"not-owned","transport":{"kind":"docker","container":"fixture"}})
            )
            .send()
            .await?
            .status(),
        409
    );
    service.workers.close();
    responder.await??;
    drop(client);
    let _ = stop.send(());
    server.await??;
    database.close().await?;
    runtime.close().await?;
    Ok(())
}
