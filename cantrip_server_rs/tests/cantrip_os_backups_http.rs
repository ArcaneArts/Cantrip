use anyhow::{Context, Result};
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
fn frame(sequence: u8) -> Value {
    json!({"kind":"metadata","sequence":sequence,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}})
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
            let operation = command["operationId"].as_str().unwrap();
            let result = if kind == "cantrip-os.backup.observe" {
                records.lock().unwrap().get(operation).unwrap().clone()
            } else {
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let value = json!({"operationId":operation,"action":kind.strip_prefix("cantrip-os.backup.").unwrap(),"state":"ready","phase":"complete","startedAt":now,"updatedAt":now,"protectedResult":frame(2),"error":null});
                records
                    .lock()
                    .unwrap()
                    .insert(operation.into(), value.clone());
                value
            };
            let response = if kind != "cantrip-os.backup.observe"
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
async fn target(
    repository: &Repository,
    owner: &str,
    worker: &str,
    name: &str,
    uid: i32,
) -> Result<(Value, Value, String)> {
    let instance=repository.attach(owner,&json!({"workerId":worker,"guestInstanceId":id(),"name":name,"transport":{"kind":"docker","container":name},"expectedAttachmentGeneration":null})).await?;
    let runtime = id();
    let instance_id = instance["id"].as_str().unwrap();
    let generation = instance["attachmentGeneration"].as_str().unwrap();
    repository
        .observe(
            owner,
            instance_id,
            generation,
            "connected",
            Some(&runtime),
            None,
        )
        .await?;
    let workspace=repository.record_workspace(owner,instance_id,generation,&json!({"guestWorkspaceId":name,"uid":uid,"gid":uid,"homeGuestPath":format!("/private/{name}")})).await?;
    Ok((instance, workspace, runtime))
}

