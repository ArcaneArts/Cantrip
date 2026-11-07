use anyhow::Result;
use cantrip_server::{
    auth::service::AuthService,
    cantrip_os::Repository,
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
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn envelope() -> Value {
    json!({"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"})
}
type Records = Arc<Mutex<HashMap<String, Value>>>;
type Commands = Arc<Mutex<Vec<Value>>>;
struct Running {
    base: String,
    stop: oneshot::Sender<()>,
    server: JoinHandle<std::io::Result<()>>,
    responder: JoinHandle<()>,
}
#[derive(Clone)]
struct Fixture {
    records: Records,
    commands: Commands,
    executions: Arc<Mutex<Vec<String>>>,
    catalog: Arc<Mutex<Value>>,
    lose_capture: Arc<AtomicBool>,
    lose_attach: Arc<AtomicBool>,
    unattached: Arc<AtomicBool>,
    drop_prepare: Arc<AtomicBool>,
    lose_prepare: Arc<AtomicBool>,
}
async fn serve(service: Arc<AuthService>, worker: &str, f: Fixture) -> Result<Running> {
    let (peer, mut output) = Peer::new(Continuity {
        owner: service.local_user.as_ref().unwrap().id.clone(),
        credential: "fixture".into(),
        process_generation: id(),
    });
    assert!(
        service
            .workers
            .bridge
            .local()
            .attach(worker, peer.clone(), None)
    );
    let bridge = service.workers.bridge.clone().local_arc();
    let worker = worker.to_owned();
    let responder = tokio::spawn(async move {
        while let Some(Outgoing::Text(encoded)) = output.recv().await {
            let request: Value = serde_json::from_str(&encoded).unwrap();
            let c = &request["command"];
            f.commands.lock().unwrap().push(c.clone());
            let mut failure = false;
            let result = match c["type"].as_str().unwrap() {
                "cantrip-os.system.status" => {
                    let mut value = f.catalog.lock().unwrap().clone();
                    if f.unattached.load(Ordering::SeqCst) {
                        value["enrollment"] = json!({"containerId":value["target"]["containerId"],"guestInstanceId":value["target"]["expected"]["guestInstanceId"]});
                        value["target"] = Value::Null;
                    }
                    value
                }
                "cantrip-os.inspect" => {
                    let value = f.catalog.lock().unwrap();
                    json!({"guestInstanceId":value["target"]["expected"]["guestInstanceId"],"runtimeGeneration":"11111111-1111-4111-8111-111111111111","attachment":if f.unattached.load(Ordering::SeqCst){Value::Null}else{json!({"ownerId":value["target"]["expected"]["ownerId"],"workerId":value["target"]["expected"]["workerId"]})},"workspaces":[]})
                }
                "cantrip-os.attach" => {
                    let value = f.catalog.lock().unwrap();
                    assert_eq!(c["transport"]["container"], value["target"]["containerId"]);
                    assert_eq!(
                        c["scope"]["guestInstanceId"],
                        value["target"]["expected"]["guestInstanceId"]
                    );
                    f.unattached.store(false, Ordering::SeqCst);
                    failure = f.lose_attach.swap(false, Ordering::SeqCst);
                    json!({"guestInstanceId":value["target"]["expected"]["guestInstanceId"],"runtimeGeneration":"11111111-1111-4111-8111-111111111111","attachment":{"ownerId":value["target"]["expected"]["ownerId"],"workerId":value["target"]["expected"]["workerId"]},"workspaces":[]})
                }
                "cantrip-os.system.capture"
                | "cantrip-os.system.replace"
                | "cantrip-os.system.rollback" => {
                    assert!(c["scope"].get("runtimeGeneration").is_none());
                    let operation = c["operationId"].as_str().unwrap();
                    let mut records = f.records.lock().unwrap();
                    if c["mode"] == "prepare" && f.drop_prepare.swap(false, Ordering::SeqCst) {
                        drop(records);
                        let response = json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":{"message":"Uncertain preparation delivery"}});
                        bridge.receive(&worker, &peer, &response.to_string());
                        continue;
                    }
                    if c["mode"] == "prepare" && !records.contains_key(operation) {
                        let at =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        records.insert(operation.into(),json!({"operationId":operation,"targetGeneration":c["target"]["generation"],"action":c["action"],"state":"running","phase":"prepared","startedAt":at,"updatedAt":at,"root":null,"protectedResult":envelope(),"error":null}));
                    }
                    if c["mode"] == "prepare" {
                        failure = f.lose_prepare.swap(false, Ordering::SeqCst);
                    }
                    let first = c["mode"] == "execute"
                        || (c["mode"] == "continue"
                            && records
                                .get(operation)
                                .is_some_and(|r| r["phase"] == "prepared"));
                    if first {
                        f.executions.lock().unwrap().push(operation.into());
                        let at =
                            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        let mut result = json!({"operationId":operation,"targetGeneration":c["target"]["generation"],"action":c["action"],"state":"running","phase":"running","startedAt":at,"updatedAt":at,"root":null,"protectedResult":null,"error":null});
                        if c["action"] == "capture" {
                            failure = f.lose_capture.swap(false, Ordering::SeqCst);
                        } else {
                            let mut catalog = f.catalog.lock().unwrap();
                            let uncertain =
                                c["action"] == "replace" && c["source"]["kind"] == "checkpoint";
                            if c["action"] == "rollback" {
                                catalog["target"] = c["target"].clone();
                                f.unattached.store(false, Ordering::SeqCst);
                            } else if c["source"]["kind"] == "base" {
                                catalog["target"]["containerId"] = json!("d".repeat(64));
                                catalog["target"]["expected"]["guestInstanceId"] = json!(id());
                                f.unattached.store(true, Ordering::SeqCst);
                            } else {
                                catalog["target"]["containerId"] = json!("e".repeat(64));
                                catalog["target"]["expected"]["guestInstanceId"] =
                                    c["source"]["capture"]["context"]["guestInstanceId"].clone();
                                f.unattached.store(false, Ordering::SeqCst);
                            }
                            result["state"] = json!(if uncertain { "unknown" } else { "ready" });
                            result["phase"] = json!(if uncertain {
                                "create-requested"
                            } else {
                                "complete"
                            });
                            result["protectedResult"] =
                                if uncertain { Value::Null } else { envelope() };
                            result["root"] = json!({"requestSha256":"f".repeat(64),"originalContainerId":c["target"]["containerId"],"targetContainerId":catalog["target"]["containerId"],"retainedContainerId":c["target"]["containerId"],"runtimeHandlesRestored":false,"guestInstanceId":catalog["target"]["expected"]["guestInstanceId"],"guestAttachment":if f.unattached.load(Ordering::SeqCst){"unattached"}else{"owned"}});
                        }
                        records.insert(operation.into(), result);
                    }
                    if !first && c["mode"] == "continue" && c["action"] == "capture" {
                        if let Some(result) = records.get_mut(operation) {
                            result["state"] = json!("ready");
                            result["phase"] = json!("complete");
                            result["protectedResult"] = envelope();
                        }
                    }
                    records.get(operation).cloned().unwrap_or(Value::Null)
                }
                other => panic!("Unexpected Worker command {other}"),
            };
            let response = if failure {
                json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":{"message":"Lost reply /private/worker/diagnostic"}})
            } else {
                json!({"kind":"response","requestId":request["requestId"],"ok":true,"result":result})
            };
            bridge.receive(&worker, &peer, &response.to_string());
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel();
    let app = http::router(service).into_make_service_with_connect_info::<SocketAddr>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    Ok(Running {
        base: format!("http://{address}"),
        stop,
        server,
        responder,
    })
}
async fn get(client: &reqwest::Client, base: &str, path: &str) -> Result<(u16, Value)> {
    let r = client.get(format!("{base}{path}")).send().await?;
    let status = r.status().as_u16();
    Ok((status, serde_json::from_str(&r.text().await?)?))
}
async fn post(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    body: &Value,
) -> Result<(u16, Value)> {
    let r = client
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = r.status().as_u16();
    Ok((status, serde_json::from_str(&r.text().await?)?))
}
#[tokio::test]
async fn system_http_retains_original_jobs_and_fresh_identity_authority_across_server_restart()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?);
    let postgres = ManagedPostgres::start_with_owner(
        root.path(),
        &bin,
        std::path::Path::new(env!("CARGO_BIN_EXE_cantrip-server")),
    )
    .await?;
    let database = Arc::new(Database::postgres(postgres.configuration()).await?);
    migrate(&database).await?;
    let config = Arc::new(ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "none".into()),
            (
                "CANTRIP_DATA_DIR".into(),
                root.path().join("data").to_string_lossy().into_owned(),
            ),
            (
                "CANTRIP_WORKER_TOKEN".into(),
                "unused-system-fixture".into(),
            ),
        ]),
        root.path(),
    )?);
    let service = AuthService::initialize(database.clone(), config.clone()).await?;
    let owner = service.local_user.as_ref().unwrap().id.clone();
    let worker = id();
    database.query("INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','linux','x64',now(),now())", &[&worker,&owner]).await?;
    let repository = Repository::new(database.clone());
    let guest = id();
    let transport = json!({"kind":"docker","container":"a".repeat(64)});
    let instance=repository.attach(&owner,&json!({"workerId":worker,"guestInstanceId":guest,"name":"System","transport":transport,"expectedAttachmentGeneration":null})).await?;
    let instance_id = instance["id"].as_str().unwrap();
    let attachment = instance["attachmentGeneration"].as_str().unwrap();
    for column in ["owner_id", "worker_id", "guest_instance_id"] {
        assert!(
            database
                .query(
                    &format!("UPDATE cantrip_os_instances SET {column}=$1 WHERE id=$2"),
                    &[&id(), &instance_id],
                )
                .await
                .is_err()
        );
    }
    let runtime = id();
    repository
        .observe(
            &owner,
            instance_id,
            attachment,
            "connected",
            Some(&runtime),
            None,
        )
        .await?;
    let image = format!("sha256:{}", "b".repeat(64));
    let base_image = format!("sha256:{}", "c".repeat(64));
    let f = Fixture {
        records: Arc::new(Mutex::new(HashMap::new())),
        commands: Arc::new(Mutex::new(Vec::new())),
        executions: Arc::new(Mutex::new(Vec::new())),
        lose_capture: Arc::new(AtomicBool::new(true)),
        lose_attach: Arc::new(AtomicBool::new(true)),
        unattached: Arc::new(AtomicBool::new(false)),
        drop_prepare: Arc::new(AtomicBool::new(false)),
        lose_prepare: Arc::new(AtomicBool::new(false)),
        catalog: Arc::new(Mutex::new(
            json!({"supported":true,"target":{"generation":id(),"expected":{"guestInstanceId":guest,"ownerId":owner,"workerId":worker,"identityPath":"/private/identity/instance.json"},"containerId":"a".repeat(64),"containerName":"system-fixture","imageId":image,"architecture":"amd64","identityEvidence":"guest-identity"},"bases":[{"imageId":base_image,"architecture":"amd64","tags":["cantrip-os:fixture"]}],"running":true,"enrollment":null,"error":null}),
        )),
    };
    let running = serve(service.clone(), &worker, f.clone()).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let base = format!("/api/cantrip-os/{instance_id}");
    let operations = format!("{base}/system-operations");
    let status_path = format!("{base}/system");
    let (code, status) = get(&client, &running.base, &status_path).await?;
    assert_eq!(code, 200, "{status}");
    assert!(!status.to_string().contains("/private"));
    let request = json!({"operationId":id(),"attachmentGeneration":attachment,"targetGeneration":status["target"]["generation"],"action":"capture","resumeOriginal":true});
    let (code, pending) = post(&client, &running.base, &operations, &request).await?;
    assert_eq!(code, 200, "{pending}");
    assert_eq!(pending["state"], "unknown");
    assert_ne!(pending["attachmentGeneration"], attachment);
    assert_eq!(pending["context"]["attachmentGeneration"], attachment);
    let current = repository.attachment(&owner, instance_id).await?;
    let generation = current["instance"]["attachmentGeneration"]
        .as_str()
        .unwrap();
    let observed = repository
        .observe(
            &owner,
            instance_id,
            generation,
            "connected",
            Some(&runtime),
            None,
        )
        .await?;
    assert_eq!(observed["status"], "unknown");
    assert!(observed["runtimeGeneration"].is_null());
    assert!(repository.attach(&owner,&json!({"workerId":worker,"guestInstanceId":guest,"name":"Retarget","transport":transport,"expectedAttachmentGeneration":pending["attachmentGeneration"]})).await.is_err());
    assert_eq!(post(&client,&running.base,&format!("{base}/power-operations"),&json!({"operationId":id(),"action":"restart","attachmentGeneration":pending["attachmentGeneration"],"targetGeneration":id()})).await?.0,409);
    let (_, same) = post(&client, &running.base, &operations, &request).await?;
    assert_eq!(same["operationId"], pending["operationId"]);
    assert_eq!(
        f.executions
            .lock()
            .unwrap()
            .iter()
            .filter(|op| op.as_str() == pending["operationId"].as_str().unwrap())
            .count(),
        1
    );
    running.responder.abort();
    let _ = running.stop.send(());
    running.server.await??;
    drop(service);
    let service = AuthService::initialize(database.clone(), config).await?;
    let running = serve(service.clone(), &worker, f.clone()).await?;
    let capture_path = format!(
        "{operations}/{}/continue",
        pending["operationId"].as_str().unwrap()
    );
    assert_eq!(post(&client,&running.base,&capture_path,&json!({"attachmentGeneration":attachment,"targetGeneration":pending["targetGeneration"]})).await?.0,409);
    let (code,captured)=post(&client,&running.base,&capture_path,&json!({"attachmentGeneration":pending["attachmentGeneration"],"targetGeneration":pending["targetGeneration"]})).await?;
    assert_eq!(code, 200, "{captured}");
    assert_eq!(captured["state"], "ready");
    assert_eq!(
        post(&client, &running.base, &operations, &request).await?.1,
        captured
    );
    let (_, status) = get(&client, &running.base, &status_path).await?;
    let (code,replaced)=post(&client,&running.base,&operations,&json!({"operationId":id(),"attachmentGeneration":status["target"]["attachmentGeneration"],"targetGeneration":status["target"]["generation"],"action":"replace","startTarget":true,"source":{"kind":"base","imageId":base_image}})).await?;
    assert_eq!(code, 200, "{replaced}");
    assert_eq!(replaced["state"], "ready");
    let recovery_path = format!(
        "{operations}/{}/recover",
        replaced["operationId"].as_str().unwrap()
    );
    let recovery = json!({"attachmentGeneration":replaced["attachmentGeneration"],"targetGeneration":replaced["targetGeneration"]});
    assert_eq!(
        post(&client, &running.base, &recovery_path, &recovery)
            .await?
            .0,
        409
    );
    let (code, enrolled) = post(&client, &running.base, &recovery_path, &recovery).await?;
    assert_eq!(code, 200, "{enrolled}");
    assert_eq!(enrolled["id"], instance_id);
    assert_ne!(enrolled["guestInstanceId"], guest);
    assert!(enrolled["runtimeGeneration"].is_null());
    assert_eq!(
        f.commands
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c["type"] == "cantrip-os.attach")
            .count(),
        1
    );
    let count = f.commands.lock().unwrap().len();
    assert_eq!(
        post(&client, &running.base, &recovery_path, &recovery)
            .await?
            .1,
        enrolled
    );
    assert_eq!(f.commands.lock().unwrap().len(), count);
    let (_, status) = get(&client, &running.base, &status_path).await?;
    let (code,restoring)=post(&client,&running.base,&operations,&json!({"operationId":id(),"attachmentGeneration":status["target"]["attachmentGeneration"],"targetGeneration":status["target"]["generation"],"action":"replace","source":{"kind":"checkpoint","operationId":captured["operationId"]}})).await?;
    assert_eq!(code, 200, "{restoring}");
    assert_eq!(restoring["state"], "unknown");
    let (code,rollback)=post(&client,&running.base,&operations,&json!({"operationId":id(),"attachmentGeneration":restoring["attachmentGeneration"],"targetGeneration":restoring["targetGeneration"],"action":"rollback","replacementOperationId":restoring["operationId"]})).await?;
    assert_eq!(code, 200, "{rollback}");
    assert_eq!(rollback["state"], "ready");
    assert_eq!(post(&client,&running.base,&format!("{operations}/{}/continue",restoring["operationId"].as_str().unwrap()),&json!({"attachmentGeneration":restoring["attachmentGeneration"],"targetGeneration":restoring["targetGeneration"]})).await?.0,409);
    let (code,restored)=post(&client,&running.base,&format!("{operations}/{}/recover",rollback["operationId"].as_str().unwrap()),&json!({"attachmentGeneration":rollback["attachmentGeneration"],"targetGeneration":rollback["targetGeneration"]})).await?;
    assert_eq!(code, 200, "{restored}");
    let fresh = id();
    repository
        .observe(
            &owner,
            instance_id,
            restored["attachmentGeneration"].as_str().unwrap(),
            "connected",
            Some(&fresh),
            None,
        )
        .await?;
    {
        let mut records = f.records.lock().unwrap();
        let result = records
            .get_mut(restoring["operationId"].as_str().unwrap())
            .unwrap();
        result["state"] = json!("ready");
        result["phase"] = json!("complete");
        result["protectedResult"] = envelope();
    }
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!(
                "{operations}/{}/observe",
                restoring["operationId"].as_str().unwrap()
            ),
            &json!({})
        )
        .await?
        .0,
        200
    );
    assert_eq!(
        repository.attachment(&owner, instance_id).await?["instance"]["runtimeGeneration"],
        fresh
    );
    let (code, page) = get(&client, &running.base, &format!("{operations}?limit=1")).await?;
    assert_eq!(code, 200, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_string());
    assert!(!page.to_string().contains("/private"));
    let (_, status) = get(&client, &running.base, &status_path).await?;
    f.drop_prepare.store(true, Ordering::SeqCst);
    let (_, missing) = post(
        &client,
        &running.base,
        &operations,
        &json!({
            "operationId":id(), "action":"capture",
            "attachmentGeneration":status["target"]["attachmentGeneration"],
            "targetGeneration":status["target"]["generation"],
        }),
    )
    .await?;
    assert_eq!(missing["state"], "unknown");
    assert_eq!(missing["dispatchStage"], "preparing");
    let missing_id = missing["operationId"].as_str().unwrap();
    assert!(!f.records.lock().unwrap().contains_key(missing_id));
    let control = json!({"attachmentGeneration":missing["attachmentGeneration"],"targetGeneration":missing["targetGeneration"]});
    for _ in 0..2 {
        let (code, result) = post(
            &client,
            &running.base,
            &format!("{operations}/{missing_id}/continue"),
            &control,
        )
        .await?;
        assert_eq!(code, 200, "{result}");
        assert_eq!(result["dispatchStage"], "executing");
    }
    assert_eq!(
        f.executions
            .lock()
            .unwrap()
            .iter()
            .filter(|op| op.as_str() == missing_id)
            .count(),
        1
    );
    let (_, status) = get(&client, &running.base, &status_path).await?;
    f.lose_prepare.store(true, Ordering::SeqCst);
    let (_, missing_ack) = post(
        &client,
        &running.base,
        &operations,
        &json!({
            "operationId":id(), "action":"capture",
            "attachmentGeneration":status["target"]["attachmentGeneration"],
            "targetGeneration":status["target"]["generation"],
        }),
    )
    .await?;
    let waiting_id = missing_ack["operationId"].as_str().unwrap();
    let (_, prepared) = post(
        &client,
        &running.base,
        &format!("{operations}/{waiting_id}/observe"),
        &json!({}),
    )
    .await?;
    assert_eq!(prepared["phase"], "prepared");
    assert_eq!(prepared["dispatchStage"], "preparing");
    let control = json!({"attachmentGeneration":prepared["attachmentGeneration"],"targetGeneration":prepared["targetGeneration"]});
    let (code, closed) = post(
        &client,
        &running.base,
        &format!("{operations}/{waiting_id}/abandon"),
        &control,
    )
    .await?;
    assert_eq!(code, 200, "{closed}");
    assert_eq!(closed["state"], "rejected");
    assert_eq!(closed["phase"], "not-dispatched");
    assert!(
        !f.executions
            .lock()
            .unwrap()
            .iter()
            .any(|op| op == waiting_id)
    );
    let command_count = f.commands.lock().unwrap().len();
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!("{operations}/{waiting_id}/continue"),
            &control
        )
        .await?
        .1,
        closed
    );
    assert_eq!(f.commands.lock().unwrap().len(), command_count);
    let (_, status) = get(&client, &running.base, &status_path).await?;
    service
        .workers
        .bridge
        .local()
        .disconnect(&worker, "test offline before request", 1000);
    let refused = json!({"operationId":id(),"attachmentGeneration":status["target"]["attachmentGeneration"],"targetGeneration":status["target"]["generation"],"action":"capture"});
    let (code, rejected) = post(&client, &running.base, &operations, &refused).await?;
    assert_eq!(code, 200, "{rejected}");
    assert_eq!(rejected["state"], "rejected");
    assert_eq!(rejected["phase"], "not-dispatched");
    assert!(rejected["protectedResult"].is_null());
    assert_eq!(
        post(&client, &running.base, &operations, &refused).await?.1,
        rejected
    );
    running.responder.abort();
    let _ = running.stop.send(());
    running.server.await??;
    Ok(())
}
