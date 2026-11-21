mod alerts;
mod chats;
mod computer_use;
mod policy;
mod streamable;
mod targets;
mod tasks;

use super::{Active, Entry, Inner, MAXIMUM_OPERATIONS, now, server::Rejected, store};
use anyhow::{Result, anyhow, ensure};
use bytes::Bytes;
use cantrip_protocol::mcp_host;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode, body::Incoming, header, server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::watch, task::JoinSet};

const MAXIMUM_REQUEST: usize = 256 * 1024;
const MAXIMUM_RESPONSE: usize = 512 * 1024;
const STALE_RECOVERY: &str = "Do not retry this operation on the same attachment. Start or resume a turn in the active Cantrip chat so the worker can refresh it.";

type Reply = Response<Full<Bytes>>;

pub(super) async fn serve(
    listener: TcpListener,
    service: Arc<Inner>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut connections = JoinSet::new();
    let mut sweep = tokio::time::interval(Duration::from_secs(60));
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break Ok(()),
            _ = sweep.tick() => {
                if let Err(error) = service.sweep() {
                    break Err(error);
                }
            }
            done = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = done { break Err(error.into()); }
            }
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let service = service.clone();
                    connections.spawn(async move {
                        let _ = http1::Builder::new().timer(TokioTimer::new())
                            .serve_connection(TokioIo::new(socket), service_fn(move |request| {
                                let service = service.clone();
                                async move { Ok::<_, Infallible>(service.handle(request).await) }
                            })).await;
                    });
                }
                Err(error) => break Err(error.into()),
            }
        }
    };
    drop(listener);
    let cleanup = service.shutdown();
    connections.shutdown().await;
    result.and(cleanup)
}

struct RequestSlot(Arc<AtomicUsize>);
impl Drop for RequestSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Authorized {
    active: Arc<Active>,
    identity: (JsString, JsString),
    version: u64,
    expires_at: i64,
    legacy_root: Option<Value>,
    _slot: RequestSlot,
}

