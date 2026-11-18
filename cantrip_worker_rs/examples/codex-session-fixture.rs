//! Owned JSON driver and native WebSocket peer; never a production launcher.
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use cantrip_worker::codex::{
    process_transport::Options,
    provider_errors::{self, Policy},
    rpc_protocol,
    rpc_requests::{Ports, Record, Requests, Response, Settlement},
    session::{Event, EventKind, Session},
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[path = "support/codex_auth_peer.rs"]
mod auth_peer;
#[path = "support/codex_session_driver.rs"]
mod driver;
#[path = "support/managed_runtime_cases.rs"]
mod managed_runtime;
#[path = "support/codex_ws_peer.rs"]
mod peer;
#[path = "support/private_inference_cases.rs"]
mod private_inference;
fn text(value: &Value, key: &str) -> JsString {
    value[key]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "".into())
}
fn policy(input: &Value) -> Policy {
    Policy {
        secrets: input["secrets"]
            .as_array()
            .map(|v| {
                v.iter()
                    .map(|v| v.as_js_string().unwrap().clone())
                    .collect()
            })
            .unwrap_or_default(),
        zai: input["zai"] == true,
        endpoint: input["endpoint"] == true,
        refreshed_secrets: Default::default(),
    }
}
use driver::{Ticket, Track, recorder};
#[derive(Default)]
struct Fixture {
    requests: Option<Requests>,
    session: Option<Session>,
    observations: Option<tokio::sync::mpsc::UnboundedReceiver<Event>>,
    generation: Option<String>,
    pending: HashMap<String, Work<Response>>,
    track: Arc<Mutex<Track>>,
}
impl Fixture {
    async fn reset(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            session.close().await?;
        }
        if let Some(requests) = self.requests.take() {
            requests.reject_all("fixture reset".into());
        }
        self.pending.clear();
        self.observations = None;
        self.generation = None;
        self.track = Arc::new(Mutex::new(Track::default()));
        Ok(())
    }
    async fn call(&mut self, input: Value) -> Result<Response> {
        let op = input["op"].as_str().unwrap();
        let name = input["name"].as_str().unwrap_or("a").to_owned();
        match op {
            "parse" => Ok(Some(
                rpc_protocol::parse(&text(&input, "value")).unwrap_or(Value::Null),
            )),
            "endpoint" => Ok(Some(
                rpc_protocol::endpoint(&text(&input, "value")).map_or(Value::Null, Value::String),
            )),
            "startup" => Ok(Some(Value::String(rpc_protocol::startup_exit(
                input["status"].as_str().unwrap(),
                &input["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_js_string().unwrap().clone())
                    .collect::<Vec<_>>(),
            )))),
            "provider" => Ok(Some(
                json!({"readable":policy(&input).readable(&text(&input,"value")),"expired":provider_errors::token_expired(&text(&input,"value"))}),
            )),
            "safePayload" => Ok(Some(provider_errors::safe_payload(&input["value"], 0))),
            "new" => {
                self.reset().await?;
                let track = self.track.clone();
                let fail = input.get("sendError").cloned();
                self.requests = Some(Requests::new(Ports {
                    send: Arc::new(move |value| {
                        track.lock().unwrap().frames.push(value);
                        if let Some(error) = &fail {
                            return Err(cantrip_worker::error::WireError(
                                error.as_js_string().unwrap().clone(),
                            )
                            .into());
                        }
                        Ok(())
                    }),
                    record: recorder(self.track.clone()),
                    policy: policy(&input),
                    runtime_id: None,
                    logs: None,
                }));
                Ok(Some(Value::Null))
            }
            "session.open" => {
                self.reset().await?;
                let mut options = Options::local(
                    PathBuf::from(input["cwd"].as_str().unwrap()),
                    std::env::vars().collect(),
                );
                options
                    .environment
                    .insert("PATH".into(), "/usr/bin:/bin".into());
                options
                    .environment
                    .insert("CODEX_HOME".into(), input["home"].as_str().unwrap().into());
                options.environment.insert(
                    "CANTRIP_CODEX_SESSION_FIXTURE".into(),
                    input["config"].stringify(),
                );
                options.record = recorder(self.track.clone());
                options.policy = policy(&input);
                if let Some(ms) = input["timeoutMs"].as_u64() {
                    options.startup_timeout = Duration::from_millis(ms);
                }
                let binary = input["binary"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or(std::env::current_exe()?);
                let arguments = vec![
                    "app-server".into(),
                    "--listen".into(),
                    "ws://127.0.0.1:0".into(),
                ];
                let (session, events) = Session::launch(binary, arguments, options).await?;
                self.generation = session.generation().map(str::to_owned);
                self.session = Some(session);
                self.observations = Some(events);
                Ok(Some(Value::Null))
            }
            "request" => {
                let observer = (input["observe"] == true).then(|| {
                    Arc::new(Ticket {
                        name: text(&input, "name"),
                        track: self.track.clone(),
                        fail: text(&input, "failObserver"),
                    }) as Arc<dyn Settlement>
                });
                let timeout = input["timeoutMs"].as_u64().map(Duration::from_millis);
                let request = if let Some(session) = &self.session {
                    session.request(
                        text(&input, "method"),
                        input.get("params").cloned(),
                        timeout,
                        observer,
                    )
                } else {
                    self.requests.as_ref().unwrap().request(
                        text(&input, "method"),
                        input.get("params").cloned(),
                        timeout,
                        observer,
                    )
                };
                if input["abandon"] != true {
                    self.pending.insert(name, request);
                }
                Ok(Some(Value::Null))
            }
            "await" => self.pending.remove(&name).unwrap().await,
            "response" => {
                let requests = self.requests.as_ref().unwrap();
                let message = &input["message"];
                let payload = requests.diagnostic_payload(message);
                requests.record(json!({"kind":"message","method":message.get("method").cloned().unwrap_or(Value::Null),"payload":payload}),None);
                Ok(Some(
                    json!({"handled":requests.handle_response(message,&payload),"payload":payload}),
                ))
            }
            "reject" => {
                self.requests
                    .as_ref()
                    .unwrap()
                    .reject_all(text(&input, "message"));
                Ok(Some(Value::Null))
            }
            "snapshot" => {
                let track = self.track.lock().unwrap();
                Ok(Some(
                    json!({"frames":track.frames,"diagnostics":track.diagnostics,"tickets":track.tickets,"pending":self.session.as_ref().map_or_else(||self.requests.as_ref().unwrap().pending_count(),Session::pending_count)}),
                ))
            }
            "tick" => {
                tokio::time::sleep(Duration::from_millis(input["ms"].as_u64().unwrap_or(20))).await;
                Ok(Some(Value::Null))
            }
            _ => driver::session(self, &input).await,
        }
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    codex_utils_pty::init_spawn_helper(std::env::args_os());
    if std::env::args().any(|arg| arg == "model_provider=\"openai\"")
        && !std::env::args().any(|arg| arg.starts_with("ws://"))
        && let (Ok(cases), Some(home)) = (
            std::env::var("CANTRIP_TEST_AUTH_FIXTURE"),
            std::env::var_os("CODEX_HOME"),
        )
    {
        let cases = parse_json_text(&cases).map_err(|error| anyhow!("{}", error.lossy()))?;
        let home = PathBuf::from(home);
        if let Some(mode) = home
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| cases[name].as_str())
        {
            return auth_peer::run(mode, &home).await;
        }
    }
    #[cfg(unix)]
    if std::env::var_os("CANTRIP_CATALOG_FIXTURE").is_some()
        && std::env::args()
            .any(|arg| arg == "cantrip-runtime-owner" || arg == "stdio://" || arg == "--version")
    {
        use std::os::unix::process::CommandExt;
        let binary = std::env::var_os("CANTRIP_TEST_CODEX")
            .ok_or_else(|| anyhow!("Set CANTRIP_TEST_CODEX to the installed bundled Codex."))?;
        return Err(std::process::Command::new(binary)
            .args(std::env::args_os().skip(1))
            .exec()
            .into());
    }
    if std::env::args().any(|v| v == "app-server") {
        return peer::run().await;
    }
    if std::env::args().any(|v| v == "--managed-runtime") {
        let binary = std::env::var_os("CANTRIP_TEST_CODEX")
            .ok_or_else(|| anyhow!("Set CANTRIP_TEST_CODEX to the installed bundled Codex."))?;
        return managed_runtime::run(binary.into()).await;
    }
    if std::env::args().any(|v| v == "--private-inference") {
        return private_inference::run().await;
    }
    let mut fixture = Fixture::default();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let input = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result = match fixture.call(input).await {
            Ok(value) => {
                let mut result = json!({"ok":true});
                if let Some(value) = value {
                    result["value"] = value;
                }
                result
            }
            Err(error) => driver::error(&error),
        };
        out.write_all((result.stringify() + "\n").as_bytes())
            .await?;
        out.flush().await?;
    }
    fixture.reset().await?;
    Ok(())
}
