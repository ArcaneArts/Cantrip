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
            let kind = command["type"].as_str().unwrap();
            let operation = command["operationId"].as_str().unwrap();
            let result = if kind == "cantrip-os.operation.inspect" {
                records
                    .lock()
                    .unwrap()
                    .get(operation)
                    .cloned()
                    .unwrap_or(Value::Null)
            } else {
                assert_eq!(kind, "cantrip-os.workspaces.create");
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let result = json!({"operationId":operation,"state":"ready","startedAt":now,"updatedAt":now,"error":null,
                  "receipt":{"kind":"workspace","workspace":{"guestWorkspaceId":command["guestWorkspaceId"],"uid":20000,"gid":20000,"homeGuestPath":format!("/homes/{}",command["guestWorkspaceId"].as_str().unwrap())}}});
                records
                    .lock()
                    .unwrap()
                    .insert(operation.into(), result.clone());
                result
            };
            let response = if kind == "cantrip-os.workspaces.create"
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
async fn workspace_creation_retains_original_authority_after_server_restart_and_replacement()
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
                "unused-workspace-fixture".into(),
            ),
        ]),
        root.path(),
    )?);
    let service = AuthService::initialize(database.clone(), config.clone()).await?;
    let server_id = service.server_id.clone();
    let owner = service.local_user.as_ref().unwrap().id.clone();
    let worker = id();
    database.query("INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Worker','linux','x64',now(),now())", &[&worker,&owner]).await?;
    let repository = Repository::new(database.clone());
    let instance=repository.attach(&owner,&json!({"workerId":worker,"guestInstanceId":id(),"name":"OS","transport":{"kind":"docker","container":"original"},"expectedAttachmentGeneration":null})).await?;
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
    let base = format!("/api/cantrip-os/{instance_id}");
    let create = format!("{base}/workspaces");
    let history = format!("{base}/workspace-operations");
    let input = json!({"operationId":id(),"guestWorkspaceId":"work"});
    let (code, first) = post(&client, &running.base, &create, &input).await?;
    assert_eq!(code, 200, "{first}");
    assert_eq!(first["state"], "unknown");
    assert!(repository.workspaces(&owner, instance_id).await?.is_empty());
    let original = repository
        .workspace_operation_get(&owner, instance_id, input["operationId"].as_str().unwrap())
        .await?
        .unwrap();
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    drop(service);
    let service = AuthService::initialize(database.clone(), config).await?;
    assert_eq!(service.server_id, server_id);
    let running = serve(
        service.clone(),
        &worker,
        records.clone(),
        commands.clone(),
        lose.clone(),
    )
    .await?;
    let (code, ready) = post(&client, &running.base, &create, &input).await?;
    assert_eq!(code, 200, "{ready}");
    assert_eq!(ready["state"], "ready");
    assert_eq!(repository.workspaces(&owner, instance_id).await?.len(), 1);
    assert_eq!(
        commands.lock().unwrap().last().unwrap(),
        &json!({"type":"cantrip-os.operation.inspect","scope":original["command"]["scope"],"operationId":input["operationId"]})
    );
    let mut wrong = input.clone();
    wrong["guestWorkspaceId"] = json!("other");
    assert_eq!(post(&client, &running.base, &create, &wrong).await?.0, 409);
    assert!(
        repository
            .workspace_operation_get("other", instance_id, input["operationId"].as_str().unwrap())
            .await?
            .is_none()
    );
    assert!(
        repository
            .workspace_operation_list("other", instance_id, &json!({"limit":20}))
            .await
            .is_err()
    );

    lose.store(true, Ordering::SeqCst);
    let replacement = json!({"operationId":id(),"guestWorkspaceId":"replacement"});
    assert_eq!(
        post(&client, &running.base, &create, &replacement).await?.1["state"],
        "unknown"
    );
    let replaced = repository
        .workspace_operation_get(
            &owner,
            instance_id,
            replacement["operationId"].as_str().unwrap(),
        )
        .await?
        .unwrap();
    database.query("UPDATE cantrip_os_instances SET attachment_generation=$1,runtime_generation=$2,transport=jsonb_build_object('kind','docker','container','replacement') WHERE id=$3", &[&id(),&id(),&instance_id]).await?;
    assert_eq!(
        post(&client, &running.base, &create, &replacement).await?.1["state"],
        "ready"
    );
    assert_eq!(
        commands.lock().unwrap().last().unwrap(),
        &json!({"type":"cantrip-os.operation.inspect","scope":replaced["command"]["scope"],"operationId":replacement["operationId"]})
    );
    assert_eq!(repository.workspaces(&owner, instance_id).await?.len(), 1);
    let summary = get(
        &client,
        &running.base,
        &format!("{history}/{}", replacement["operationId"].as_str().unwrap()),
    )
    .await?
    .1;
    assert_eq!(summary["attachmentGeneration"], attachment);
    assert!(!summary.to_string().contains("transport"));

    let pending = json!({"operationId":id(),"guestWorkspaceId":"pending"});
    let (old, _) = repository
        .workspace_operation_admit(&owner, instance_id, &server_id, &pending)
        .await?;
    let fresh = repository
        .workspace_operation_begin(
            &owner,
            instance_id,
            pending["operationId"].as_str().unwrap(),
        )
        .await?;
    repository.workspace_operation_unknown(&fresh).await?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let receipt = json!({"operationId":pending["operationId"],"state":"ready","error":null,"startedAt":now,"updatedAt":now,"receipt":{"kind":"workspace","workspace":{"guestWorkspaceId":"pending","uid":20003,"gid":20003,"homeGuestPath":"/homes/pending"}}});
    assert_eq!(
        repository
            .workspace_operation_record(&old, receipt.clone())
            .await?["state"],
        "unknown"
    );
    let fresh = repository
        .workspace_operation_begin(
            &owner,
            instance_id,
            pending["operationId"].as_str().unwrap(),
        )
        .await?;
    let mut bad = receipt.clone();
    bad["operationId"] = json!(id());
    assert!(
        repository
            .workspace_operation_record(&fresh, bad)
            .await
            .is_err()
    );
    let mut bad = receipt.clone();
    bad["receipt"]["workspace"]["guestWorkspaceId"] = json!("wrong");
    assert!(
        repository
            .workspace_operation_record(&fresh, bad)
            .await
            .is_err()
    );
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!(
                "{history}/{}/observe",
                pending["operationId"].as_str().unwrap()
            ),
            &json!({})
        )
        .await?
        .1["state"],
        "unknown"
    );
    records
        .lock()
        .unwrap()
        .insert(pending["operationId"].as_str().unwrap().into(), receipt);
    assert_eq!(
        post(
            &client,
            &running.base,
            &format!(
                "{history}/{}/observe",
                pending["operationId"].as_str().unwrap()
            ),
            &json!({})
        )
        .await?
        .1["state"],
        "ready"
    );
    let page = get(&client, &running.base, &format!("{history}?limit=1"))
        .await?
        .1;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let next = get(
        &client,
        &running.base,
        &format!(
            "{history}?limit=1&cursor={}",
            page["nextCursor"].as_str().unwrap()
        ),
    )
    .await?
    .1;
    assert_ne!(
        next["items"][0]["operationId"],
        page["items"][0]["operationId"]
    );
    assert_eq!(
        get(
            &client,
            &running.base,
            &format!("{history}?cursor={}", id())
        )
        .await?
        .0,
        409
    );
    assert_eq!(
        commands
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c["type"] == "cantrip-os.workspaces.create")
            .count(),
        2
    );
    assert_eq!(
        get(&client, &running.base, &format!("{history}?limit=0"))
            .await?
            .0,
        400
    );
    running.stop.send(()).ok();
    running.server.await??;
    running.responder.abort();
    Ok(())
}
