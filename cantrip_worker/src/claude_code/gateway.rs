//! Per-Codex-runtime Responses listener. The capability and account stay on the worker.
use super::{
    Manager,
    inference::{Failure, Prompt, Turn},
    responses::{DECISION_SCHEMA, INSTRUCTIONS, Input},
};
use crate::metadata::{Abort, Signal};
use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use cantrip_wire::{JsString, Value as WireValue};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::Ipv4Addr,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, watch},
    task::JoinSet,
};

const REQUEST_LIMIT: usize = 8 * 1024 * 1024;
const RESPONSE_TIME: Duration = Duration::from_secs(150);
const CONTINUATION_LIFETIME: Duration = Duration::from_secs(30 * 60);
const TURN_LIMIT: usize = 128;

pub(crate) struct Gateway {
    pub url: String,
    stop: watch::Sender<bool>,
    service: Arc<Service>,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

type VerifyOwner = Arc<dyn Fn() -> Result<()> + Send + Sync>;

impl Gateway {
    pub(crate) fn stop(&self) {
        self.stop.send_replace(true);
    }

    pub(crate) fn observe(&self) -> impl Fn(Option<&str>) + Send + Sync + 'static {
        let service = Arc::downgrade(&self.service);
        let stop = self.stop.clone();
        move |turn| {
            if let Some(turn) = turn {
                if let Some(service) = service.upgrade() {
                    service.turns.lock().unwrap().remove(turn);
                }
            } else {
                stop.send_replace(true);
            }
        }
    }

    pub(crate) async fn start(
        data: &Path,
        owner: JsString,
        server: JsString,
        account: JsString,
        verify: VerifyOwner,
    ) -> Result<Self> {
        verify()?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let path = format!("/{}/v1/responses", uuid::Uuid::new_v4().simple());
        let url = format!(
            "http://{}{}",
            listener.local_addr()?,
            path.trim_end_matches("/responses")
        );
        let service = Arc::new(Service {
            path,
            owner,
            server,
            account: WireValue::String(account),
            verify,
            manager: Manager::new(data),
            turns: Mutex::default(),
        });
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(serve(listener, service.clone(), stopped));
        Ok(Self { url, stop, service })
    }
}

async fn serve(listener: TcpListener, service: Arc<Service>, mut stopped: watch::Receiver<bool>) {
    let mut connections = JoinSet::new();
    let mut collect = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            biased;
            _ = stopped.changed() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            _ = collect.tick() => service.collect(),
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { break };
                let service = service.clone();
                connections.spawn(async move {
                    let _ = http1::Builder::new().timer(TokioTimer::new())
                        .serve_connection(TokioIo::new(socket), service_fn(move |request| {
                            let service = service.clone();
                            async move { Ok::<_, Infallible>(service.handle(request).await) }
                        })).await;
                });
            }
        }
    }
    connections.shutdown().await;
    service.turns.lock().unwrap().clear();
}

struct AbortRequest(Abort);
impl Drop for AbortRequest {
    fn drop(&mut self) {
        self.0
            .abort(anyhow::anyhow!("Codex closed its Claude Code request."));
    }
}

struct Service {
    path: String,
    owner: JsString,
    server: JsString,
    account: WireValue,
    verify: VerifyOwner,
    manager: Manager,
    turns: Mutex<HashMap<String, Continuation>>,
}

struct Continuation {
    request: Arc<AsyncMutex<Pending>>,
    updated: Instant,
    managed: bool,
    call: Option<String>,
}

#[derive(Default)]
struct Pending {
    lease: Option<Turn>,
}

impl Service {
    fn collect(&self) {
        self.turns.lock().unwrap().retain(|_, turn| {
            turn.managed
                || turn.updated.elapsed() < CONTINUATION_LIFETIME
                || Arc::strong_count(&turn.request) > 1
        });
    }

