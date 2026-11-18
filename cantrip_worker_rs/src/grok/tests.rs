use super::*;
use crate::codex::managed::Host;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinSet,
};

#[derive(Default)]
struct Fixture {
    issued: AtomicUsize,
    polls: AtomicUsize,
    billed: AtomicUsize,
    refreshes: AtomicUsize,
    exchange_started: Notify,
    release_exchange: Notify,
    exchange_released: Notify,
    records: Mutex<HashMap<String, Value>>,
    reads: AtomicUsize,
    models: AtomicUsize,
    billing_failed: AtomicBool,
    reject_local_model: AtomicBool,
}

impl Fixture {
    async fn serve(self: Arc<Self>, listener: TcpListener) {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                result = listener.accept() => {
                    let (stream, _) = result.unwrap();
                    let this = self.clone();
                    requests.spawn(async move { this.request(stream).await });
                }
                result = requests.join_next(), if !requests.is_empty() => {
                    result.unwrap().unwrap().unwrap();
                }
            }
        }
    }

    async fn request(&self, stream: TcpStream) -> Result<()> {
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        stream.read_line(&mut line).await?;
        let request = line.split_whitespace().nth(1).unwrap().to_owned();
        let mut headers = HashMap::new();
        loop {
            line.clear();
            stream.read_line(&mut line).await?;
            if line.trim().is_empty() {
                break;
            }
            let (header, value) = line.split_once(':').unwrap();
            headers.insert(header.to_ascii_lowercase(), value.trim().to_owned());
        }
        let mut body = vec![
            0;
            headers
                .get("content-length")
                .and_then(|n| n.parse().ok())
                .unwrap_or_default()
        ];
        stream.read_exact(&mut body).await?;
        let form = url::form_urlencoded::parse(&body)
            .into_owned()
            .collect::<HashMap<_, _>>();
        let header = |key: &str| headers.get(key).map(String::as_str);
        let (status, value) = match request.as_str() {
            path if path.starts_with("/api/internal/workers/providers/fixture/accounts/") => {
                let account = path.split('/').nth(7).unwrap();
                assert!(path.ends_with("/credential?workerId=worker"));
                assert_eq!(
                    header("authorization"),
                    Some(format!("Bearer {WORKER_TOKEN}").as_str())
                );
                self.reads.fetch_add(1, Ordering::SeqCst);
                let records = self.records.lock().unwrap();
                match records.get(account) {
                    Some(record) => ("200 OK", record.clone()),
                    None => ("404 Not Found", json!({"code":"migration-needed"})),
                }
            }
            "/oauth2/device/code" => {
                assert_eq!(form["client_id"], http::CLIENT_ID);
                assert_eq!(form["referrer"], "grok-build");
                assert!(form["scope"].contains("offline_access"));
                assert_eq!(header("x-grok-client-surface"), Some("ui"));
                assert_eq!(header("x-grok-client-version"), Some("test-1"));
                let id = self.issued.fetch_add(1, Ordering::SeqCst);
                (
                    "200 OK",
                    json!({
                        "device_code":format!("owned-device-{id}"),"expires_in":30,"interval":1,
                        "user_code":"TEST-DEVICE","verification_uri":"https://example.invalid/device",
                        "verification_uri_complete":"https://example.invalid/device?code=fixture"
                    }),
                )
            }
            "/oauth2/token" if form["grant_type"] == "refresh_token" => {
                assert_eq!(form["refresh_token"], "fixture-refresh");
                assert_eq!(form["client_id"], http::CLIENT_ID);
                self.refreshes.fetch_add(1, Ordering::SeqCst);
                (
                    "200 OK",
                    json!({"access_token":"fixture-rotated","refresh_token":"fixture-new-refresh","expires_in":3600}),
                )
            }
            "/oauth2/token" => {
                assert_eq!(
                    form["grant_type"],
                    "urn:ietf:params:oauth:grant-type:device_code"
                );
                assert_eq!(header("x-grok-client-surface"), Some("ui"));
                assert_eq!(form["client_id"], http::CLIENT_ID);
                match form["device_code"].as_str() {
                    "owned-device-0" if self.polls.fetch_add(1, Ordering::SeqCst) == 0 => {
                        ("400 Bad Request", json!({"error":"authorization_pending"}))
                    }
                    "owned-device-0" => (
                        "200 OK",
                        json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}),
                    ),
                    "owned-device-1" => {
                        self.exchange_started.notify_one();
                        self.release_exchange.notified().await;
                        self.exchange_released.notify_one();
                        (
                            "200 OK",
                            json!({"access_token":"fixture-after-logout","expires_in":3600}),
                        )
                    }
                    _ => bail!("Unexpected device request"),
                }
            }
            "/v1/user?include=subscription" => {
                assert!(matches!(
                    header("authorization"),
                    Some("Bearer fixture-access" | "Bearer fixture-rotated")
                ));
                assert_eq!(header("x-xai-token-auth"), Some("xai-grok-cli"));
                assert_eq!(header("x-grok-client-identifier"), Some("cantrip"));
                (
                    "200 OK",
                    json!({"user_id":" fixture-user ","email":" fixture@example.invalid ","subscription_tier":"SuperGrok"}),
                )
            }
            "/v1/billing?format=credits" => {
                assert_eq!(header("x-grok-user-id"), Some("fixture-user"));
                self.billed.fetch_add(1, Ordering::SeqCst);
                if self.billing_failed.load(Ordering::SeqCst) {
                    ("503 Service Unavailable", json!({}))
                } else {
                    ("200 OK", catalog_fixture()["billing"].clone())
                }
            }
            "/v1/models" => {
                self.models.fetch_add(1, Ordering::SeqCst);
                assert_eq!(header("x-grok-user-id"), Some("fixture-user"));
                let bearer = header("authorization");
                assert!(matches!(
                    bearer,
                    Some(
                        "Bearer fixture-access"
                            | "Bearer fixture-rotated"
                            | "Bearer portable-access"
                    )
                ));
                if bearer == Some("Bearer fixture-access")
                    && self.reject_local_model.swap(false, Ordering::SeqCst)
                {
                    ("401 Unauthorized", json!({}))
                } else {
                    ("200 OK", catalog_fixture()["payload"].clone())
                }
            }
            _ => bail!("Unexpected local test route {request}"),
        };
        let output = value.stringify();
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{output}",
            output.len()
        );
        let _ = stream.get_mut().write_all(response.as_bytes()).await;
        Ok(())
    }
}

