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
    physical: Arc<Mutex<Value>>,
) -> Result<Running> {
    let (peer, mut output) = Peer::new(Continuity {
        owner: service.local_user.as_ref().unwrap().id.clone(),
        credential: "fixture".into(),
        process_generation: id(),
    });
    assert!(service.workers.bridge.attach(worker, peer.clone(), None));
    let bridge = service.workers.bridge.clone();
    let worker = worker.to_owned();
    let responder = tokio::spawn(async move {
        while let Some(Outgoing::Text(encoded)) = output.recv().await {
            let request: Value = serde_json::from_str(&encoded).unwrap();
            let command = &request["command"];
            commands.lock().unwrap().push(command.clone());
            let kind = command["type"].as_str().unwrap();
            let result = if kind == "cantrip-os.desktop.status" {
                physical.lock().unwrap().clone()
            } else {
                let operation = command["operationId"].as_str().unwrap();
                if command["mode"] == "observe" {
                    records
                        .lock()
                        .unwrap()
                        .get(operation)
                        .cloned()
                        .unwrap_or(Value::Null)
                } else {
                    let mut actual = physical.lock().unwrap();
                    assert_eq!(command["desktopTarget"], *actual);
                    let before = actual.clone();
                    if command["action"] == "stop" {
                        actual["status"] = json!("stopped");
                    } else if command["action"] == "restart" || actual["status"] == "stopped" {
                        actual["generation"] = json!(actual["generation"].as_u64().unwrap() + 1);
                        actual["desktop_generation"] = json!("b".repeat(64));
                        actual["status"] = json!("running");
                    }
                    let now =
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let result = json!({"operationId":operation,"action":command["action"],"state":"ready","startedAt":now,"updatedAt":now,"error":null,
                        "receipt":{"targetGeneration":command["targetGeneration"],"before":before,"after":actual.clone(),"completionEvidence":"acknowledged-and-observed"},
                        "observation":actual.clone(),"observationError":null});
                    records
                        .lock()
                        .unwrap()
                        .insert(operation.into(), result.clone());
                    result
                }
            };
            let response = if kind == "cantrip-os.desktop.operation"
                && command["mode"] == "execute"
                && lose.swap(false, Ordering::SeqCst)
            {
                json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":{"message":"Lost reply after Worker completion"}})
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
async fn post(
    client: &reqwest::Client,
    base: &str,
    route: &str,
    body: &Value,
) -> Result<(u16, Value)> {
    let response = client
        .post(format!("{base}{route}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, serde_json::from_str(&response.text().await?)?))
}
async fn get(client: &reqwest::Client, base: &str, route: &str) -> Result<(u16, Value)> {
    let response = client.get(format!("{base}{route}")).send().await?;
    let status = response.status().as_u16();
    Ok((status, serde_json::from_str(&response.text().await?)?))
}

#[tokio::test]
async fn desktop_http_retains_original_admission_and_independent_runtime_across_server_restart()
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
                "unused-desktop-fixture".into(),
            ),
        ]),
        root.path(),
    )?);
    let service = AuthService::initialize(database.clone(), config.clone()).await?;
    let owner = service.local_user.as_ref().unwrap().id.clone();
    let worker = id();
    database.query("INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','linux','x64',now(),now())", &[&worker,&owner]).await?;
    let repository = Repository::new(database.clone());
    let instance=repository.attach(&owner,&json!({"workerId":worker,"guestInstanceId":id(),"name":"Desktop","transport":{"kind":"docker","container":"fixture"},"expectedAttachmentGeneration":null})).await?;
    let instance_id = instance["id"].as_str().unwrap();
    let attachment = instance["attachmentGeneration"].as_str().unwrap();
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
    let workspace=repository.record_workspace(&owner,instance_id,attachment,&json!({"guestWorkspaceId":"work","uid":20000,"gid":20000,"homeGuestPath":"/homes/work"})).await?;
    assert!(workspace.get("desktopEpoch").is_none());
    let workspace_id = workspace["id"].as_str().unwrap();
    let other=repository.record_workspace(&owner,instance_id,attachment,&json!({"guestWorkspaceId":"other","uid":20001,"gid":20001,"homeGuestPath":"/homes/other"})).await?;
    let physical = Arc::new(Mutex::new(
        json!({"id":"work","user":"ctw-work","uid":20000,"gid":20000,"home":"/homes/work","display":100,"generation":1,"desktop_generation":"a".repeat(64),"status":"running"}),
    ));
    let records = Arc::new(Mutex::new(HashMap::new()));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let lose = Arc::new(AtomicBool::new(true));
    let running = serve(
        service.clone(),
        &worker,
        records.clone(),
        commands.clone(),
        lose.clone(),
        physical.clone(),
    )
    .await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let base = format!("/api/cantrip-os/{instance_id}/workspaces/{workspace_id}");
    let status_route = format!("{base}/desktop");
    let operations = format!("{base}/desktop-operations");
    let (code, status) = get(&client, &running.base, &status_route).await?;
    assert_eq!(code, 200, "{status}");
    assert_eq!(status["observation"]["status"], "running");
    assert!(!status.to_string().contains("/homes/work"));
    assert!(!status.to_string().contains(&"a".repeat(64)));
    let request = json!({"operationId":id(),"action":"restart","attachmentGeneration":attachment,"runtimeGeneration":runtime,"targetGeneration":status["target"]["generation"]});
    let expected = repository
        .desktop_context(&owner, instance_id, workspace_id)
        .await?;
    let (code, first) = post(&client, &running.base, &operations, &request).await?;
    assert_eq!(code, 200, "{first}");
    assert_eq!(first["state"], "unknown");
    let actual = physical.lock().unwrap().clone();
    assert!(
        repository
            .record_desktop_target(&owner, &expected, actual)
            .await
            .is_err()
    );
    let mut duplicate = request.clone();
    duplicate["operationId"] = json!(id());
    assert_eq!(
        post(&client, &running.base, &operations, &duplicate)
            .await?
            .0,
        409
    );
    let admission = repository
        .desktop_get(
            &owner,
            instance_id,
            workspace_id,
            request["operationId"].as_str().unwrap(),
        )
        .await?
        .unwrap()["command"]
        .clone();
    assert_eq!(
        repository
            .desktop_context(&owner, instance_id, workspace_id)
            .await?["instance"]["status"],
        "connected"
    );
    assert_eq!(
        repository
            .desktop_context(&owner, instance_id, other["id"].as_str().unwrap())
            .await?["workspace"]["desktop_epoch"],
        0
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
        physical.clone(),
    )
    .await?;
    let (code, recovered) = post(&client, &running.base, &operations, &request).await?;
    assert_eq!(code, 200, "{recovered}");
    assert_eq!(recovered["state"], "ready");
    assert_eq!(
        commands
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c["type"] == "cantrip-os.desktop.operation" && c["mode"] == "execute")
            .count(),
        1
    );
    assert_eq!(
        repository
            .desktop_get(
                &owner,
                instance_id,
                workspace_id,
                request["operationId"].as_str().unwrap()
            )
            .await?
            .unwrap()["command"],
        admission
    );
    let mut changed = request.clone();
    changed["action"] = json!("stop");
    assert_eq!(
        post(&client, &running.base, &operations, &changed).await?.0,
        409
    );
    assert!(
        repository
            .desktop_get(
                "other",
                instance_id,
                workspace_id,
                request["operationId"].as_str().unwrap()
            )
            .await?
            .is_none()
    );
    let wrong = format!(
        "/api/cantrip-os/{instance_id}/workspaces/{}/desktop-operations/{}",
        other["id"].as_str().unwrap(),
        request["operationId"].as_str().unwrap()
    );
    assert_eq!(get(&client, &running.base, &wrong).await?.0, 409);
    let fresh = get(&client, &running.base, &status_route).await?.1;
    assert_ne!(
        fresh["target"]["generation"],
        status["target"]["generation"]
    );
    let second = json!({"operationId":id(),"action":"stop","attachmentGeneration":attachment,"runtimeGeneration":runtime,"targetGeneration":fresh["target"]["generation"]});
    let (code, saved) = post(&client, &running.base, &operations, &second).await?;
    assert_eq!(code, 200, "{saved}");
    assert_eq!(saved["state"], "ready");
    let (code, page) = get(&client, &running.base, &format!("{operations}?limit=1")).await?;
    assert_eq!(code, 200, "{page}");
    assert_eq!(page["items"][0]["operationId"], second["operationId"]);
    let tail = get(
        &client,
        &running.base,
        &format!(
            "{operations}?cursor={}",
            page["nextCursor"].as_str().unwrap()
        ),
    )
    .await?
    .1;
    assert_eq!(tail["items"][0]["operationId"], request["operationId"]);
    // No Worker receipt exists for this admitted command: observation remains
    // unknown. A fresh actual target can replace only the future authority.
    let stopped = get(&client, &running.base, &status_route).await?.1;
    let lost = json!({"operationId":id(),"action":"start","attachmentGeneration":attachment,"runtimeGeneration":runtime,"targetGeneration":stopped["target"]["generation"]});
    let (row, created) = repository
        .desktop_admit(&owner, instance_id, workspace_id, "server", &lost)
        .await?;
    assert!(created);
    repository.desktop_unknown(&owner, &row).await?;
    {
        let mut target = physical.lock().unwrap();
        target["generation"] = json!(3);
        target["desktop_generation"] = json!("c".repeat(64));
        target["status"] = json!("running");
    }
    let new_target = get(&client, &running.base, &status_route).await?.1;
    let new_request = json!({"operationId":id(),"action":"stop","attachmentGeneration":attachment,"runtimeGeneration":runtime,"targetGeneration":new_target["target"]["generation"]});
    assert_eq!(
        post(&client, &running.base, &operations, &new_request)
            .await?
            .1["state"],
        "ready"
    );
    let observed = post(
        &client,
        &running.base,
        &format!(
            "{operations}/{}/observe",
            lost["operationId"].as_str().unwrap()
        ),
        &json!({}),
    )
    .await?;
    assert_eq!(observed.0, 200, "{}", observed.1);
    assert_eq!(observed.1["state"], "unknown");
    assert!(
        commands
            .lock()
            .unwrap()
            .iter()
            .all(|c| c["operationId"] != lost["operationId"] || c["mode"] == "observe")
    );
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    Ok(())
}