    async fn handle(self: Arc<Self>, incoming: Request<Incoming>) -> Response<Full<Bytes>> {
        let (parts, body) = incoming.into_parts();
        if parts.uri.path() != self.path || parts.uri.authority().is_some() {
            return error(
                StatusCode::NOT_FOUND,
                "unsupported_endpoint",
                "This endpoint is unavailable on Claude Code.",
            );
        }
        if parts.method != Method::POST {
            return error(
                StatusCode::METHOD_NOT_ALLOWED,
                "unsupported_method",
                "Claude Code expects a POST Responses request.",
            );
        }
        if (self.verify)().is_err() {
            return error(
                StatusCode::FORBIDDEN,
                "worker_binding_changed",
                "The Claude Code worker binding changed.",
            );
        }
        let Ok(body) = Limited::new(body, REQUEST_LIMIT).collect().await else {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "The Claude Code request exceeded its input limit.",
            );
        };
        let Ok(request) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Claude Code could not read the Responses request.",
            );
        };
        let input = match Input::parse(&request) {
            Ok(input) => input,
            Err(cause) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "unsupported_request",
                    &cause.to_string(),
                );
            }
        };
        let metadata = parts
            .headers
            .get("x-codex-turn-metadata")
            .and_then(|header| header.to_str().ok())
            .or_else(|| request["client_metadata"]["x-codex-turn-metadata"].as_str());
        let turn = metadata.and_then(|metadata| serde_json::from_str::<Value>(metadata).ok());
        let turn_id = turn
            .as_ref()
            .and_then(|turn| turn["turn_id"].as_str().or(turn["turnId"].as_str()))
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .map(str::to_owned);
        let results = request["input"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["type"] == "function_call_output")
            .filter_map(|item| item["call_id"].as_str())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let (abort, signal) = Abort::new();
        let _abort = AbortRequest(abort);
        let stream = input.stream;
        let job = tokio::spawn(self.infer(turn_id, results, input, signal));
        match job.await {
            Ok(Ok(result)) if stream => {
                response(StatusCode::OK, "text/event-stream", result.events())
            }
            Ok(Ok(result)) => response(
                StatusCode::OK,
                "application/json",
                result.response.to_string(),
            ),
            Ok(Err(cause)) => {
                if let Some(failure) = cause.downcast_ref::<Failure>() {
                    let status = match failure {
                        Failure::SignIn => StatusCode::UNAUTHORIZED,
                        Failure::Quota => StatusCode::TOO_MANY_REQUESTS,
                        Failure::Model => StatusCode::NOT_FOUND,
                        Failure::Timeout => StatusCode::GATEWAY_TIMEOUT,
                        _ => StatusCode::BAD_GATEWAY,
                    };
                    error(status, failure.code(), &failure.to_string())
                } else {
                    error(
                        StatusCode::BAD_GATEWAY,
                        "claude_code_request_failed",
                        &cause.to_string(),
                    )
                }
            }
            Err(_) => error(
                StatusCode::BAD_GATEWAY,
                "claude_code_inference_failed",
                "The worker could not complete Claude Code inference.",
            ),
        }
    }

    async fn infer(
        self: Arc<Self>,
        identity: Option<String>,
        outputs: Vec<String>,
        input: Input,
        signal: Signal,
    ) -> Result<super::responses::Output> {
        let managed = identity.is_some();
        let (key, mut pending, expected_call) = {
            let mut turns = self.turns.lock().unwrap();
            let matching = turns
                .iter()
                .find(|(_, turn)| {
                    turn.call
                        .as_ref()
                        .is_some_and(|call| outputs.contains(call))
                })
                .map(|(key, _)| key.clone());
            let key = identity
                .or(matching)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            ensure!(
                turns.contains_key(&key) || turns.len() < TURN_LIMIT,
                "Too many Claude Code turns are waiting for tools."
            );
            let entry = turns.entry(key.clone()).or_insert_with(|| Continuation {
                request: Arc::new(AsyncMutex::new(Pending::default())),
                updated: Instant::now(),
                managed,
                call: None,
            });
            let pending = entry
                .request
                .clone()
                .try_lock_owned()
                .context("This Claude Code turn already has a request in flight.")?;
            (key, pending, entry.call.clone())
        };
        let result = async {
            signal.check()?;
            (self.verify)()?;
            if let Some(call) = expected_call {
                ensure!(
                    outputs.contains(&call),
                    "Codex did not return the result of the requested function."
                );
            }
            if pending.lease.is_none() {
                pending.lease = Some(
                    self.manager
                        .turn(&self.owner, &self.server, &self.account, &signal)
                        .await
                        .context("Claude Code could not open the managed worker profile.")?,
                );
            }
            let turn = pending.lease.as_ref().unwrap();
            let reply = turn
                .infer(
                    Prompt {
                        model: &input.model,
                        instructions: INSTRUCTIONS,
                        text: &input.prompt,
                    },
                    input.effort,
                    Some(DECISION_SCHEMA),
                    RESPONSE_TIME,
                    &signal,
                )
                .await?;
            (self.verify)()?;
            signal.check()?;
            input.reply(reply)
        }
        .await;
        let mut turns = self.turns.lock().unwrap();
        if let Some(entry) = turns.get_mut(&key)
            && let Ok(result) = &result
            && (entry.managed || result.item["call_id"].is_string())
        {
            entry.call = result.item["call_id"].as_str().map(str::to_owned);
            entry.updated = Instant::now();
        } else {
            turns.remove(&key);
        }
        result
    }
}

fn response(status: StatusCode, kind: &'static str, body: String) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", kind)
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(body)))
        .expect("static local response headers")
}

