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
async fn serve(
    service: Arc<AuthService>,
    worker: &str,
    records: Records,
    commands: Commands,
    lose: Arc<AtomicBool>,
    staged: Arc<AtomicBool>,
    catalog: Arc<Mutex<Value>>,
) -> Result<Running> {
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
            let command = &request["command"];
            commands.lock().unwrap().push(command.clone());
            assert!(command["scope"].get("runtimeGeneration").is_none());
            let status = command["type"] == "cantrip-os.packages.status";
            let result = if status {
                catalog.lock().unwrap().clone()
            } else {
                assert_eq!(command["type"], "cantrip-os.packages.operation");
                let operation = command["operationId"].as_str().unwrap();
                let mut records = records.lock().unwrap();
                if command["mode"] == "execute" {
                    let at =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let staging = staged.load(Ordering::SeqCst);
                    records.insert(operation.into(),json!({"operationId":operation,"targetGeneration":command["target"]["generation"],"action":command["action"],"configuration":command["configuration"],
                        "state":if staging {"unknown"}else{"ready"},"phase":if staging {"ready-to-install"}else{"complete"},"startedAt":at,"updatedAt":at,"error":null,"protectedResult":if staging {Value::Null}else{envelope()}}));
                }
                if let Some(record) = records.get_mut(operation) {
                    if command["mode"] == "continue" && record["phase"] == "ready-to-install" {
                        record["state"] = json!("ready");
                        record["phase"] = json!("complete");
                        record["protectedResult"] = envelope();
                    }
                    if command["mode"] == "abandon" && record["phase"] == "ready-to-install" {
                        record["state"] = json!("failed");
                        record["phase"] = json!("abandoned");
                        record["protectedResult"] = envelope();
                    }
                }
                records.get(operation).cloned().unwrap_or(Value::Null)
            };
            let response = if !status
                && command["mode"] == "execute"
                && lose.swap(false, Ordering::SeqCst)
            {
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
    let response = client.get(format!("{base}{path}")).send().await?;
    let status = response.status().as_u16();
    Ok((status, serde_json::from_str(&response.text().await?)?))
}
async fn post(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    body: &Value,
) -> Result<(u16, Value)> {
    let response = client
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, serde_json::from_str(&response.text().await?)?))
}

