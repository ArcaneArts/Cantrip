use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::VerifyingKey;
use std::{fs, path::PathBuf, sync::Arc};
use tokio::time::timeout;

#[test]
fn archive_entries_must_remain_inside_staging() {
    for name in [
        "../file",
        "/etc/file",
        "a/./file",
        "a//file",
        "C:/file",
        "a\\file",
        "a\0b",
    ] {
        assert!(archive::relative(name).is_err(), "{name}");
    }
    assert!(archive::relative("config/virtual-host.conf:socket").is_ok() == !cfg!(windows));
    assert_eq!(
        archive::relative("browsers/chrome-headless-shell").unwrap(),
        PathBuf::from("browsers").join("chrome-headless-shell")
    );
}

#[tokio::test]
#[ignore = "run with scripts/worker-rust/managed-chromium-smoke.mjs"]
async fn signed_release_install_update_and_failure() -> Result<()> {
    let base = std::env::var("CANTRIP_TEST_CHROMIUM_MANIFEST")?;
    let certificate = fs::read(std::env::var_os("CANTRIP_TEST_CHROMIUM_CERTIFICATE").unwrap())?;
    let key = STANDARD.decode(std::env::var("CANTRIP_TEST_CHROMIUM_KEY")?)?;
    let data = tempfile::tempdir()?;
    let source = Source {
        client: source::client()?
            .add_root_certificate(reqwest::Certificate::from_pem(&certificate)?)
            .build()?,
        manifest: format!("{base}/first"),
        key_id: "fixture-ed25519".into(),
        key: VerifyingKey::from_bytes(key.as_slice().try_into()?)?,
    };
    let mut manager = Manager::new(data.path(), source, Component::Chromium);
    let logs = Logs::initialize(data.path(), &Environment::default(), data.path()).await;
    let action = |name| json!({"component":"playwright","action":name});
    let first = manager.action(&action("check-update"), &logs).await?;
    assert_eq!(first["status"]["state"], "ready", "{}", first.stringify());
    assert_eq!(first["status"]["installedVersion"], "fixture-1");
    let pointer = manager.storage.root.join("current.json");
    let original = fs::read(&pointer)?;
    let existing = manager.action(&action("check-update"), &logs).await?;
    assert_eq!(existing["status"]["state"], "ready");
    assert_eq!(fs::read(&pointer)?, original);
    let installed = manager.action(&action("reinstall"), &logs).await?;
    assert_eq!(
        installed["status"]["state"],
        "ready",
        "{}",
        installed.stringify()
    );
    let original = fs::read(&pointer)?;
    for (route, category) in [
        ("unsigned", "signature"),
        ("wrong-digest", "integrity"),
        ("unhealthy", "health-check"),
        ("duplicate", "integrity"),
    ] {
        manager.source.manifest = format!("{base}/{route}");
        let rejected = manager.action(&action("check-update"), &logs).await?;
        assert_eq!(
            rejected["status"]["state"],
            "degraded",
            "{}",
            rejected.stringify()
        );
        assert_eq!(
            rejected["status"]["failure"]["category"],
            category,
            "{}",
            rejected.stringify()
        );
        assert_eq!(fs::read(&pointer)?, original);
        assert!(
            fs::read_dir(manager.storage.root.join("staging"))?
                .next()
                .is_none()
        );
    }
    manager.source.manifest = format!("{base}/second");
    let updated = manager.action(&action("check-update"), &logs).await?;
    assert_eq!(
        updated["status"]["installedVersion"],
        "fixture-2",
        "{}",
        updated.stringify()
    );
    assert_eq!(updated["status"]["previousVersion"], "fixture-1");
    let profiles = manager.storage.root.join("state/profiles");
    fs::create_dir_all(&profiles)?;
    fs::write(profiles.join("owned-test-marker"), b"fixture")?;
    manager.action(&action("clear-profiles"), &logs).await?;
    assert!(fs::read_dir(profiles)?.next().is_none());
    let cleared = manager.action(&action("clear-cache"), &logs).await?;
    assert_eq!(cleared["status"]["installedVersion"], "fixture-2");
    crate::web::session::test_visible(&manager).await?;
    rendered_read(Arc::new(manager), data.path()).await?;
    logs.close().await;
    Ok(())
}