impl Inner {
    async fn handle(&self, request: Request<Incoming>) -> Reply {
        let (parts, body) = request.into_parts();
        let path = parts.uri.path();
        let credential = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|head| head.to_str().ok());
        if let Some(id) = binding_path(path, "/v1/mcp/") {
            return self.streamable(&id, credential, &parts, body, false).await;
        }
        if let Some(id) = binding_path(path, "/v1/cua-mcp/") {
            return self.streamable(&id, credential, &parts, body, true).await;
        }
        if parts.method == Method::POST && path == "/v1/computer-use" {
            return self.cua_broker(credential, body).await;
        }
        if parts.method == Method::GET
            && let Some(id) = binding_path(path, "/v1/bindings/")
        {
            return self.authenticated(&id, credential, |entry| {
                Ok(json_response(StatusCode::OK, json!({
                    "protocolVersion":1,"bindingId":id,"expiresAt":entry.attachment.connection["expiresAt"]
                })))
            }).unwrap_or_else(Failure::reply);
        }
        if parts.method != Method::POST || path != "/v1/execute" {
            return Failure::new(StatusCode::NOT_FOUND, None, "Not found").reply();
        }
        let body = match Limited::new(body, MAXIMUM_REQUEST).collect().await {
            Ok(body) => body.to_bytes(),
            Err(_) => return Failure::invalid("MCP broker request is too large.").reply(),
        };
        if body.is_empty() {
            return Failure::invalid("MCP broker request body is required.").reply();
        }
        let request = parse_json_text(&String::from_utf8_lossy(&body))
            .ok()
            .and_then(|value| {
                mcp_host::parse("cantripMcpBrokerOperationRequestSchema", Some(&value)).ok()
            });
        let Some(request) = request else {
            return Failure::invalid("Cantrip MCP operation validation failed on the worker.")
                .reply();
        };
        let id = request["bindingId"].as_js_string().unwrap();
        let call = &request["request"];
        match self.operate(id, credential, call).await {
            Ok(output) => json_response(StatusCode::OK, output),
            Err(error) => error.reply(),
        }
    }

    async fn operate(
        &self,
        id: &JsString,
        credential: Option<&str>,
        call: &Value,
    ) -> Result<Value, Failure> {
        let operation = call["operation"].as_str().unwrap();
        let authorization = self.authenticated(id, credential, |entry| admit(entry, operation))?;
        if (self.identity)().as_ref().ok() != Some(&authorization.identity) {
            return Err(unauthorized());
        }
        let output = self.execute(&authorization, call.clone(), operation).await;
        if (self.identity)().as_ref().ok() != Some(&authorization.identity) {
            return Err(unauthorized());
        }
        // An accepted request may finish after its lane is replaced. Completion
        // and stale latches can affect only the exact activation it captured.
        output.map_err(|error| match error.downcast_ref::<Rejected>() {
            Some(error) => self.rejection(id, &authorization.active, error),
            None => Failure::invalid(&error.to_string()),
        })
    }

    fn authenticated<T>(
        &self,
        binding_id: &JsString,
        credential: Option<&str>,
        action: impl FnOnce(&mut Entry) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let identity = (self.identity)().map_err(|_| unauthorized())?;
        let mut entries = self.entries.lock().unwrap();
        let entry = entries
            .by_id
            .get_mut(binding_id)
            .filter(|entry| {
                entry.identity == identity
                    && store::authorized(
                        credential,
                        entry.attachment.connection["credential"]
                            .as_js_string()
                            .unwrap(),
                    )
            })
            .ok_or_else(unauthorized)?;
        if entry.expires_at <= now() {
            let _ = self.remove(&mut entries, binding_id);
            return Err(unauthorized());
        }
        action(entry)
    }

    async fn execute(
        &self,
        authorization: &Authorized,
        call: Value,
        operation: &str,
    ) -> Result<Value> {
        match operation {
            "tool.help" => {
                let arguments =
                    mcp_host::parse("cantripMcpToolHelpInputSchema", call.get("arguments"))
                        .map_err(|_| {
                            anyhow!("Cantrip MCP operation validation failed on the worker.")
                        })?;
                let tool = arguments["tool"].as_str().unwrap();
                Ok(super::super::rpc::catalog()["help"][tool].clone())
            }
            "web.search" => {
                self.web
                    .search(&authorization.active.binding, call.get("arguments"))
                    .await
            }
            "web.read" => {
                self.web
                    .read(&authorization.active.binding, call.get("arguments"))
                    .await
            }
            "web.session.open" if call["arguments"].get("browserTarget").is_some() => {
                let args = mcp_host::parse("mcpStdioInput/web_session_open", call.get("arguments"))
                    .map_err(super::response_error)?;
                let mut lane = authorization.active.stopped.subscribe();
                let target = tokio::select! {
                    biased;
                    _ = lane.wait_for(|stopped| *stopped) => {
                        return Err(anyhow!("Browser operation stopped with its agent turn."));
                    }
                    target = self.server.inspect_browser(
                        authorization.active.binding.clone(), authorization.version,
                        authorization.legacy_root.as_ref(), args["browserTarget"].clone(),
                        &authorization.identity.1,
                    ) => target?,
                };
                self.web
                    .open_visible(&authorization.active.binding, target, &args, lane)
                    .await
            }
            operation
                if crate::web::session::TOOLS
                    .iter()
                    .any(|(name, _)| *name == operation) =>
            {
                self.web
                    .session(
                        operation,
                        &authorization.active.binding,
                        call.get("arguments"),
                        authorization.active.stopped.subscribe(),
                    )
                    .await
            }
            "context.get" => {
                mcp_host::parse("cantripMcpContextGetInputSchema", call.get("arguments")).map_err(
                    |_| anyhow!("Cantrip MCP operation validation failed on the worker."),
                )?;
                let mut result = self
                    .server
                    .context(
                        authorization.active.binding.clone(),
                        authorization.version,
                        authorization.legacy_root.as_ref(),
                        call,
                        &uuid::Uuid::new_v4().to_string(),
                    )
                    .await?;
                if let Some(window) = authorization
                    .active
                    .context
                    .get()
                    .and_then(|context| context.inspect())
                {
                    let summary = match (
                        window["usedTokens"].as_u64(),
                        window["contextWindowTokens"].as_u64(),
                        window["usedPercent"].as_f64(),
                    ) {
                        (Some(used), Some(capacity), Some(percent)) => {
                            format!(" Context is using {used} of {capacity} tokens ({percent}%).")
                        }
                        _ => " Codex has not reported context occupancy for this turn yet."
                            .to_owned(),
                    };
                    let existing = result["summary"].as_js_string().unwrap();
                    result["summary"] = Value::String(JsString::new(
                        existing
                            .units()
                            .iter()
                            .copied()
                            .take(2_000 - summary.encode_utf16().count())
                            .chain(summary.encode_utf16())
                            .collect(),
                    ));
                    result["data"]["contextWindow"] = window;
                }
                Ok(result)
            }
            "context.compact" => {
                mcp_host::parse("mcpStdioInput/context_compact", call.get("arguments"))
                    .map_err(super::response_error)?;
                let active = &authorization.active;
                let context = active.context.get().ok_or_else(|| anyhow!("The Codex context compaction request does not match the active Cantrip turn."))?;
                self.server
                    .authorize_compaction(
                        &active.binding,
                        authorization.version,
                        authorization.legacy_root.as_ref(),
                        call,
                    )
                    .await?;
                let window = context.schedule(|| {
                    !*active.stopped.borrow()
                        && (self.identity)().as_ref().ok() == Some(&authorization.identity)
                }).ok_or_else(|| anyhow!("The Codex context compaction request does not match the active Cantrip turn."))?;
                mcp_host::parse("mcpStdioOutput/context_compact", Some(&json!({
                    "summary":"Native Codex context compaction is scheduled for the safe idle boundary after this turn. Finish this turn now.",
                    "target":Value::Null, "worktreeId":active.binding["worktreeId"],
                    "continuationScheduled":true, "mutated":true, "data":window,
                }))).map_err(super::response_error)
            }
            "policy.list" | "policy.read" => self.policy(authorization, &call, operation).await,
            "alert.raise" | "alert.resolve" => self.alert(authorization, &call, operation).await,
            "target.list" | "target.inspect" => self.target(authorization, &call, operation).await,
            "task.list" | "task.status" | "task.wait" | "task.create" => {
                self.task(authorization, &call, operation).await
            }
            "chat.list" | "chat.read" | "chat.wait" | "chat.send" => {
                self.chat(authorization, &call, operation).await
            }
            _ => Err(anyhow!("Unsupported Cantrip MCP operation.")),
        }
    }

    async fn relay_project(
        &self,
        authorization: &Authorized,
        call: Value,
        request_id: &str,
    ) -> Result<Value> {
        ensure!(
            !*authorization.active.stopped.borrow()
                && (self.identity)().as_ref().ok() == Some(&authorization.identity),
            "The managed MCP attachment was replaced."
        );
        self.server
            .invoke(
                authorization.active.binding.clone(),
                authorization.version,
                authorization.legacy_root.as_ref(),
                call,
                request_id,
            )
            .await
    }

    fn revoke_current(&self, id: &JsString, active: &Arc<Active>) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        if entries
            .by_id
            .get(id)
            .and_then(|entry| entry.active.as_ref())
            .is_some_and(|current| Arc::ptr_eq(active, current))
        {
            self.remove(&mut entries, id)?;
        }
        Ok(())
    }

    fn rejection(&self, id: &JsString, active: &Arc<Active>, error: &Rejected) -> Failure {
        let message = match error.code.as_ref().and_then(JsString::as_str) {
            Some("expired") => {
                let _ = self.revoke_current(id, active);
                error.message.clone()
            }
            Some("stale-binding") => {
                let message = JsString::new(
                    error
                        .message
                        .units()
                        .iter()
                        .copied()
                        .chain(" ".encode_utf16())
                        .chain(STALE_RECOVERY.encode_utf16())
                        .take(2_000)
                        .collect(),
                );
                *active.stale.lock().unwrap() = Some(message.clone());
                active.stopped.send_replace(true);
                message
            }
            _ => error.message.clone(),
        };
        Failure::new(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
            error.code.as_ref().and_then(JsString::as_str),
            message,
        )
    }
}