fn error(status: StatusCode, code: &str, message: &str) -> Response<Full<Bytes>> {
    response(
        status,
        "application/json",
        json!({"error":{"type":code,"code":code,"message":message}}).to_string(),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::claude_code::{Profile, tests::install_fixture};

    async fn decode(response: reqwest::Response) -> Result<Value> {
        Ok(serde_json::from_slice(
            &response.error_for_status()?.bytes().await?,
        )?)
    }

    #[tokio::test]
    async fn continuation_requires_the_native_result_and_keeps_its_original_binary() -> Result<()> {
        let data = tempfile::tempdir()?;
        let manager = Manager::new(data.path());
        let fixture = r#"#!/bin/sh
input=$(/bin/cat)
case "$input" in
  *returned-fixture-result*)
    decision='{"type":"message","text":"original binary received the tool result"}' ;;
  *)
    decision='{"type":"function","name":"test","arguments":"{}"}' ;;
esac
printf '{"type":"result","subtype":"success","is_error":false,"structured_output":%s}\n' "$decision"
"#;
        install_fixture(&manager, fixture)?;
        let account = uuid::Uuid::new_v4();
        let owner = JsString::from("owner");
        let server = JsString::from("server");
        let gateway = Gateway::start(
            data.path(),
            owner.clone(),
            server.clone(),
            account.to_string().into(),
            Arc::new(|| Ok(())),
        )
        .await?;
        let client = reqwest::Client::new();
        let url = format!("{}/responses", gateway.url);
        let send = |key: &'static str, body: Value| {
            client
                .post(&url)
                .header("x-codex-turn-metadata", format!(r#"{{"turn_id":"{key}"}}"#))
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
        };
        let request = json!({"model":"sonnet","input":"use the tool","tools":[{"type":"function","name":"test","parameters":{"type":"object"}}]});
        let first = decode(send("turn-a", request.clone()).await?).await?;
        let call = first["output"][0]["call_id"].as_str().unwrap();
        assert!(
            manager
                .begin_sign_in(Profile::bound(&owner, &server, account))
                .is_err()
        );
        let replacement = fixture.replace("original binary", "replacement binary");
        install_fixture(&manager, &replacement)?;
        let continuation = json!({
            "model":"sonnet","input":[first["output"][0],{"type":"function_call_output","call_id":call,"output":"returned-fixture-result"}]
        });
        let completed = decode(send("turn-a", continuation.clone()).await?).await?;
        assert_eq!(
            completed["output"][0]["content"][0]["text"],
            "original binary received the tool result"
        );
        gateway.observe()(Some("turn-a"));
        let next = decode(send("turn-b", continuation).await?).await?;
        assert_eq!(
            next["output"][0]["content"][0]["text"],
            "replacement binary received the tool result"
        );
        gateway.observe()(Some("turn-b"));
        let next = decode(send("turn-c", request.clone()).await?).await?;
        assert_eq!(next["output"][0]["type"], "function_call");
        assert_eq!(
            send("turn-c", request).await?.status(),
            StatusCode::BAD_GATEWAY
        );
        assert!(
            manager
                .begin_sign_in(Profile::bound(&owner, &server, account))
                .is_ok()
        );
        Ok(())
    }

    #[tokio::test]
    async fn dropping_the_responses_connection_cancels_and_reaps_the_child() -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let data = tempfile::tempdir()?;
        let manager = Manager::new(data.path());
        install_fixture(
            &manager,
            r#"#!/bin/sh
printf '%s' "$$" > "$HOME/fixture-pid"
exec /bin/sleep 60
"#,
        )?;
        let owner = JsString::from("owner");
        let server = JsString::from("server");
        let account = uuid::Uuid::new_v4();
        let installation = manager.installation().await?;
        let profile = Profile::bound(&owner, &server, account);
        let command = installation.account_command(profile)?;
        let marker = command
            .as_std()
            .get_current_dir()
            .unwrap()
            .join("fixture-pid");
        let gateway = Gateway::start(
            data.path(),
            owner,
            server,
            account.to_string().into(),
            Arc::new(|| Ok(())),
        )
        .await?;
        let url = url::Url::parse(&format!("{}/responses", gateway.url))?;
        let mut connection =
            tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, url.port().unwrap())).await?;
        let body = r#"{"model":"sonnet","input":"Wait for cancellation"}"#;
        connection
            .write_all(
                format!(
                    "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{body}",
                    url.path(),
                    body.len()
                )
                .as_bytes(),
            )
            .await?;
        let pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&marker)
                    .unwrap_or_default()
                    .parse::<i32>()
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        drop(connection);
        tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(manager.begin_sign_in(profile).is_ok());
        Ok(())
    }
}