#[tokio::test]
async fn backup_http_keeps_owned_admissions_across_native_server_restart() -> Result<()> {
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
    let config = Arc::new(ServerConfig::read(
        &Environment::from([
            ("CANTRIP_AUTH_MODE".into(), "none".into()),
            (
                "CANTRIP_DATA_DIR".into(),
                root.path().join("data").to_string_lossy().into_owned(),
            ),
            (
                "CANTRIP_WORKER_TOKEN".into(),
                "unused-backup-fixture".into(),
            ),
        ]),
        root.path(),
    )?);
    let service = AuthService::initialize(database.clone(), config.clone()).await?;
    let owner = service.local_user.as_ref().unwrap().id.clone();
    let worker = id();
    database.query("INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','linux','x64',now(),now())", &[&worker,&owner]).await?;
    let repository = Repository::new(database.clone());
    let (instance, workspace, original_runtime) =
        target(&repository, &owner, &worker, "source", 20000).await?;
    let (destination, target_workspace, target_runtime) =
        target(&repository, &owner, &worker, "destination", 20001).await?;
    let records = Arc::new(Mutex::new(HashMap::new()));
    let commands = Arc::new(Mutex::new(Vec::new()));
    let lose = Arc::new(AtomicBool::new(true));
    let running = serve(
        service.clone(),
        &worker,
        records.clone(),
        commands.clone(),
        lose.clone(),
    )
    .await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let capture_id = id();
    let instance_id = instance["id"].as_str().unwrap();
    repository
        .observe(
            &owner,
            instance_id,
            instance["attachmentGeneration"].as_str().unwrap(),
            "unknown",
            Some(&original_runtime),
            None,
        )
        .await?;
    let route = format!("/api/cantrip-os/{instance_id}/backup-operations");
    let capture = json!({"action":"capture","operationId":capture_id,"workspaceId":workspace["id"],"attachmentGeneration":instance["attachmentGeneration"],"runtimeGeneration":original_runtime,"protectedRequest":frame(1)});
    let mut wrong = capture.clone();
    wrong["runtimeGeneration"] = json!(id());
    assert_eq!(post(&client, &running.base, &route, &wrong).await?.0, 409);
    wrong = capture.clone();
    wrong["uid"] = json!(0);
    assert_eq!(post(&client, &running.base, &route, &wrong).await?.0, 400);
    assert!(commands.lock().unwrap().is_empty());
    let (status, lost) = post(&client, &running.base, &route, &capture).await?;
    assert_eq!(status, 200, "{lost}");
    assert_eq!(lost["result"]["state"], "unknown");
    assert!(!lost.to_string().contains("/private/source"));
    assert!(lost.get("command").is_none());
    let changed = id();
    repository
        .observe(
            &owner,
            instance_id,
            instance["attachmentGeneration"].as_str().unwrap(),
            "connected",
            Some(&changed),
            None,
        )
        .await?;
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    // Reinitialize the actual AuthService and HTTP router from persisted state;
    // only the authenticated Worker fixture keeps its completed operation map.
    let restarted = AuthService::initialize(database.clone(), config).await?;
    assert_eq!(restarted.server_id, service.server_id);
    let running = serve(restarted, &worker, records.clone(), commands.clone(), lose).await?;
    let (status, recovered) = post(&client, &running.base, &route, &capture).await?;
    assert_eq!(status, 200, "{recovered}");
    assert_eq!(recovered["result"]["state"], "ready");
    {
        let sent = commands.lock().unwrap();
        assert_eq!(
            sent.iter()
                .filter(|c| c["type"] == "cantrip-os.backup.capture")
                .count(),
            1
        );
        assert_eq!(
            sent.last().unwrap()["scope"]["runtimeGeneration"],
            original_runtime
        );
    }
    let recovery_route = format!("/api/cantrip-os/backup-operations/{capture_id}/recovery");
    assert_eq!(post(&client,&running.base,&recovery_route,&json!({"mode":"continue","attachmentGeneration":instance["attachmentGeneration"],"runtimeGeneration":original_runtime})).await?.0,409);
    let (status,continued)=post(&client,&running.base,&recovery_route,&json!({"mode":"continue","attachmentGeneration":instance["attachmentGeneration"],"runtimeGeneration":changed})).await?;
    assert_eq!(status, 200, "{continued}");
    {
        let sent = commands.lock().unwrap();
        let c = sent.last().unwrap();
        assert_eq!(c["scope"]["runtimeGeneration"], original_runtime);
        assert_eq!(c["continuationScope"]["runtimeGeneration"], changed);
    }
    let persisted = repository.backup_get(&owner, &capture_id).await?.unwrap();
    assert_eq!(
        persisted["command"]["scope"]["runtimeGeneration"],
        original_runtime
    );
    assert_eq!(
        persisted["continuation_scope"]["runtimeGeneration"],
        changed
    );
    let restore_id = id();
    let restore = json!({"action":"restore","operationId":restore_id,"workspaceId":target_workspace["id"],"attachmentGeneration":destination["attachmentGeneration"],"runtimeGeneration":target_runtime,"backupId":capture_id,"replace":false,"protectedRequest":frame(1)});
    let (status, restored) = post(
        &client,
        &running.base,
        &format!(
            "/api/cantrip-os/{}/backup-operations",
            destination["id"].as_str().unwrap()
        ),
        &restore,
    )
    .await?;
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored["result"]["state"], "ready");
    {
        let sent = commands.lock().unwrap();
        let c = sent.last().unwrap();
        assert_eq!(c["backupScope"]["runtimeGeneration"], original_runtime);
        assert_eq!(c["scope"]["runtimeGeneration"], target_runtime);
        assert_eq!(c["workspace"]["uid"], 20001);
    }
    let (status, page) = get(&client, &running.base, "/api/cantrip-os/backups?limit=1").await?;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_null());
    assert_eq!(page["items"][0]["operationId"], capture_id);
    assert_eq!(page["items"][0]["archiveAvailability"], "not-checked");
    let (status, all) = get(
        &client,
        &running.base,
        "/api/cantrip-os/backup-operations?limit=1",
    )
    .await?;
    assert_eq!(status, 200, "{all}");
    let next = all["nextCursor"].as_str().context("Operation cursor")?;
    let (status, second) = get(
        &client,
        &running.base,
        &format!("/api/cantrip-os/backup-operations?limit=1&cursor={next}"),
    )
    .await?;
    assert_eq!(status, 200, "{second}");
    assert_ne!(
        second["items"][0]["operationId"],
        all["items"][0]["operationId"]
    );
    assert!(repository.backup_get("other", &capture_id).await?.is_none());
    let wrong = json!({"mode":"continue","scope":{"workerId":"other"}});
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!("/api/cantrip-os/backup-operations/{capture_id}/recovery"),
            &wrong
        )
        .await?
        .0,
        400
    );
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    Ok(())
}