fn admit(entry: &mut Entry, operation: &str) -> Result<Authorized, Failure> {
    let active = entry.active.as_ref().ok_or_else(|| {
        Failure::new(
            StatusCode::CONFLICT,
            Some("inactive-binding"),
            "This MCP session has no active execution binding.",
        )
    })?;
    if !active.binding["allowedOperations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|allowed| allowed == operation)
    {
        return Err(Failure::new(
            StatusCode::FORBIDDEN,
            Some("forbidden"),
            "This MCP binding does not allow that operation.",
        ));
    }
    if let Some(stale) = active.stale.lock().unwrap().as_ref() {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            Some("stale-binding"),
            stale.clone(),
        ));
    }
    if entry.requests.load(Ordering::Acquire) >= MAXIMUM_OPERATIONS {
        return Err(Failure::new(
            StatusCode::TOO_MANY_REQUESTS,
            Some("busy"),
            "This MCP binding has too many operations in flight.",
        ));
    }
    entry.requests.fetch_add(1, Ordering::AcqRel);
    Ok(Authorized {
        active: active.clone(),
        identity: entry.identity.clone(),
        version: entry.capabilities.version,
        expires_at: entry.expires_at,
        legacy_root: entry.legacy_root.clone(),
        _slot: RequestSlot(entry.requests.clone()),
    })
}

