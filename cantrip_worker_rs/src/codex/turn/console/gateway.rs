//! A loopback capability connects a terminal view to its native app-server
//! subscription. Attaching and detaching get Core receipts before dispatch.
use super::{Scope, View, prompt, queue};
use crate::{
    codex::turn::receipt::Receipt,
    metadata::{Abort, Signal},
};
use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_history::projection::Work;
use cantrip_wire::{Value, parse_json_text, value::json};
use futures::{SinkExt, StreamExt, stream::FuturesUnordered};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    task::{JoinHandle, JoinSet},
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config, connect_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        protocol::WebSocketConfig,
    },
};

const SOCKET_LIMIT: usize = 32 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Gateway {
    pub(super) url: String,
    stop: watch::Sender<bool>,
    stopped: watch::Receiver<bool>,
    task: Option<JoinHandle<()>>,
}

impl Gateway {
    pub(super) async fn start(view: Arc<View>) -> Result<Self> {
        view.assert_current()?;
        let loopback = TcpListener::bind("127.0.0.1:0").await?;
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret)
            .map_err(|_| anyhow::anyhow!("Could not generate a console credential."))?;
        let capability = Arc::new(format!("/managed/{}", URL_SAFE_NO_PAD.encode(secret)));
        let url = format!("ws://{}{}", loopback.local_addr()?, capability);
        let (stop, stopping) = watch::channel(false);
        let (finished, stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            serve(loopback, capability, view, stopping).await;
            finished.send_replace(true);
        });
        Ok(Self {
            url,
            stop,
            stopped,
            task: Some(task),
        })
    }

    pub(crate) fn stopped(&self) -> watch::Receiver<bool> {
        self.stopped.clone()
    }

    pub(crate) async fn close(mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

async fn serve(
    listener: TcpListener,
    path: Arc<String>,
    view: Arc<View>,
    mut stopping: watch::Receiver<bool>,
) {
    let mut connections = JoinSet::new();
    let (disconnect, disconnected) = watch::channel(false);
    let mut poll = tokio::time::interval(Duration::from_millis(250));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let runtime_exit = view.prepared.runtime.retired();
    tokio::pin!(runtime_exit);
    loop {
        tokio::select! {
            biased;
            _ = stopping.changed() => break,
            _ = &mut runtime_exit => break,
            _ = poll.tick() => {
                if view.assert_current().is_err() { break; }
            }
            _ = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept(), if connections.len() < 16 => {
                let Ok((socket, _)) = accepted else { break; };
                let view = view.clone();
                let path = path.clone();
                let stop = disconnected.clone();
                connections.spawn(async move { let _ = attach(socket, path, &view, stop).await; });
            }
        }
    }
    drop(listener);
    // Retire existing view connections while their exact pending attachment
    // receipts can still settle. The app-server may outlive its console view.
    disconnect.send_replace(true);
    let drained = tokio::time::timeout(Duration::from_secs(15), async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        connections.shutdown().await;
    }
}

fn limits() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(SOCKET_LIMIT))
        .max_frame_size(Some(SOCKET_LIMIT))
}

async fn attach(
    socket: TcpStream,
    path: Arc<String>,
    view: &Arc<View>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let handshake = accept_hdr_async_with_config(
        socket,
        |request: &Request, response: Response| {
            let target = request
                .uri()
                .path_and_query()
                .map(|part| part.as_str())
                .unwrap_or_default();
            if request.headers().contains_key("origin")
                || !bool::from(target.as_bytes().ct_eq(path.as_bytes()))
                || view.assert_current().is_err()
            {
                let mut error = ErrorResponse::new(None);
                *error.status_mut() = hyper::StatusCode::UNAUTHORIZED;
                return Err(error);
            }
            Ok(response)
        },
        Some(limits()),
    );
    let mut client = tokio::time::timeout(IO_TIMEOUT, handshake).await??;
    let endpoint = view.prepared.runtime.endpoint()?;
    let (mut core, _) = tokio::time::timeout(
        IO_TIMEOUT,
        connect_async_with_config(endpoint, Some(limits()), true),
    )
    .await??;
    let mut session = view.session.clone();
    session["connectionId"] = json!(uuid::Uuid::new_v4().to_string());
    let mut pending = HashMap::<String, Pending<'_>>::new();
    let (closed, open) = Abort::new();
    let result = relay(
        &mut client,
        &mut core,
        view,
        &session,
        &mut pending,
        &mut stop,
        open,
    )
    .await;
    closed.abort(anyhow::anyhow!("The console view closed before dispatch."));
    for request in pending.into_values() {
        if let Some(receipt) = request.receipt {
            let _ = receipt.uncertain().await;
        }
    }
    result
}

