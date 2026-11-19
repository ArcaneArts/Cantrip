use super::{
    Service,
    network::{Resource, USER_AGENT, normalize},
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use cantrip_browser::{Browser, Client, Event, Page, Subscription};
use cantrip_wire::{JsString, Value, value::json};
use reqwest::{
    Method,
    header::{self, HeaderMap, HeaderName, HeaderValue},
};
use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, oneshot},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use url::Url;

const DEADLINE: Duration = Duration::from_secs(30);
const PENDING: usize = 32;
const MAX_HTML: usize = 10_000_000;
const ISOLATE_SERVICES: &str = r#"(() => {
    Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined });
    for (const api of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'WebTransport', 'EventSource']) {
        Object.defineProperty(globalThis, api, { value: undefined });
    }
})()"#;

pub(super) struct Rendered {
    pub url: Url,
    pub html: String,
    pub title: String,
}

struct DenyProxy(JoinHandle<()>);

impl DenyProxy {
    async fn start() -> Result<(Self, std::net::SocketAddrV4)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let SocketAddr::V4(address) = listener.local_addr()? else {
            unreachable!()
        };
        // Keep the port reserved and close outside-policy connections without
        // opening any sockets on their behalf.
        let task = tokio::spawn(async move {
            while let Ok((connection, _)) = listener.accept().await {
                drop(connection);
            }
        });
        Ok((Self(task), address))
    }
}

impl Drop for DenyProxy {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) async fn managed(
    service: Arc<Service>,
    manager: Arc<crate::managed_web::Manager>,
    url: Url,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Rendered> {
    let mut stopped = manager.stopped();
    let _pending = service
        .render_requests
        .try_acquire()
        .context("Browser runtime is busy. Try again when another read finishes.")?;
    let _slot = tokio::select! {
        _ = &mut cancelled => bail!("Rendered read cancelled."),
        _ = stopped.wait_for(|value| *value) => bail!("Managed Chromium is shutting down."),
        result = service.render_slots.acquire() => result?,
    };
    let (_deny_proxy, address) = DenyProxy::start().await?;
    manager
        .with_browser(address, async |browser| {
            tokio::select! {
                _ = &mut cancelled => bail!("Rendered read cancelled."),
                _ = stopped.wait_for(|value| *value) => bail!("Managed Chromium is shutting down."),
                outcome = timeout(DEADLINE, read(browser, service.clone(), url)) => {
                    outcome.context("Rendered reading timed out.")?
                }
            }
        })
        .await
}

async fn read(browser: &Browser, service: Arc<Service>, url: Url) -> Result<Rendered> {
    let context = browser.new_context().await?;
    browser
        .client()
        .request(
            "Browser.setDownloadBehavior",
            json!({"behavior":"deny","browserContextId":context}),
            None,
        )
        .await?;
    let page = browser.new_page(Some(&context)).await?;
    let client = browser.client().clone();
    let mut requests = client.subscribe_all();
    let mut lifecycle = page.subscribe();
    page.request("Page.enable", json!({})).await?;
    page.request("Page.setLifecycleEventsEnabled", json!({"enabled":true}))
        .await?;
    let tree = page.request("Page.getFrameTree", json!({})).await?;
    let frame = tree["frameTree"]["frame"]["id"]
        .as_js_string()
        .context("Chromium did not identify the web document frame.")?
        .clone();
    enable(&client, page.session(), true).await?;

    let policy = Arc::new(Policy {
        client,
        service,
        frame,
        main_session: page.session().clone(),
        failures: Mutex::new(None),
        replies: Semaphore::new(1),
    });
    let main = async {
        let navigation = page
            .request("Page.navigate", json!({"url": url.as_str()}))
            .await?;
        if navigation.get("errorText").is_some() {
            let failure = policy.failures.lock().unwrap().take();
            bail!(failure.unwrap_or_else(|| "Chromium could not load the document.".to_owned()));
        }
        let loader = navigation["loaderId"]
            .as_js_string()
            .context("Chromium did not start document navigation.")?;
        loaded(&mut lifecycle, loader, &policy.frame).await?;
        snapshot(&page).await
    };
    let result = tokio::select! {
        result = main => result,
        stopped = serve(policy.clone(), &mut requests) => {
            stopped?;
            bail!("Chromium stopped handling browser requests.")
        }
    };
    // This process belongs to a single read. Closing the browser also
    // disposes any paused child targets and the private context.
    result
}

async fn loaded(events: &mut Subscription, loader: &JsString, frame: &JsString) -> Result<()> {
    loop {
        let event = events.next().await?;
        if event.method() == "Page.lifecycleEvent"
            && event.params()["name"] == "DOMContentLoaded"
            && event.params()["loaderId"].as_js_string() == Some(loader)
            && event.params()["frameId"].as_js_string() == Some(frame)
        {
            return Ok(());
        }
    }
}

async fn snapshot(page: &Page) -> Result<Rendered> {
    let tree = page.request("Page.getFrameTree", json!({})).await?;
    let frame = &tree["frameTree"]["frame"];
    let world = page
        .request(
            "Page.createIsolatedWorld",
            json!({
                "frameId":frame["id"], "worldName":"cantrip-web-read"
            }),
        )
        .await?;
    let context = world["executionContextId"]
        .as_u64()
        .context("Chromium did not create a document snapshot context.")?;
    let expression = format!(
        r#"(() => {{
        const html = document.documentElement?.outerHTML ?? '';
        if (html.length > {MAX_HTML} || new TextEncoder().encode(html).byteLength > {MAX_HTML}) return null;
        return {{ html, title: document.title.slice(0, 1000), url: document.URL }};
    }})()"#
    );
    let value = page.evaluate_in(&expression, Some(context)).await?;
    let html = value["html"]
        .as_str()
        .context("Rendered page exceeds the browser output limit.")?;
    ensure!(
        html.len() <= MAX_HTML,
        "Rendered page exceeds the browser output limit."
    );
    Ok(Rendered {
        html: html.to_owned(),
        title: value["title"]
            .as_js_string()
            .map_or_else(String::new, |title| title.lossy().into_owned()),
        url: normalize(Url::parse(
            value["url"]
                .as_str()
                .context("The rendered document has no URL.")?,
        )?)?,
    })
}