fn catalog_fixture() -> Value {
    cantrip_wire::parse_json_text(include_str!("fixtures/catalog.json")).unwrap()
}

const WORKER_TOKEN: &str = "ctwk_0000000000000000000000000000000000000000000";

fn catalog_command(kind: &str, account: &str) -> Value {
    json!({"type":kind,"provider":json!({
        "kind":"grok","id":"fixture","name":"fixture","accountId":account,
        "credentialHomeKey":account,"baseUrl":"https://example.invalid"
    })})
}

async fn catalog_service(
    root: &Path,
    endpoint: &url::Url,
) -> Result<(
    catalog::Catalog,
    Arc<crate::encryption::Service>,
    Arc<crate::logging::Logs>,
)> {
    use crate::{
        config,
        encryption::{Identity, Service},
        logging::Logs,
        provider_access::Access,
    };
    let server = endpoint.as_str();
    let worker_id = "worker".into();
    let client = reqwest::Client::new();
    let identity = Identity::open(root, server, &worker_id, false)?;
    let encryption = Service::new(identity, server, client.clone())?;
    let registration = encryption.registration();
    let owner = json!("fixture-owner");
    let stamp = "2026-08-24T00:00:00.000Z";
    let component = "provider-credential";
    let grant = json!({"workerId":worker_id,"keyRevision":1,"component":component});
    let wrapped =
        cantrip_crypto::wrap_component_key(&[23; 32], &registration["publicKey"], &owner, &grant)?;
    encryption.accept_bootstrap(&json!({
        "serverId":uuid::Uuid::new_v4().to_string(),"ownerId":owner,
        "principal":json!({
            "id":registration["principalId"],"ownerId":owner,"workerId":worker_id,
            "kind":"worker","label":Value::Null,"publicKey":registration["publicKey"],
            "state":"approved","revision":1,"approvedAt":stamp,"revokedAt":Value::Null,
            "revokedReason":Value::Null,"createdAt":stamp,"updatedAt":stamp
        }),
        "grants":vec![json!({
            "id":uuid::Uuid::new_v4().to_string(),"ownerId":owner,
            "principalId":registration["principalId"],"component":component,"keyRevision":1,
            "wrappedKey":wrapped,"state":"active","revision":1,"revokedAt":Value::Null,
            "revokedReason":Value::Null,"createdAt":stamp,"updatedAt":stamp
        })]
    }))?;
    let environment = HashMap::from([
        ("CANTRIP_WORKER_ID".into(), "worker".into()),
        ("CANTRIP_WORKER_CREDENTIAL".into(), WORKER_TOKEN.into()),
        (
            "CANTRIP_WORKER_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        ),
        ("CANTRIP_SERVER_URL".into(), server.into()),
    ]);
    let configuration = config::read(
        &environment,
        &config::Host {
            cwd: root,
            worker_root: root,
            platform: "darwin",
            architecture: "arm64",
            hostname: "fixture",
        },
    )?;
    let access = Access::new(
        Arc::new(Mutex::new(configuration)),
        encryption.clone(),
        client,
    );
    let worker = Worker::new(
        Host {
            binary: root.join("unused-codex"),
            cwd: root.into(),
            environment: HashMap::new(),
            compatibility: Value::Null,
            logs: None,
        },
        root.into(),
        worker_id,
        "generation".into(),
        Arc::new(|| Ok(("server".into(), "owner".into()))),
    );
    let auth = Commands::with_http(
        Http::new("test-1".into())?.fixture(endpoint.clone()),
        root.into(),
        worker,
        Observer::new(Arc::new(|_| {})),
    );
    let logs = Arc::new(Logs::initialize(root, &environment, root).await);
    Ok((
        catalog::Catalog::new(auth, access, encryption.clone(), logs.clone()),
        encryption,
        logs,
    ))
}

#[tokio::test]
async fn model_and_quota_commands_use_bound_portable_credentials_and_scoped_fallback() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = url::Url::parse(&format!("http://{}/", listener.local_addr()?))?;
    let fixture = Arc::new(Fixture::default());
    let server = tokio::spawn(fixture.clone().serve(listener));
    let (catalog, encryption, logs) = catalog_service(root.path(), &endpoint).await?;
    let sealed = crate::protected_secrets::protect_provider_credential(
        &encryption,
        &json!("portable"),
        &json!({
            "kind":"grok","version":1,"userId":"fixture-user","accessToken":"portable-access",
            "refreshToken":Value::Null,"expiresAt":Value::Null,"email":Value::Null,"planType":Value::Null
        }),
    )?;
    let record = json!({"accountId":"portable","providerId":"fixture",
        "providerKind":"grok","credentialRevision":4,"credential":sealed["credential"]});
    fixture.records.lock().unwrap().extend([
        ("portable".into(), record.clone()),
        ("mismatched".into(), record),
    ]);
    let oracle = catalog_fixture();
    let result = catalog
        .execute(catalog_command("model.grok.catalog", "portable"))
        .await?;
    assert_eq!(result["models"], oracle["models"]);
    assert_eq!(result["weeklyUsage"], oracle["weekly"]);
    let first = &result["quotaSnapshot"];
    assert_eq!(
        first["windows"].as_array().unwrap()[0]["rawPayload"]["source"],
        "billing-credits"
    );
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.billed.load(Ordering::SeqCst), 1);
    let cached = catalog
        .execute(catalog_command("model.grok.catalog", "portable"))
        .await?;
    assert_eq!(cached["quotaSnapshot"], *first);
    assert_eq!(fixture.billed.load(Ordering::SeqCst), 1);
    let fresh = catalog
        .execute(catalog_command("provider.quota.read", "portable"))
        .await?;
    assert_ne!(fresh["snapshotId"], first["snapshotId"]);
    fixture.billing_failed.store(true, Ordering::SeqCst);
    let retained = catalog
        .execute(catalog_command("provider.quota.read", "portable"))
        .await?;
    assert_eq!(fresh, retained);
    assert_eq!(fixture.billed.load(Ordering::SeqCst), 3);
    fixture.billing_failed.store(false, Ordering::SeqCst);

    let mismatch = catalog
        .execute(catalog_command("model.grok.catalog", "mismatched"))
        .await
        .unwrap_err();
    assert!(mismatch.to_string().contains("identity-conflict"));
    assert_eq!(fixture.models.load(Ordering::SeqCst), 2);
    let empty = catalog
        .execute(catalog_command("provider.quota.read", "legacy"))
        .await?;
    assert_eq!(empty["windows"], json!(Vec::<Value>::new()));
    assert_eq!(fixture.billed.load(Ordering::SeqCst), 3);

    let local = account_home(root.path(), &"legacy".into());
    tokio::fs::create_dir_all(&local).await?;
    tokio::fs::write(
        local.join(FILE),
        json!({
            "version":1,"accessToken":"fixture-access","refreshToken":"fixture-refresh",
            "userId":"fixture-user","expiresAt":Value::Null
        })
        .stringify(),
    )
    .await?;
    fixture.reject_local_model.store(true, Ordering::SeqCst);
    let fallback = catalog
        .execute(catalog_command("model.grok.catalog", "legacy"))
        .await?;
    assert_eq!(fallback["models"], oracle["models"]);
    assert_eq!(fallback["weeklyUsage"], oracle["weekly"]);
    assert_eq!(
        fallback["quotaSnapshot"]["windows"].as_array().unwrap()[0]["rawPayload"],
        json!({"source":"legacy-grok-usage"})
    );
    assert_eq!(fixture.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.models.load(Ordering::SeqCst), 4);
    assert_eq!(
        crate::provider_credentials::read(&local.join(FILE)).await?["accessToken"],
        "fixture-rotated"
    );
    encryption.close().await?;
    logs.close().await;
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    Ok(())
}