struct Pending<'a> {
    method: &'static str,
    receipt: Option<Receipt<'a>>,
}

async fn relay<'a>(
    client: &mut WebSocketStream<TcpStream>,
    core: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    view: &'a Arc<View>,
    session: &Value,
    pending: &mut HashMap<String, Pending<'a>>,
    stop: &mut watch::Receiver<bool>,
    open: Signal,
) -> Result<()> {
    let mut initialized = false;
    let mut starting: Option<(String, Work<Value>)> = None;
    let mut queue_requests = FuturesUnordered::new();
    let mut queue_ids = HashSet::new();
    let mut queue_revision = view.queue_state.revision.subscribe();
    let thread = &session["threadId"];
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            response = async { starting.as_mut().unwrap().1.as_mut().await }, if starting.is_some() => {
                starting = None;
                send(client, response?).await?;
            }
            response = queue_requests.next(), if !queue_requests.is_empty() => {
                let (id, response) = response.expect("pending console queue request")?;
                queue_ids.remove(&id);
                send(client, response).await?;
            }
            changed = queue_revision.changed(), if initialized => {
                changed?;
                let revision = *queue_revision.borrow_and_update();
                if let Some(revision) = revision {
                    view.assert_current()?;
                    send(client, json!({"method":"thread/queue/changed","params":json!({
                        "threadId":thread,"managedQueue":json!({"revision":revision.to_string()}),
                    })})).await?;
                }
            }
            input = client.next() => {
                let Some(frame) = frame(input)? else { return Ok(()); };
                let Some(mut frame) = frame else { continue; };
                let id = &frame["id"];
                let key = id.stringify();
                if queue_ids.contains(&key) || starting.as_ref().is_some_and(|(existing, _)| *existing == key) {
                    send(client, fault(id, -32001, "Duplicate in-flight native request ID.")).await?;
                    continue;
                }
                if queue::manages(&frame["method"]) {
                    if initialized && valid_id(id) && !pending.contains_key(&key)
                        && queue_ids.len() < 16 && scope_matches(&frame, thread)
                        && frame["params"]["threadId"] == *thread
                    {
                        queue_ids.insert(key);
                        queue_requests.push(queue::request(view.clone(), session.clone(), frame, open.clone()));
                    } else {
                        send(client, fault(id, -32001, "The native console cannot submit this queue request.")).await?;
                    }
                    continue;
                }
                if frame["method"] == "turn/start" {
                    if initialized && valid_id(id) && pending.len() < 1024
                        && !pending.contains_key(&key) && starting.is_none()
                        && scope_matches(&frame, thread)
                    {
                        starting = Some((key, prompt::start(view.clone(), session.clone(), frame, open.clone())));
                    } else {
                        send(client, fault(id, -32001, "The native console cannot submit this request.")).await?;
                    }
                    continue;
                }
                let request = client_request(view, session, &mut frame, pending, initialized).await;
                match request {
                    Ok(Some((key, request))) => {
                        pending.insert(key, request);
                        send(core, frame).await?;
                    }
                    Ok(None) => send(core, frame).await?,
                    Err(error) => send(client, fault(&frame["id"], -32001, &error.to_string())).await?,
                }
            }
            input = core.next() => {
                let Some(frame) = frame(input)? else { return Ok(()); };
                let Some(mut frame) = frame else { continue; };
                view.assert_current()?;
                if let Some(method) = frame["method"].as_str() {
                    if frame.get("id").is_some() {
                        // A viewing socket cannot settle a server request owned by
                        // the runtime or another subscriber.
                        continue;
                    }
                    if method == "thread/queue/changed" {
                        if initialized && frame["params"]["threadId"] == *thread {
                            queue::native_changed(view.clone());
                        }
                        continue;
                    }
                    if !scope_matches(&frame, thread) || (method.starts_with("thread/") && frame["params"]["threadId"].is_null()) {
                        continue;
                    }
                } else {
                    let request = pending.remove(&frame["id"].stringify()).ok_or_else(|| anyhow::anyhow!("Uncorrelated native console response."))?;
                    if let Some(receipt) = request.receipt {
                        if frame["error"].is_object() {
                            receipt.rejected(&frame["error"]).await?;
                        } else {
                            if frame.get("result").is_none()
                                || (request.method == "thread/resume" && &frame["result"]["thread"]["id"] != thread)
                            {
                                receipt.uncertain().await?;
                                bail!("Codex did not acknowledge the bound console thread.");
                            }
                            receipt.applied(&json!({"result":frame["result"]}), None).await?;
                        }
                    }
                    if frame.get("result").is_some() {
                        if request.method == "initialize" {
                            initialized = true;
                            frame["result"]["cantripManagedGateway"] = json!({
                                "version":1,"threadId":thread,"replyMethod":"cantrip/managed/reply",
                                "queue":json!({"version":1}),
                            });
                        } else if discovery(request.method) {
                            restrict_thread_list(&mut frame, request.method, thread);
                        }
                    }
                }
                send(client, frame).await?;
            }
        }
    }
}

