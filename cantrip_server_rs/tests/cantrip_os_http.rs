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
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
    let worker_generation = id();
    let (peer, mut peer_output) = Peer::new(Continuity {
        owner: owner.clone(),
        credential: "fixture".into(),
        process_generation: worker_generation.clone(),
    });
    assert!(service.workers.bridge.attach(&worker, peer.clone(), None));
    let response_peer = Arc::new(Mutex::new(peer));
    let active_peer = response_peer.clone();
    let (frames, mut output) = tokio::sync::mpsc::unbounded_channel();
    let initial_frames = frames.clone();
    tokio::spawn(async move {
        while let Some(frame) = peer_output.recv().await {
            if matches!(frame, Outgoing::Close(..)) {
                break;
            }
            if initial_frames.send(frame).is_err() {
                break;
            }
        }
    });
    let provisions = Arc::new(AtomicUsize::new(0));
    let count = provisions.clone();
    let lose_run_reply = Arc::new(AtomicBool::new(false));
    let lose_reply = lose_run_reply.clone();
    let recovery_mode = Arc::new(AtomicUsize::new(0));
    let observed_mode = recovery_mode.clone();
    let bridge = service.workers.bridge.clone();
    let target = worker.clone();
    let actual_owner = owner.clone();
    let responder = tokio::spawn(async move {
        let guest = id();
        let generation = id();
        let replacement_generation = id();
        let replacement_guest = id();
        let mut attached = false;
        let mut profiles = Vec::new();
        let mut operations = HashMap::new();
        let mut runs = HashMap::<String, Value>::new();
        while let Some(frame) = output.recv().await {
            let Outgoing::Text(encoded) = frame else {
                continue;
            };
            let peer = active_peer.lock().unwrap().clone();
            let request: Value = serde_json::from_str(&encoded)?;
            let command = &request["command"];
            let mode = observed_mode.load(Ordering::SeqCst);
            if command["type"] == "cantrip-os.inspect" && mode == 1 {
                bridge.receive(&target, &peer, &json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":{"message":"Fixture transport unavailable"}}).to_string());
                continue;
            }
            let observed = |attached: bool, profiles: &Vec<Value>| json!({"guestInstanceId":if mode == 2 {&replacement_guest} else {&guest},"runtimeGeneration":if mode == 3 {&replacement_generation} else {&generation},"attachment":if attached {json!({"ownerId":actual_owner,"workerId":target})}else{Value::Null},"workspaces":profiles});
            let result = match command["type"].as_str().context("OS fixture command")? {
                "chat.files.references" => {
                    assert_eq!(command["root"]["kind"], "cantrip-os");
                    assert!(
                        command["root"]["scope"]["guestPath"]
                            .as_str()
                            .unwrap()
                            .starts_with('/')
                    );
                    json!({"operationId":command["operationId"],"sequence":command["sequence"],"protectedResponse":{"formatVersion":1,"keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}}})
                }

                "cantrip-os.run-definition" => {
                    assert!(command.get("sourcePath").is_none());
                    assert!(command["request"].get("sourcePath").is_none());
                    let request = &command["request"];
                    if request["type"] == "project.run-configuration-definitions.get" {
                        let configuration = &request["configurationId"];
                        let document = json!({"schema":"cantrip.run-configuration","version":1,"id":configuration,"name":"Native HTTP fixture","provider":"shell","workingDirectory":".","target":{"kind":"command","command":"python --version"},"commandOverride":null,"arguments":[],"environment":{"includeCodexEnvironment":false,"files":[],"variables":[],"secrets":[]},"beforeLaunch":[],"platformOverrides":{},"options":{"shell":"bash"},"stop":{"gracePeriodMs":1000}});
                        json!({"operation":"get","operationId":request["operationId"],"projectId":request["projectId"],"result":{"found":true,"entry":{"relativePath":format!(".cantrip/run-configurations/{}.json",configuration.as_str().unwrap()),"revision":"a".repeat(64),"id":configuration,"status":"ready","document":document,"diagnostics":[]}},"codexEnvironment":{"enabled":false,"configured":false,"valid":true,"revision":null,"hasSetup":false,"diagnostics":[]},"secretReferences":[]})
                    } else if request["type"] == "project.run-configuration-definitions.delete" {
                        assert!(
                            runs.values()
                                .all(|observation| observation["state"] == "idle")
                        );
                        json!({"operation":"delete","operationId":request["operationId"],"projectId":request["projectId"],"result":{"outcome":"deleted","id":request["request"]["id"],"revision":"a".repeat(64)}})
                    } else {
                        json!({"operation":"capabilities","operationId":request["operationId"],"projectId":request["projectId"],"capabilities":[]})
                    }
                }
                "cantrip-os.run-runtime.start"
                | "cantrip-os.run-runtime.restart"
                | "cantrip-os.run-runtime.stop" => {
                    assert!(command.get("sourcePath").is_none());
                    assert!(command.get("targetPath").is_none());
                    assert_eq!(command["definitions"]["kind"], "cantrip-os");
                    assert_eq!(
                        command["target"]["scope"]["worktreeId"],
                        command["identity"]["worktreeId"]
                    );
                    let stopped = command["type"] == "cantrip-os.run-runtime.stop";
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let mut observation = command["identity"].clone();
                    for (key, value) in json!({"state":if stopped {"idle"}else{"running"},"startedAt":now,"endedAt":if stopped {json!(now)}else{Value::Null},"exitCode":if stopped {json!(0)}else{Value::Null},"signal":null,"failure":null}).as_object().unwrap() {
                        observation[key] = value.clone();
                    }
                    runs.insert(
                        command["identity"]["runtimeId"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                        observation.clone(),
                    );
                    if !stopped && lose_reply.swap(false, Ordering::SeqCst) {
                        bridge.receive(&target, &peer, &json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":{"message":"Fixture lost the admitted Run reply"}}).to_string());
                        continue;
                    }
                    json!({"outcome":"accepted","observation":observation})
                }
                "project.run-configuration-runtime.reconcile" => {
                    json!({"runtimes":command["identities"].as_array().unwrap().iter().map(|identity|json!({"found":false,"identity":identity})).collect::<Vec<_>>(),"orphanedRuntimeIds":[]})
                }
                "cantrip-os.run-runtime.reconcile" => {
                    json!({"runtimes":command["captures"].as_array().unwrap().iter().map(|capture|match runs.get(capture["identity"]["runtimeId"].as_str().unwrap()){Some(observation)=>json!({"found":true,"observation":observation}),None=>json!({"found":false,"identity":capture["identity"]})}).collect::<Vec<_>>(),"orphanedRuntimeIds":[]})
                }
                "cantrip-os.run-runtime.output" => {
                    json!({"requestOperationId":command["requestOperationId"],"identity":command["identity"],"protectedOutput":{"formatVersion":1,"domain":"run-content","keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}}})
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
    Box::pin(exercise_run_http(RunHttpFixture {
        client: &client,
        base: &base,
        project: &project,
        owner: &owner,
        worker: &worker,
        service: &service,
        binding: &binding,
        attached: &attached,
        lose_run_reply: &lose_run_reply,
    }))
    .await?;
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
    let recovery_url = format!("{base}/api/cantrip-os/{instance}/recovery");
    let mut expected = json!({"attachmentGeneration":attached["instance"]["attachmentGeneration"], "runtimeGeneration":attached["instance"]["runtimeGeneration"]});
    let invalid = client.post(&recovery_url).json(&json!({})).send().await?;
    assert_eq!(invalid.status(), 400);
    for (index, (mode, kind)) in [
        (0, "same-runtime"),
        (1, "unavailable"),
        (0, "same-runtime"),
        (2, "identity-changed"),
        (0, "same-runtime"),
        (3, "runtime-changed"),
        (0, "runtime-changed"),
    ]
    .into_iter()
    .enumerate()
    {
        recovery_mode.store(mode, Ordering::SeqCst);
        let response = client.post(&recovery_url).json(&expected).send().await?;
        let status = response.status();
        let result: Value = response.json().await?;
        assert_eq!(status, 200, "{result}");
        assert_eq!(result["recovery"]["kind"], kind);
        assert_eq!(
            result["recovery"]["workerContinuity"],
            if index == 0 {
                "first-observation"
            } else {
                "same-worker"
            }
        );
        assert_eq!(
            result["recovery"]["observedWorkerProcessGeneration"],
            worker_generation
        );
        assert_eq!(
            result["recovery"]["previousRuntimeGeneration"],
            expected["runtimeGeneration"]
        );
        if mode == 1 || mode == 2 {
            assert_eq!(result["instance"]["status"], "unknown");
            assert_eq!(
                result["instance"]["runtimeGeneration"],
                expected["runtimeGeneration"]
            );
            assert!(result["recovery"]["observedRuntimeGeneration"].is_null());
        }
        assert_eq!(
            result["instance"]["guestInstanceId"],
            attached["instance"]["guestInstanceId"]
        );
        expected["runtimeGeneration"] = result["instance"]["runtimeGeneration"].clone();
    }
    let reconnect = |generation: String| {
        let (peer, mut incoming) = Peer::new(Continuity {
            owner: owner.clone(),
            credential: "fixture".into(),
            process_generation: generation,
        });
        assert!(service.workers.bridge.attach(&worker, peer.clone(), None));
        *response_peer.lock().unwrap() = peer;
        let frames = frames.clone();
        tokio::spawn(async move {
            while let Some(frame) = incoming.recv().await {
                if matches!(frame, Outgoing::Close(..)) {
                    break;
                }
                if frames.send(frame).is_err() {
                    break;
                }
            }
        });
    };
    reconnect(worker_generation.clone());
    let resumed: Value = client
        .post(&recovery_url)
        .json(&expected)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(
        resumed["recovery"]["workerContinuity"], "same-worker",
        "{resumed}"
    );
    let replacement_worker = id();
    reconnect(replacement_worker.clone());
    assert_eq!(
        client
            .post(format!("{base}/api/cantrip-os/{instance}/refresh"))
            .json(&json!({}))
            .send()
            .await?
            .status(),
        200
    );
    let restarted: Value = client
        .post(&recovery_url)
        .json(&expected)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(restarted["recovery"]["kind"], "same-runtime", "{restarted}");
    assert_eq!(
        restarted["recovery"]["workerContinuity"],
        "worker-restarted"
    );
    assert_eq!(
        restarted["recovery"]["previousWorkerProcessGeneration"],
        worker_generation
    );
    assert_eq!(
        restarted["recovery"]["observedWorkerProcessGeneration"],
        replacement_worker
    );
    assert!(
        restarted["recovery"]["message"]
            .as_str()
            .unwrap()
            .contains("Worker process restarted")
    );
    assert!(
        restarted["instance"]
            .get("workerProcessGeneration")
            .is_none()
    );
    assert_eq!(
        database
            .query(
                "SELECT worker_process_generation FROM cantrip_os_instances WHERE id=$1",
                &[&instance]
            )
            .await?[0]
            .get::<String>(0)?,
        replacement_worker
    );
    let mut stale = expected.clone();
    stale["attachmentGeneration"] = id().into();
    assert_eq!(
        client
            .post(&recovery_url)
            .json(&stale)
            .send()
            .await?
            .status(),
        409
    );
    stale = expected.clone();
    stale["runtimeGeneration"] = id().into();
    assert_eq!(
        client
            .post(&recovery_url)
            .json(&stale)
            .send()
            .await?
            .status(),
        409
    );
    assert_eq!(provisions.load(Ordering::SeqCst), 1);
    // Canonical history remains owned/readable when the captured OS epoch is stale.
    let chat = id();
    database.query("INSERT INTO chats(id,owner_id,project_id,protected_label,active_worker_id,active_worktree_id,experience,worktree_mode) VALUES($1,$2,$3,'{}',$4,$5,'agent','pinned')", &[&chat,&owner,&project,&worker,&binding["worktreeId"].as_str().unwrap()]).await?;
    database.query("INSERT INTO cantrip_os_chat_placements(chat_id,binding_id,binding_generation,attachment_generation,runtime_generation) VALUES($1,$2,$3,$4,$5)", &[&chat,&binding["id"].as_str().unwrap(),&binding["bindingGeneration"].as_str().unwrap(),&attached["instance"]["attachmentGeneration"].as_str().unwrap(),&attached["instance"]["runtimeGeneration"].as_str().unwrap()]).await?;
    let refs = client.post(format!("{base}/api/chats/{chat}/file-references"))
        .json(&json!({"operationId":id(),"sequence":0,"protectedRequest":{"formatVersion":1,"keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}}}))
        .send().await?;
    let refs_status = refs.status();
    let refs_body = refs.json().await?;
    assert_eq!(refs_status, 200, "{refs_body}");
    database
        .query(
            "UPDATE cantrip_os_instances SET runtime_generation=$1 WHERE id=$2",
            &[&id(), &instance],
        )
        .await?;
    let chats = cantrip_server::chats::Repository::new(database.clone());
    assert!(chats.execution_context(&owner, &chat).await.is_err());
    for suffix in ["messages", "queue"] {
        let response = client
            .get(format!("{base}/api/chats/{chat}/{suffix}"))
            .send()
            .await?;
        let status = response.status();
        let body = response.json().await?;
        assert_eq!(status, 200, "{suffix}: {body}");
        assert!(
            body[if suffix == "messages" {
                "messages"
            } else {
                "items"
            }]
            .as_array()
            .unwrap()
            .is_empty()
        );
    }
    let live = cantrip_server::live::repository::LiveRepository::new(database.clone())?;
    assert!(
        live.authorize(
            &owner,
            &cantrip_server::wire::Value::from_serialize(&json!({"kind":"chat","chatId":chat}))
        )
        .await?
    );
    assert!(
        !live
            .authorize(
                "other",
                &cantrip_server::wire::Value::from_serialize(&json!({"kind":"chat","chatId":chat}))
            )
            .await?
    );
    service.workers.close();
    drop(frames);
    let closed = tokio::time::timeout(Duration::from_secs(10), responder)
        .await
        .context("Fixture Worker did not close its forwarding channels")?;
    closed??;
    drop(client);
    let _ = stop.send(());
    server.await??;
    database.close().await?;
    runtime.close().await?;
    Ok(())
}

// HTTP/authorization parity uses an explicit fixture Worker. Real Linux
// process and protected-output acceptance runs in the Node integration suite.
struct RunHttpFixture<'a> {
    client: &'a reqwest::Client,
    base: &'a str,
    project: &'a str,
    owner: &'a str,
    worker: &'a str,
    service: &'a Arc<AuthService>,
    binding: &'a Value,
    attached: &'a Value,
    lose_run_reply: &'a Arc<AtomicBool>,
}
async fn exercise_run_http(fixture: RunHttpFixture<'_>) -> Result<()> {
    let RunHttpFixture {
        client,
        base,
        project,
        owner,
        worker,
        service,
        binding,
        attached,
        lose_run_reply,
    } = fixture;
    let sources = client
        .get(format!(
            "{base}/api/projects/{project}/cantrip-os/run-sources"
        ))
        .send()
        .await?;
    let status = sources.status();
    let sources = sources.json().await?;
    assert_eq!(status, 200, "{sources}");
    assert_eq!(sources[0]["target"]["isPrimary"], true);
    assert_eq!(sources[0]["binding"]["id"], binding["id"]);
    assert!(sources[0].get("transport").is_none());
    assert!(sources[0]["target"].get("path").is_none());
    let configuration = id();
    let selection = json!({"kind":"binding","bindingId":binding["id"],"bindingGeneration":binding["bindingGeneration"],"attachmentGeneration":attached["instance"]["attachmentGeneration"],"runtimeGeneration":attached["instance"]["runtimeGeneration"]});
    let run_url = format!("{base}/api/run-configuration-runtimes");
    let start = json!({"operation":"start","operationId":id(),"projectId":project,"configurationId":configuration,"targetWorktreeId":null,"osSource":selection});
    let response = client
        .post(format!("{run_url}/operations"))
        .json(&start)
        .send()
        .await?;
    let status = response.status();
    let admitted = response.json().await?;
    assert_eq!(status, 202, "{admitted}");
    assert_eq!(admitted["runtime"]["state"], "running");
    assert_eq!(admitted["runtime"]["worktreeId"], binding["worktreeId"]);
    let by_id=client.post(format!("{run_url}/status")).json(&json!({"operationId":id(),"projectId":project,"configurationId":null,"targetWorktreeId":null,"runtimeId":admitted["runtime"]["id"]})).send().await?.json().await?;
    assert_eq!(
        by_id["runtimes"][0]["osDefinition"]["bindingId"], binding["id"],
        "{by_id}"
    );

    let captured = json!({"kind":"runtime","runtimeId":admitted["runtime"]["id"]});
    let status_request = json!({"operationId":id(),"projectId":project,"configurationId":configuration,"targetWorktreeId":null,"osSource":selection});
    let response = client
        .post(format!("{run_url}/status"))
        .json(&status_request)
        .send()
        .await?;
    let status = response.status();
    let status_result = response.json().await?;
    assert_eq!(status, 200, "{status_result}");
    assert_eq!(
        status_result["runtimes"][0]["id"],
        admitted["runtime"]["id"]
    );
    let output = client.post(format!("{run_url}/output")).json(&json!({"operationId":id(),"projectId":project,"configurationId":configuration,"worktreeId":binding["worktreeId"],"osSource":captured})).send().await?;
    let status = output.status();
    let output = output.json().await?;
    assert_eq!(status, 200, "{output}");
    assert_eq!(output["protectedOutput"]["domain"], "run-content");
    service
        .run_configuration_observations
        .worker_connected(owner.to_owned(), worker.to_owned());
    service.run_configuration_observations.drained().await;
    let reconciled = client
        .post(format!("{run_url}/status"))
        .json(&status_request)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(
        reconciled["runtimes"][0]["state"], "running",
        "{reconciled}"
    );

    let host_status = client.post(format!("{run_url}/status")).json(&json!({"operationId":id(),"projectId":project,"configurationId":configuration,"targetWorktreeId":null})).send().await?.json().await?;
    assert_eq!(host_status["runtimes"], json!([]));
    let mut stale = start.clone();
    stale["operationId"] = json!(id());
    stale["osSource"]["bindingGeneration"] = json!(id());
    assert_eq!(
        client
            .post(format!("{run_url}/operations"))
            .json(&stale)
            .send()
            .await?
            .status(),
        409
    );
    let stop_request = json!({"operation":"stop","operationId":id(),"projectId":project,"configurationId":configuration,"targetWorktreeId":binding["worktreeId"],"osSource":captured});
    let stopped = client
        .post(format!("{run_url}/operations"))
        .json(&stop_request)
        .send()
        .await?;
    let status = stopped.status();
    let stopped = stopped.json().await?;
    assert_eq!(status, 202, "{stopped}");
    assert_eq!(stopped["runtime"]["state"], "idle");
    lose_run_reply.store(true, Ordering::SeqCst);
    let mut lost_start = start.clone();
    lost_start["operationId"] = json!(id());
    assert_eq!(
        client
            .post(format!("{run_url}/operations"))
            .json(&lost_start)
            .send()
            .await?
            .status(),
        502
    );
    let lost = client
        .post(format!("{run_url}/status"))
        .json(&status_request)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(lost["runtimes"][0]["state"], "lost", "{lost}");
    lost_start["operationId"] = json!(id());
    assert_eq!(
        client
            .post(format!("{run_url}/operations"))
            .json(&lost_start)
            .send()
            .await?
            .status(),
        409
    );

    let mut stop_request = stop_request;
    stop_request["operationId"] = json!(id());
    let stopped = client
        .post(format!("{run_url}/operations"))
        .json(&stop_request)
        .send()
        .await?;
    let status = stopped.status();
    let stopped = stopped.json().await?;
    assert_eq!(status, 202, "{stopped}");
    assert_eq!(stopped["runtime"]["state"], "idle");
    let mut fresh = start.clone();
    fresh["operationId"] = json!(id());
    assert_eq!(
        client
            .post(format!("{run_url}/operations"))
            .json(&fresh)
            .send()
            .await?
            .status(),
        202
    );
    let definition_url = format!(
        "{base}/api/projects/{project}/cantrip-os/bindings/{}/run-definitions",
        binding["id"].as_str().unwrap()
    );
    let mut deletion = json!({"runtimeGeneration":attached["instance"]["runtimeGeneration"],"bindingGeneration":binding["bindingGeneration"],"attachmentGeneration":attached["instance"]["attachmentGeneration"],"request":{"type":"project.run-configuration-definitions.delete","projectId":project,"operationId":id(),"request":{"id":configuration,"expectedRevision":"b".repeat(64)}}});
    let mismatch = client
        .post(&definition_url)
        .json(&deletion)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(
        mismatch["result"]["result"]["outcome"], "revision-mismatch",
        "{mismatch}"
    );
    let still_running = client
        .post(format!("{run_url}/status"))
        .json(&status_request)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(still_running["runtimes"][0]["state"], "running");
    deletion["request"]["operationId"] = json!(id());
    deletion["request"]["request"]["expectedRevision"] = json!("a".repeat(64));
    let deleted = client.post(&definition_url).json(&deletion).send().await?;
    let status = deleted.status();
    let deleted = deleted.json().await?;
    assert_eq!(status, 200, "{deleted}");
    assert_eq!(deleted["result"]["result"]["outcome"], "deleted");
    let remaining = client
        .post(format!("{run_url}/status"))
        .json(&status_request)
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(remaining["runtimes"], json!([]));

    Ok(())
}
