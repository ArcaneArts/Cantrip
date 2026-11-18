use super::*;
use crate::codex::managed::Host;
use std::sync::atomic::{AtomicUsize, Ordering};
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
                (
                    "200 OK",
                    json!({"config":json!({"currentPeriod":json!({
                        "type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-08-24T00:00:00.000Z"
                    })})}),
                )
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