async fn client_request<'a>(
    view: &'a View,
    session: &Value,
    frame: &mut Value,
    pending: &HashMap<String, Pending<'a>>,
    initialized: bool,
) -> Result<Option<(String, Pending<'a>)>> {
    view.assert_current()?;
    let method = frame["method"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid native console request."))?;
    let Some(id) = frame.get("id") else {
        ensure!(
            initialized && method == "initialized",
            "Unsupported native console notification."
        );
        return Ok(None);
    };
    let key = id.stringify();
    ensure!(valid_id(id), "Invalid native console request ID.");
    ensure!(
        !pending.contains_key(&key) && pending.len() < 1024,
        "Invalid or excessive pending native console requests."
    );
    ensure!(
        scope_matches(frame, &session["threadId"]),
        "Native request targets another managed session."
    );
    ensure!(
        (method == "initialize") != initialized,
        "The native view must initialize once."
    );
    if let Some(method) = read_method(method) {
        if method == "initialize" {
            ensure!(
                pending.is_empty(),
                "The native view is already initializing."
            );
        } else if method.starts_with("thread/")
            && !discovery(method)
            && method != "thread/realtime/listVoices"
        {
            ensure!(
                frame["params"]["threadId"] == session["threadId"],
                "Native request requires the bound thread ID."
            );
        }
        return Ok(Some((
            key,
            Pending {
                method,
                receipt: None,
            },
        )));
    }
    let method = match method {
        "thread/resume" => "thread/resume",
        "thread/unsubscribe" => "thread/unsubscribe",
        "skills/list" => "skills/list",
        _ => bail!("Native console method requires a managed handler: {method}"),
    };
    if method == "skills/list" {
        // The native list API takes arbitrary host directories. The managed
        // TUI selects the one directory already admitted for this placement.
        let force_reload = frame["params"]["forceReload"].as_bool().unwrap_or(false);
        frame["params"] = json!({"cwds": vec![view.cwd.clone()], "forceReload":force_reload});
    } else {
        preserving_params(&frame["params"], &session["threadId"], method)?;
    }
    let scope = Scope::new(view.turns.encryption.clone())?;
    ensure!(
        scope.owner == view.prepared.bound.0
            && view.prepared.bound.1.as_js_string() == Some(&scope.server),
        "The managed console owner changed."
    );
    let receipt = view
        .turns
        .receipts
        .admit_console(scope, session.clone(), method, frame, &view.permission)
        .await?;
    if let Err(error) = async {
        view.assert_current()?;
        receipt.dispatch().await?;
        view.assert_current()
    }
    .await
    {
        receipt
            .rejected(&json!({"code":-32000,"message":"The native attachment was not dispatched."}))
            .await?;
        return Err(error);
    }
    Ok(Some((
        key,
        Pending {
            method,
            receipt: Some(receipt),
        },
    )))
}

fn preserving_params(params: &Value, thread: &Value, method: &str) -> Result<()> {
    ensure!(
        params["threadId"] == *thread,
        "Managed attachment requires the bound thread ID."
    );
    for (name, value) in params.as_object().unwrap() {
        let allowed = match name.as_str() {
            Some("threadId") => true,
            Some("excludeTurns" | "initialTurnsPage") if method == "thread/resume" => true,
            Some(name) if method == "thread/resume" => value.is_null() && name != "serviceTier",
            _ => false,
        };
        ensure!(
            allowed,
            "Managed attachment cannot override {}; use a settings command.",
            name.lossy()
        );
    }
    Ok(())
}

fn scope_matches(frame: &Value, thread: &Value) -> bool {
    [
        "threadId",
        "thread_id",
        "conversationId",
        "conversation_id",
        "attachedToThreadId",
    ]
    .iter()
    .all(|field| {
        frame["params"]
            .get(*field)
            .is_none_or(|target| target == thread)
    })
}

fn discovery(method: &str) -> bool {
    matches!(
        method,
        "thread/list" | "thread/loaded/list" | "thread/search"
    )
}

fn restrict_thread_list(frame: &mut Value, method: &str, thread: &Value) {
    let data = frame["result"]["data"].as_array().map(|items| {
        items
            .iter()
            .filter(|item| match method {
                "thread/list" => &item["id"] == thread,
                "thread/search" => &item["thread"]["id"] == thread,
                _ => *item == thread,
            })
            .cloned()
            .collect::<Vec<_>>()
    });
    if let Some(data) = data {
        frame["result"]["data"] = json!(data);
    }
}

fn valid_id(id: &Value) -> bool {
    id.is_string()
        || id
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
}

pub(super) fn fault(id: &Value, code: i32, message: &str) -> Value {
    let id = if valid_id(id) { id } else { &Value::Null };
    json!({"id":id,"error":json!({"code":code,"message":message})})
}

async fn send<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<T>,
    value: Value,
) -> Result<()> {
    tokio::time::timeout(
        IO_TIMEOUT,
        socket.send(Message::Text(value.stringify().into())),
    )
    .await??;
    Ok(())
}