fn binding_path(path: &str, prefix: &str) -> Option<JsString> {
    let id = path.strip_prefix(prefix)?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || matches!(c, b'a'..=b'f' | b'-')))
    .then(|| id.into())
}

struct Failure {
    status: StatusCode,
    code: Option<JsString>,
    message: JsString,
}

impl Failure {
    fn new(status: StatusCode, code: Option<&str>, message: impl Into<JsString>) -> Self {
        Self {
            status,
            code: code.map(JsString::from),
            message: message.into(),
        }
    }

    fn invalid(message: &str) -> Self {
        let message = JsString::new(message.encode_utf16().take(2_000).collect());
        Self::new(StatusCode::BAD_REQUEST, Some("invalid"), message)
    }

    fn reply(self) -> Reply {
        let payload = match self.code {
            Some(code) => json!({"code":code,"error":self.message}),
            None => json!({"error":self.message}),
        };
        json_response(self.status, payload)
    }
}

fn unauthorized() -> Failure {
    Failure::new(StatusCode::UNAUTHORIZED, None, "Unauthorized")
}

fn json_response(status: StatusCode, payload: Value) -> Reply {
    json_response_with_limit(status, payload, MAXIMUM_RESPONSE)
}

fn json_response_with_limit(mut status: StatusCode, payload: Value, maximum: usize) -> Reply {
    let mut body = payload.stringify();
    body.push('\n');
    if body.len() > maximum {
        status = StatusCode::PAYLOAD_TOO_LARGE;
        body = json!({
            "code":"output-too-large",
            "error":"The MCP operation result exceeded the worker output limit."
        })
        .stringify()
            + "\n";
    }
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Full::new(Bytes::from(body)))
        .expect("valid MCP response")
}