async fn enable(client: &Client, session: &JsString, document: bool) -> Result<()> {
    if document {
        client
            .request(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":ISOLATE_SERVICES}),
                Some(session),
            )
            .await?;
        client
            .request(
                "Network.setBypassServiceWorker",
                json!({"bypass":true}),
                Some(session),
            )
            .await?;
    }
    client
        .request(
            "Network.setUserAgentOverride",
            json!({"userAgent":USER_AGENT}),
            Some(session),
        )
        .await?;
    client
        .request(
            "Fetch.enable",
            json!({"patterns":vec![json!({"urlPattern":"*","requestStage":"Request"})]}),
            Some(session),
        )
        .await?;
    client
        .request(
            "Target.setAutoAttach",
            json!({
                "autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,
            }),
            Some(session),
        )
        .await?;
    Ok(())
}

struct Policy {
    client: Client,
    service: Arc<Service>,
    frame: JsString,
    main_session: JsString,
    failures: Mutex<Option<String>>,
    replies: Semaphore,
}

async fn serve(policy: Arc<Policy>, events: &mut Subscription) -> Result<()> {
    let mut requests = JoinSet::new();
    let mut sessions = HashSet::from([policy.main_session.clone()]);
    loop {
        tokio::select! {
            completed = requests.join_next(), if !requests.is_empty() => {
                if let Some(result) = completed {
                    result??;
                }
            }
            event = events.next() => {
                let event = event?;
                let Some(session) = event.session_id().filter(|session| sessions.contains(*session)).cloned() else { continue };
                match event.method() {
                    "Fetch.requestPaused" => {
                        if requests.len() >= PENDING {
                            policy.reject(&session, &event.params()["requestId"]).await;
                            continue;
                        }
                        let policy = policy.clone();
                        requests.spawn(async move { policy.handle(session, event).await });
                    }
                    "Target.attachedToTarget" => {
                        let Some(child) = event.params()["sessionId"].as_js_string() else { continue };
                        let kind = event.params()["targetInfo"]["type"].as_str();
                        // Only related frames and dedicated workers can fetch.
                        // Leave service workers and popups stopped.
                        if !matches!(kind, Some("iframe" | "worker")) {
                            continue;
                        }
                        enable(&policy.client, child, kind == Some("iframe")).await?;
                        sessions.insert(child.clone());
                        policy.client.request("Runtime.runIfWaitingForDebugger", json!({}), Some(child)).await?;
                    }
                    "Target.detachedFromTarget" => {
                        if let Some(child) = event.params()["sessionId"].as_js_string() {
                            sessions.remove(child);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

impl Policy {
    async fn handle(&self, session: JsString, event: Event) -> Result<()> {
        let request = event.params();
        let id = &request["requestId"];
        let main = request["resourceType"] == "Document"
            && request["frameId"].as_js_string() == Some(&self.frame);
        // Keep the bounded response in its slot until Chromium consumes it.
        let _asset = self.service.render_assets.acquire().await?;
        let result = self.fetch(request).await;
        match result {
            Ok(resource) => {
                let _reply = self.replies.acquire().await?;
                let payload = fulfillment(id, resource)?;
                let result = self
                    .client
                    .request("Fetch.fulfillRequest", payload, Some(&session))
                    .await;
                if main {
                    result?;
                }
            }
            Err(error) => {
                if main {
                    *self.failures.lock().unwrap() = Some(error.to_string());
                }
                self.reject(&session, id).await;
            }
        }
        Ok(())
    }

    async fn fetch(&self, paused: &Value) -> Result<Resource> {
        let request = &paused["request"];
        let url = normalize(Url::parse(
            request["url"]
                .as_str()
                .context("Browser request has no URL.")?,
        )?)?;
        let method = match request["method"].as_str() {
            Some("GET") => Method::GET,
            Some("HEAD") => Method::HEAD,
            _ => bail!("Rendered reading allows only GET and HEAD."),
        };
        ensure!(
            !matches!(
                paused["resourceType"].as_str(),
                Some("WebSocket" | "EventSource")
            ),
            "Rendered reading does not open persistent connections."
        );
        if paused["resourceType"] == "Document" {
            self.service
                .robots
                .check(&self.service.network, &url)
                .await?;
        }
        let mut headers = HeaderMap::new();
        if let Some(source) = request["headers"].as_object() {
            for (key, value) in source {
                let (Some(key), Some(value)) = (key.as_str(), value.as_str()) else {
                    continue;
                };
                let Ok(key) = HeaderName::try_from(key) else {
                    continue;
                };
                if !hop_header(&key)
                    && !matches!(
                        key,
                        header::HOST | header::CONTENT_LENGTH | header::ACCEPT_ENCODING
                    )
                    && let Ok(value) = HeaderValue::from_str(value)
                {
                    headers.append(key, value);
                }
            }
        }
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
        self.service.network.resource(url, method, headers).await
    }

    async fn reject(&self, session: &JsString, id: &Value) {
        let _ = self
            .client
            .request(
                "Fetch.failRequest",
                json!({"requestId":id,"errorReason":"BlockedByClient"}),
                Some(session),
            )
            .await;
    }
}

fn hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn fulfillment(id: &Value, resource: Resource) -> Result<Value> {
    let extra: HashSet<&str> = resource
        .headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(',').map(str::trim))
        .collect();
    let mut headers = Vec::new();
    for (name, value) in &resource.headers {
        if hop_header(name)
            || extra
                .iter()
                .any(|key| name.as_str().eq_ignore_ascii_case(key))
            || (!resource.is_head
                && matches!(*name, header::CONTENT_ENCODING | header::CONTENT_LENGTH))
        {
            continue;
        }
        // DevTools' binary form preserves repeated fields and non-UTF-8 bytes.
        headers.extend_from_slice(name.as_str().as_bytes());
        headers.extend_from_slice(b": ");
        headers.extend_from_slice(value.as_bytes());
        headers.push(0);
    }
    ensure!(
        headers.len() <= 256 * 1024,
        "Browser resource exceeded the header limit."
    );
    let body = STANDARD.encode(resource.body);
    Ok(json!({
        "requestId":id,"responseCode":resource.status,
        "binaryResponseHeaders": STANDARD.encode(headers),"body":body
    }))
}