fn frame(
    input: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<Option<Option<Value>>> {
    match input.transpose()? {
        Some(Message::Text(text)) => {
            let parsed = parse_json_text(text.as_str())
                .map_err(|_| anyhow::anyhow!("Invalid native console JSON."))?;
            ensure!(parsed.is_object(), "Invalid native console envelope.");
            Ok(Some(Some(parsed)))
        }
        Some(Message::Binary(_)) => bail!("Native console requires text WebSocket frames."),
        Some(Message::Close(_)) | None => Ok(None),
        _ => Ok(Some(None)),
    }
}

fn read_method(method: &str) -> Option<&'static str> {
    // The native discovery methods used by the pinned TUI. All thread reads
    // require the exact binding or a filtered listing.
    const METHODS: &[&str] = &[
        "initialize",
        "server/diagnostics",
        "thread/goal/get",
        "thread/queue/list",
        "thread/backgroundTerminals/list",
        "thread/list",
        "thread/loaded/list",
        "thread/read",
        "thread/attachment/list",
        "thread/attachmentOwner/list",
        "thread/settings/read",
        "thread/settings/operation/read",
        "thread/turns/list",
        "thread/items/list",
        "thread/items/read",
        "thread/search",
        "thread/searchOccurrences",
        "thread/timeline/list",
        "thread/realtime/listVoices",
        "model/list",
        "modelProvider/capabilities/read",
        "collaborationMode/list",
        "experimentalFeature/list",
        "permissionProfile/list",
        "config/read",
        "configRequirements/read",
        "account/read",
        "account/rateLimits/read",
        "account/usage/read",
        "account/workspaceMessages/read",
        "getAuthStatus",
        "userVerification/status",
        "memory/status",
    ];
    METHODS
        .iter()
        .copied()
        .find(|candidate| *candidate == method)
}