#[tokio::test]
async fn package_http_recovers_original_admission_without_an_executor_and_preserves_private_targets()
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
                "unused-package-fixture".into(),
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
    let transport = json!({"kind":"ssh","host":"fixture.invalid","port":22,"user":"root","identityFile":"/private/key","knownHostsFile":"/private/known-hosts"});
    let instance=repository.attach(&owner,&json!({"workerId":worker,"guestInstanceId":guest,"name":"Packages","transport":transport,"expectedAttachmentGeneration":null})).await?;
    let instance_id = instance["id"].as_str().unwrap();
    let attachment = instance["attachmentGeneration"].as_str().unwrap();
    assert!(instance["runtimeGeneration"].is_null());
    let artifact = json!({"name":"cantrip-os-recovery","version":"0.5.0","architecture":"all","sha256":"a".repeat(64),"bytes":21484});
    let catalog = Arc::new(Mutex::new(
        json!({"target":{"generation":id(),"expected":{"guestInstanceId":guest,"ownerId":owner,"workerId":worker,"identityPath":"/private/guest/instance.json"},"bootId":id(),"initStart":"123","architecture":"amd64","containerId":null},"installed":[],"available":[artifact],"unavailable":0}),
    ));
    let records = Arc::new(Mutex::new(HashMap::new()));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let lose = Arc::new(AtomicBool::new(true));
    let staged = Arc::new(AtomicBool::new(false));
    let running = serve(
        service.clone(),
        &worker,
        records.clone(),
        commands.clone(),
        lose.clone(),
        staged.clone(),
        catalog.clone(),
    )
    .await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let base = format!("/api/cantrip-os/{instance_id}");
    let operations = format!("{base}/package-operations");
    let status_path = format!("{base}/packages");
    let (code, status) = get(&client, &running.base, &status_path).await?;
    assert_eq!(code, 200, "{status}");
    assert_eq!(status["target"]["architecture"], "amd64", "{status}");
    assert!(!status.to_string().contains("/private/"));
    assert!(status["target"].get("bootId").is_none());
    let older = repository.package_begin_status(&owner, instance_id).await?;
    let newer = repository.package_begin_status(&owner, instance_id).await?;
    let raw = catalog.lock().unwrap().clone();
    repository
        .package_record_target(&owner, &newer, raw.clone())
        .await?;
    assert!(
        repository
            .package_record_target(&owner, &older, raw)
            .await
            .is_err()
    );
    let request = json!({"operationId":id(),"attachmentGeneration":attachment,"targetGeneration":status["target"]["generation"],"action":"repair","configuration":"preserve","packages":[artifact]});
    let mut invalid = request.clone();
    invalid["runtimeGeneration"] = json!(id());
    assert_eq!(
        post(&client, &running.base, &operations, &invalid).await?.0,
        400
    );
    invalid = request.clone();
    invalid["action"] = json!("upgrade");
    invalid["configuration"] = json!("package-defaults");
    assert_eq!(
        post(&client, &running.base, &operations, &invalid).await?.0,
        400
    );
    invalid = request.clone();
    invalid["packages"][0]["sha256"] = json!("b".repeat(64));
    assert_eq!(
        post(&client, &running.base, &operations, &invalid).await?.0,
        409
    );
    let old_status = repository.package_begin_status(&owner, instance_id).await?;
    let (code, initial) = post(&client, &running.base, &operations, &request).await?;
    assert_eq!(code, 200, "{initial}");
    assert_eq!(initial["state"], "unknown");
    assert!(!initial.to_string().contains("/private/"));
    let raw = catalog.lock().unwrap().clone();
    assert!(
        repository
            .package_record_target(&owner, &old_status, raw)
            .await
            .is_err()
    );
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    drop(service);
    let service = AuthService::initialize(database.clone(), config).await?;
    let running = serve(
        service,
        &worker,
        records.clone(),
        commands.clone(),
        lose,
        staged.clone(),
        catalog.clone(),
    )
    .await?;
    let (code, complete) = post(&client, &running.base, &operations, &request).await?;
    assert_eq!(code, 200, "{complete}");
    assert_eq!(complete["state"], "ready");
    assert_eq!(complete["protectedResult"], envelope());
    let after = commands.lock().unwrap().len();
    assert_eq!(
        post(&client, &running.base, &operations, &request).await?.1,
        complete
    );
    assert_eq!(commands.lock().unwrap().len(), after);
    assert_eq!(
        commands
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c["mode"] == "execute")
            .count(),
        1
    );
    let old_row = repository
        .package_begin(
            &owner,
            instance_id,
            request["operationId"].as_str().unwrap(),
            None,
        )
        .await?;
    let mut late = records.lock().unwrap()[request["operationId"].as_str().unwrap()].clone();
    late["state"] = json!("running");
    late["protectedResult"] = Value::Null;
    assert_eq!(
        repository.package_record(&owner, &old_row, late).await?["state"],
        "ready"
    );
    let (code, new_status) = get(&client, &running.base, &status_path).await?;
    assert_eq!(code, 200, "{new_status}");
    assert_ne!(
        new_status["target"]["generation"],
        request["targetGeneration"]
    );
    let mut stale = request.clone();
    stale["operationId"] = json!(id());
    assert_eq!(
        post(&client, &running.base, &operations, &stale).await?.0,
        409
    );
    staged.store(true, Ordering::SeqCst);
    let mut continued = request.clone();
    continued["operationId"] = json!(id());
    continued["targetGeneration"] = new_status["target"]["generation"].clone();
    assert_eq!(
        post(&client, &running.base, &operations, &continued)
            .await?
            .1["phase"],
        "ready-to-install"
    );
    let control =
        json!({"attachmentGeneration":attachment,"targetGeneration":continued["targetGeneration"]});
    let continuation = format!(
        "{operations}/{}/continue",
        continued["operationId"].as_str().unwrap()
    );
    let before = commands.lock().unwrap().len();
    let mut wrong_target = control.clone();
    wrong_target["targetGeneration"] = json!(id());
    assert_eq!(
        post(&client, &running.base, &continuation, &wrong_target).await?,
        (
            409,
            json!({"error":"Package operation not found for the original target."}),
        ),
    );
    assert_eq!(commands.lock().unwrap().len(), before);
    assert_eq!(
        post(&client, &running.base, &continuation, &control)
            .await?
            .1["state"],
        "ready"
    );
    let actual = commands
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c["operationId"] == continued["operationId"])
        .cloned()
        .collect::<Vec<_>>();
    let mut repeated = actual[1].clone();
    repeated["mode"] = json!("execute");
    assert_eq!(actual[0], repeated);
    let fresh = get(&client, &running.base, &status_path).await?.1;
    let mut abandoned = request.clone();
    abandoned["operationId"] = json!(id());
    abandoned["targetGeneration"] = fresh["target"]["generation"].clone();
    post(&client, &running.base, &operations, &abandoned).await?;
    let abandon_path = format!(
        "{operations}/{}/abandon",
        abandoned["operationId"].as_str().unwrap()
    );
    let abandon_control =
        json!({"attachmentGeneration":attachment,"targetGeneration":abandoned["targetGeneration"]});
    assert_eq!(
        post(&client, &running.base, &abandon_path, &abandon_control)
            .await?
            .1["state"],
        "failed"
    );
    let page = get(&client, &running.base, &format!("{operations}?limit=1"))
        .await?
        .1;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_string());
    let next = get(
        &client,
        &running.base,
        &format!(
            "{operations}?limit=1&cursor={}",
            page["nextCursor"].as_str().unwrap()
        ),
    )
    .await?
    .1;
    assert_ne!(
        next["items"][0]["operationId"],
        page["items"][0]["operationId"]
    );
    catalog.lock().unwrap()["target"]["expected"]["ownerId"] = json!("other");
    assert!(get(&client, &running.base, &status_path).await?.1["target"].is_null());
    catalog.lock().unwrap()["target"]["expected"]["ownerId"] = json!(owner);
    let fresh = get(&client, &running.base, &status_path).await?.1;
    let mut pending = request.clone();
    pending["operationId"] = json!(id());
    pending["targetGeneration"] = fresh["target"]["generation"].clone();
    post(&client, &running.base, &operations, &pending).await?;
    let replacement=repository.attach(&owner,&json!({"workerId":worker,"guestInstanceId":guest,"name":"Reattached","transport":{"kind":"docker","container":"replacement"},"expectedAttachmentGeneration":attachment})).await?;
    assert_ne!(replacement["attachmentGeneration"], json!(attachment));
    let pending_control =
        json!({"attachmentGeneration":attachment,"targetGeneration":pending["targetGeneration"]});
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!(
                "{operations}/{}/continue",
                pending["operationId"].as_str().unwrap()
            ),
            &pending_control
        )
        .await?
        .0,
        409
    );
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!(
                "{operations}/{}/observe",
                pending["operationId"].as_str().unwrap()
            ),
            &json!({})
        )
        .await?
        .0,
        200
    );
    let last = commands.lock().unwrap().last().unwrap().clone();
    assert_eq!(last["mode"], "observe");
    assert_eq!(last["transport"], transport);
    assert_eq!(last["target"]["generation"], pending["targetGeneration"]);
    assert_eq!(
        get(
            &client,
            &running.base,
            &format!("{operations}/{}", request["operationId"].as_str().unwrap())
        )
        .await?
        .1["protectedResult"],
        envelope()
    );
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    Ok(())
}
