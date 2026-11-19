use super::{Active, Entry, Inner, MAXIMUM_OPERATIONS, now, server::Rejected, store};
use anyhow::{Result, anyhow};
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
        if parts.method == Method::GET
            && let Some(id) = path.strip_prefix("/v1/bindings/")
            && !id.is_empty()
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || matches!(c, b'a'..=b'f' | b'-'))
        {
            let id = id.into();
            return self.authenticated(&id, credential, |entry| {
                Ok(json_response(StatusCode::OK, json!({
                    "protocolVersion":1,"bindingId":id,"expiresAt":entry.attachment.connection["expiresAt"]
                })))
            }).unwrap_or_else(|reply| *reply);
        }
        if parts.method != Method::POST || path != "/v1/execute" {
            return failure(StatusCode::NOT_FOUND, None, "Not found");
        }
        let body = match Limited::new(body, MAXIMUM_REQUEST).collect().await {
            Ok(body) => body.to_bytes(),
            Err(_) => return invalid("MCP broker request is too large."),
        };
        if body.is_empty() {
            return invalid("MCP broker request body is required.");
        }
        let request = parse_json_text(&String::from_utf8_lossy(&body))
            .ok()
            .and_then(|value| {
                mcp_host::parse("cantripMcpBrokerOperationRequestSchema", Some(&value)).ok()
            });
        let Some(request) = request else {
            return invalid("Cantrip MCP operation validation failed on the worker.");
        };
        let id = request["bindingId"].as_js_string().unwrap();
        let call = &request["request"];
        let operation = call["operation"].as_str().unwrap();
        let authorization =
            match self.authenticated(id, credential, |entry| admit(entry, operation)) {
                Ok(authorization) => authorization,
                Err(reply) => return *reply,
            };
        if (self.identity)().as_ref().ok() != Some(&authorization.identity) {
            return unauthorized();
        }
        let output = self.execute(&authorization, call.clone(), operation).await;
        if (self.identity)().as_ref().ok() != Some(&authorization.identity) {
            return unauthorized();
        }
        // An accepted request may finish after its lane is replaced. Completion
        // and stale latches can affect only the exact activation it captured.
        let output = match output {
            Ok(output) => output,
            Err(error) => {
                if let Some(error) = error.downcast_ref::<Rejected>() {
                    return self.rejection(id, &authorization.active, error);
                }
                return invalid(&error.to_string());
            }
        };
        json_response(StatusCode::OK, output)
    }

    fn authenticated<T>(
        &self,
        binding_id: &JsString,
        credential: Option<&str>,
        action: impl FnOnce(&mut Entry) -> Result<T, Box<Reply>>,
    ) -> Result<T, Box<Reply>> {
        let identity = (self.identity)().map_err(|_| Box::new(unauthorized()))?;
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
            .ok_or_else(|| Box::new(unauthorized()))?;
        if entry.expires_at <= now() {
            let _ = self.remove(&mut entries, binding_id);
            return Err(Box::new(unauthorized()));
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
                Ok(super::super::stdio::catalog()["help"][tool].clone())
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
            "context.get" => {
                mcp_host::parse("cantripMcpContextGetInputSchema", call.get("arguments")).map_err(
                    |_| anyhow!("Cantrip MCP operation validation failed on the worker."),
                )?;
                self.server
                    .context(
                        authorization.active.binding.clone(),
                        authorization.version,
                        authorization.legacy_root.as_ref(),
                        call,
                        &uuid::Uuid::new_v4().to_string(),
                    )
                    .await
            }
            _ => Err(anyhow!("Unsupported Cantrip MCP operation.")),
        }
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

    fn rejection(&self, id: &JsString, active: &Arc<Active>, error: &Rejected) -> Reply {
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
                message
            }
            _ => error.message.clone(),
        };
        failure(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
            error.code.as_ref().and_then(JsString::as_str),
            message,
        )
    }
}

fn admit(entry: &mut Entry, operation: &str) -> Result<Authorized, Box<Reply>> {
    let active = entry.active.as_ref().ok_or_else(|| {
        Box::new(failure(
            StatusCode::CONFLICT,
            Some("inactive-binding"),
            "This MCP session has no active execution binding.",
        ))
    })?;
    if !active.binding["allowedOperations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|allowed| allowed == operation)
    {
        return Err(Box::new(failure(
            StatusCode::FORBIDDEN,
            Some("forbidden"),
            "This MCP binding does not allow that operation.",
        )));
    }
    if let Some(stale) = active.stale.lock().unwrap().as_ref() {
        return Err(Box::new(failure(
            StatusCode::CONFLICT,
            Some("stale-binding"),
            stale.clone(),
        )));
    }
    if entry.requests.load(Ordering::Acquire) >= MAXIMUM_OPERATIONS {
        return Err(Box::new(failure(
            StatusCode::TOO_MANY_REQUESTS,
            Some("busy"),
            "This MCP binding has too many operations in flight.",
        )));
    }
    entry.requests.fetch_add(1, Ordering::AcqRel);
    Ok(Authorized {
        active: active.clone(),
        identity: entry.identity.clone(),
        version: entry.capabilities.version,
        legacy_root: entry.legacy_root.clone(),
        _slot: RequestSlot(entry.requests.clone()),
    })
}

fn unauthorized() -> Reply {
    failure(StatusCode::UNAUTHORIZED, None, "Unauthorized")
}

fn invalid(message: &str) -> Reply {
    let message = JsString::new(message.encode_utf16().take(2_000).collect());
    failure(StatusCode::BAD_REQUEST, Some("invalid"), message)
}

fn failure(status: StatusCode, code: Option<&str>, error: impl Into<JsString>) -> Reply {
    let error = error.into();
    let payload = match code {
        Some(code) => json!({"code":code,"error":error}),
        None => json!({"error":error}),
    };
    json_response(status, payload)
}

fn json_response(mut status: StatusCode, payload: Value) -> Reply {
    let mut body = payload.stringify();
    body.push('\n');
    if body.len() > MAXIMUM_RESPONSE {
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