fn command(kind: &str, id: &str, observation: &str) -> Value {
    json!({
        "type":kind,"providerId":"fixture","providerKind":"grok",
        "providerAccountId":id,"credentialHomeKey":id,"observationId":observation
    })
}

async fn observed(events: &mut mpsc::UnboundedReceiver<Value>, id: &str, phase: &str) -> Value {
    loop {
        let note = events.recv().await.unwrap();
        if note["observationId"] == id && note["status"]["state"] == phase {
            return note;
        }
    }
}

#[tokio::test]
async fn oauth_persists_and_reopens_credentials_and_fences_late_exchanges() -> Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(12), async {
        let root = tempfile::tempdir()?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = url::Url::parse(&format!("http://{}/", listener.local_addr()?))?;
        let fixture = Arc::new(Fixture::default());
        let server = tokio::spawn(fixture.clone().serve(listener));
        let worker = Worker::new(
            Host {
                binary: root.path().join("unused-codex"),
                cwd: root.path().into(),
                environment: HashMap::new(),
                compatibility: Value::Null,
                logs: None,
            },
            root.path().into(),
            "worker".into(),
            "generation".into(),
            Arc::new(|| Ok(("server".into(), "owner".into()))),
        );
        let (send, mut events) = mpsc::unbounded_channel();
        let observer = Observer::new(Arc::new(move |notification| {
            let parsed = checked(
                "workerServerEnvelopeSchema",
                &json!({"kind":"notification","notification":notification}),
            )
            .unwrap();
            let _ = send.send(parsed["notification"].clone());
        }));
        let auth = Commands::with_http(
            Http::new("test-1".into())?.fixture(endpoint),
            root.path().into(),
            worker,
            observer.clone(),
        );
        let active = uuid::Uuid::new_v4().to_string();
        let receipt = auth.execute(command(LOGIN, "first", &active)).await?;
        assert_eq!(receipt["userCode"], "TEST-DEVICE");
        assert_eq!(
            receipt["verificationUrl"],
            "https://example.invalid/device?code=fixture"
        );
        assert_eq!(
            observed(&mut events, &active, "pending").await["sequence"],
            json!(1)
        );
        let note = observed(&mut events, &active, "authenticated").await;
        assert_eq!(note["sequence"], json!(2));
        assert_eq!(note["status"]["planType"], "SuperGrok");
        assert_eq!(note["status"]["email"], "fixture@example.invalid");
        assert_eq!(
            note["status"]["weeklyUsage"],
            json!({"usedPercent":0,"resetsAt":1_787_529_600})
        );
        assert!(!note.stringify().contains("fixture-access"));
        assert_eq!(fixture.polls.load(Ordering::SeqCst), 2);
        let home = account_home(root.path(), &"first".into());
        let path = home.join(FILE);
        let mut stored = crate::provider_credentials::read(&path).await?;
        assert_eq!(stored["userId"], "fixture-user");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                tokio::fs::metadata(&path).await?.permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            auth.execute(command(STATUS, "first", &active)).await?["authenticated"],
            true
        );
        assert_eq!(fixture.billed.load(Ordering::SeqCst), 1);
        {
            let _guard = auth.0.codex.lock_account_home(&home).await;
            auth.retire(&home, false).await?;
        }
        stored["expiresAt"] = json!(1);
        tokio::fs::write(&path, stored.stringify()).await?;
        assert_eq!(
            auth.execute(command(STATUS, "first", &active)).await?["authenticated"],
            true
        );
        assert_eq!(fixture.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            crate::provider_credentials::read(&path).await?["refreshToken"],
            "fixture-new-refresh"
        );

        let pending = uuid::Uuid::new_v4().to_string();
        auth.execute(command(LOGIN, "second", &pending)).await?;
        fixture.exchange_started.notified().await;
        assert_eq!(
            auth.execute(command(LOGOUT, "second", &pending)).await?["accepted"],
            true
        );
        let cancelled = observed(&mut events, &pending, "cancelled").await;
        assert_eq!(
            cancelled["status"]["failureCode"],
            "authorization-cancelled"
        );
        fixture.release_exchange.notify_one();
        fixture.exchange_released.notified().await;
        let signed_out = auth.execute(command(STATUS, "second", &pending)).await?;
        assert_eq!(signed_out["authenticated"], false);
        assert_eq!(signed_out["loginPending"], false);
        let discarded = account_home(root.path(), &"second".into()).join(FILE);
        assert!(!tokio::fs::try_exists(&discarded).await?);
        assert!(tokio::fs::try_exists(&path).await?);
        let tasks = observer.stop();
        auth.close().await?;
        for task in tasks {
            task.await?;
        }
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        Ok::<_, anyhow::Error>(())
    })
    .await?
}