async fn rendered_read(manager: Arc<Manager>, data: &Path) -> Result<()> {
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
    use hyper_util::rt::TokioIo;
    use std::{convert::Infallible, net::Ipv4Addr};
    use tokio::net::TcpListener;

    type Observed = Arc<Mutex<Vec<(String, String, String, Option<String>)>>>;
    let log: Observed = Arc::default();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    let service = crate::web::Service::with_fixture(Some(manager.clone()), None, address);
    let stalled = Arc::new(tokio::sync::Notify::new());
    let fixture = tokio::spawn({
        let log = log.clone();
        let stalled = stalled.clone();
        async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = clients.join_next(), if !clients.is_empty() => {}
                    next = listener.accept() => {
                        let Ok((socket, _)) = next else { break; };
                        let log = log.clone();
                        let stalled = stalled.clone();
                        clients.spawn(async move {
                            let _ = http1::Builder::new().serve_connection(TokioIo::new(socket),
                                service_fn(move |request: Request<Incoming>| {
                                    let log = log.clone();
                                    let stalled = stalled.clone();
                                    async move {
                                        let path = request.uri().path();
                                        let host = request.headers()[hyper::header::HOST].to_str().unwrap();
                                        let cookie = request.headers().get(hyper::header::COOKIE)
                                            .and_then(|value| value.to_str().ok()).map(str::to_owned);
                                        log.lock().unwrap().push((host.into(), path.into(), request.method().to_string(), cookie));
                                        if path == "/stalled" {
                                            stalled.notify_one();
                                            return std::future::pending::<Result<Response<Full<Bytes>>, Infallible>>().await;
                                        }
                                        let mut reply = Response::builder();
                                        if path == "/submitted" {
                                            let method = request.method().clone();
                                            let bytes = request.into_body().collect().await.unwrap().to_bytes();
                                            assert_eq!(method, hyper::Method::POST);
                                            assert_eq!(bytes.as_ref(), b"value=Rust+browser");
                                            return Ok::<_, Infallible>(reply.header(hyper::header::CONTENT_TYPE, "text/html")
                                                .body(Full::new(Bytes::from_static(b"<title>Submitted</title><h1>Form received</h1>"))).unwrap());
                                        }
                                        let (content_type, body) = match path {
                                            "/robots.txt" => ("text/plain", "User-agent: CantripResearchBot\nDisallow: /denied"),
                                            "/start" => {
                                                reply = reply.status(302).header(hyper::header::LOCATION, "http://page.example/dynamic");
                                                ("text/plain", "")
                                            }
                                            "/blocked" => {
                                                reply = reply.status(302).header(hyper::header::LOCATION, "http://page.example/denied");
                                                ("text/plain", "")
                                            }
                                            "/dynamic" => {
                                                reply = reply.header(hyper::header::SET_COOKIE, "fixture=rendered; Path=/; HttpOnly");
                                                ("text/html", r#"<html><head><title>Dynamic fixture</title></head><body><article><p id="body">tiny</p></article><script src="/populate.js"></script></body></html>"#)
                                            }
                                            "/populate.js" => ("application/javascript", r#"
                                                for (const [method, address] of [
                                                  ['POST', '/write'],
                                                  ['GET', 'http://FIXTURE_ADDRESS/private'],
                                                  ['GET', '/persistent'],
                                                ]) {
                                                  try {
                                                    const request = new XMLHttpRequest();
                                                    request.open(method, address, false);
                                                    request.send();
                                                  } catch {}
                                                }
                                                document.getElementById('body').textContent =
                                                  'Chromium executed the page script before taking the rendered snapshot. '.repeat(5);
                                            "#),
                                            "/session" => ("text/html", r#"<title>Session test</title>
                                              <h1>Private research</h1>
                                              <button onclick="alert('fixture dialog');sessionStorage.setItem('changed','yes');this.textContent='Clicked'">Change text</button>
                                              <form method="post" action="/submitted"><label>Search value <input name="value"></label></form>
                                            "#),
                                            "/session-next" => ("text/html", r#"<title>Second page</title><h1 id="status">Fresh</h1>
                                              <script>if(sessionStorage.getItem('changed')) document.querySelector('h1').textContent = 'Resumed'</script>
                                            "#),
                                            "/persistent" => ("text/event-stream", "data: fixture\n\n"),
                                            _ => ("text/plain", "unexpected"),
                                        };
                                        Ok::<_, Infallible>(reply.header(hyper::header::CONTENT_TYPE, content_type)
                                            .body(Full::new(Bytes::from(body.replace("FIXTURE_ADDRESS", &address.to_string())))).unwrap())
                                    }
                                })
                            ).await;
                        });
                    }
                }
            }
        }
    });
    let result = async {
        let binding = json!({"ownerId":"owner","chatId":"chat"});
        for (url, render) in [
            ("http://docs.example/start", "always"),
            ("http://page.example/dynamic", "auto"),
        ] {
            let result = service
                .read(&binding, Some(&json!({"url":url,"render":render})))
                .await?;
            assert_eq!(result["data"]["method"], "rendered");
            assert_eq!(result["data"]["url"], "http://page.example/dynamic");
            assert_eq!(result["data"]["title"], "Dynamic fixture");
            assert_eq!(
                result["data"]["content"],
                "Chromium executed the page script before taking the rendered snapshot. "
                    .repeat(5)
                    .trim()
            );
        }
        let error = service
            .read(
                &binding,
                Some(&json!({"url":"http://docs.example/blocked","render":"always"})),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("robots policy"), "{error:?}");
        {
            let log = log.lock().unwrap();
            assert!(
                log.iter()
                    .any(|(host, path, method, _)| host == "page.example"
                        && path == "/populate.js"
                        && method == "GET")
            );
            assert!(
                !log.iter().any(|(_, path, _, _)| matches!(
                    path.as_str(),
                    "/denied" | "/write" | "/private"
                ))
            );
            assert!(
                log.iter()
                    .filter(|(_, path, _, _)| path == "/populate.js")
                    .all(|(_, _, _, cookie)| cookie.as_deref() == Some("fixture=rendered")),
                "Browser subresource requests did not retain the document cookie: {log:?}"
            );
        }
        interactive_session(&service, &manager, &stalled, data).await?;
        let waiting = tokio::spawn(async move {
            service
                .read(
                    &binding,
                    Some(&json!({"url":"http://docs.example/stalled","render":"always"})),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), stalled.notified()).await?;
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        let _drained =
            tokio::time::timeout(Duration::from_secs(8), manager.active_version.write()).await?;
        assert!(
            fs::read_dir(data.join("managed-runtimes/playwright/staging"))?.all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("render-"))
        );
        Ok(())
    }
    .await;
    fixture.abort();
    result
}

#[tokio::test]
#[ignore = "downloads the pinned signed SearXNG release and runs its offline probe"]
async fn published_searxng_release_runs_its_offline_probe() -> Result<()> {
    let data = tempfile::tempdir()?;
    let logs = Logs::initialize(data.path(), &Environment::default(), data.path()).await;
    let installer = Manager::new(
        data.path(),
        Source::configured(source::MANIFEST.into())?,
        Component::Searxng,
    );
    let search = Search::new(installer, None)?;
    let result = search
        .action(
            &json!({"component":"searxng","action":"check-update"}),
            &logs,
        )
        .await?;
    ensure!(
        result["status"]["state"] == "ready" && result["status"]["component"] == "searxng",
        "Published SearXNG runtime did not start. {}",
        result.stringify(),
    );
    search.stop();
    search.run(&logs).await?;
    logs.close().await;
    Ok(())
}

async fn interactive_session(
    service: &Arc<crate::web::Service>,
    manager: &Arc<Manager>,
    stalled: &Arc<tokio::sync::Notify>,
    data: &Path,
) -> Result<()> {
    let (lane, live) = tokio::sync::watch::channel(false);
    let binding = json!({
        "ownerId":"owner", "chatId":"research", "contextKind":"project", "permissionProfileId":":workspace",
    });
    let call = |operation: &'static str, args: Value| {
        let binding = binding.clone();
        let live = live.clone();
        async move {
            service
                .session(operation, &binding, Some(&args), live)
                .await
        }
    };
    let open = call(
        "web.session.open",
        json!({"url":"http://page.example/session"}),
    )
    .await?;
    let id = open["data"]["sessionId"].as_str().unwrap();
    assert_eq!(open["data"]["generation"], 1);
    assert_eq!(open["data"]["title"], "Session test");
    assert_eq!(open["data"]["persistent"], false);

    for change in [("chatId", "other"), ("permissionProfileId", ":read-only")] {
        let mut denied = binding.clone();
        denied[change.0] = json!(change.1);
        assert!(
            service
                .session(
                    "web.session.snapshot",
                    &denied,
                    Some(&json!({"sessionId":id})),
                    live.clone()
                )
                .await
                .is_err()
        );
    }
    let snapshot = call("web.session.snapshot", json!({"sessionId":id})).await?;
    let elements = snapshot["data"]["elements"].as_array().unwrap();
    assert!(
        snapshot["data"]["snapshot"]
            .as_str()
            .unwrap()
            .contains("heading \"Private research\"")
    );
    let button = elements
        .iter()
        .find(|item| {
            item["description"]
                .as_str()
                .unwrap()
                .contains("Change text")
        })
        .context("No accessible button in the session snapshot.")?;
    let click = json!({"sessionId":id,"elementRef":button["ref"]});
    let clicked = call("web.session.click", click.clone()).await?;
    assert_eq!(clicked["data"]["generation"], 2);
    assert!(
        call("web.session.click", click)
            .await
            .unwrap_err()
            .to_string()
            .contains("stale")
    );
    let resumed = call(
        "web.session.open",
        json!({"sessionId":id,"url":"http://page.example/session-next"}),
    )
    .await?;
    assert_eq!(resumed["data"]["generation"], 3);
    let previous = call("web.session.snapshot", json!({"sessionId":id})).await?;
    assert!(
        previous["data"]["snapshot"]
            .as_str()
            .unwrap()
            .contains("Resumed")
    );

    let second = call(
        "web.session.open",
        json!({"url":"http://page.example/session-next"}),
    )
    .await?;
    let second_id = second["data"]["sessionId"].as_str().unwrap();
    let fresh = call("web.session.snapshot", json!({"sessionId":second_id})).await?;
    assert!(
        fresh["data"]["snapshot"]
            .as_str()
            .unwrap()
            .contains("Fresh")
    );
    assert!(
        call("web.session.close", json!({"sessionId":second_id})).await?["data"]["closed"] == true
    );

    call(
        "web.session.open",
        json!({"sessionId":id,"url":"http://page.example/session"}),
    )
    .await?;
    let form = call("web.session.snapshot", json!({"sessionId":id})).await?;
    let input = form["data"]["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| {
            item["description"]
                .as_str()
                .unwrap()
                .contains("Search value")
        })
        .context("No accessible input in the session snapshot.")?;
    let typed = call(
        "web.session.type",
        json!({
            "sessionId":id,"elementRef":input["ref"],"text":"Rust browser","submit":true,
        }),
    )
    .await?;
    assert_eq!(typed["data"]["url"], "http://page.example/submitted");
    let result = call("web.session.snapshot", json!({"sessionId":id})).await?;
    assert!(
        result["data"]["snapshot"]
            .as_str()
            .unwrap()
            .contains("Form received")
    );

    let waiting = call(
        "web.session.open",
        json!({"sessionId":id,"url":"http://page.example/stalled"}),
    );
    let revoke = async {
        timeout(Duration::from_secs(5), stalled.notified()).await?;
        lane.send_replace(true);
        Ok::<_, anyhow::Error>(())
    };
    let (cancelled, revoke) = tokio::join!(waiting, revoke);
    revoke?;
    assert!(
        cancelled
            .unwrap_err()
            .to_string()
            .contains("stopped with its agent turn")
    );
    let _drained = timeout(Duration::from_secs(8), manager.sessions.write()).await?;
    assert!(
        fs::read_dir(data.join("managed-runtimes/playwright/staging"))?.all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("session-"))
    );
    Ok(())
}
