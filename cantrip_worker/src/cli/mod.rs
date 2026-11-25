//! Authenticated loopback relay for the shipped Cantrip CLI.
mod browser;
mod policy;
mod run;
mod server;
mod surface;

use crate::{config::Config, encryption::Service, http::checked};
use anyhow::{Context, Result, anyhow};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use cantrip_config::Environment;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode, body::Incoming, header, server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    collections::HashMap,
    convert::Infallible,
    io::Write,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::watch,
    task::{JoinHandle, JoinSet},
};
use zeroize::Zeroizing;

const CONNECTION: &str = "CANTRIP_CLI_CONNECTION";
const MAX_REQUEST: usize = 1_000_000;
const MAX_CONNECTIONS: usize = 64;
const READ_TIMEOUT: Duration = Duration::from_secs(15);

type Reply = Response<Full<Bytes>>;

pub(crate) struct Broker {
    connection: ConnectionFile,
    cli: Option<PathBuf>,
    contexts: Contexts,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<Result<()>>>,
}

struct ConnectionFile {
    path: PathBuf,
    token: Arc<Zeroizing<String>>,
}

struct Handler {
    token: Arc<Zeroizing<String>>,
    handshake: Value,
    server: server::Server,
    encryption: Arc<Service>,
    contexts: Contexts,
}

#[derive(Clone, Default)]
pub(crate) struct Contexts(Arc<Mutex<HashMap<JsString, ThreadContext>>>);

#[derive(Clone)]
struct ThreadContext {
    identity: (JsString, Value),
    claim: Value,
}

impl Contexts {
    pub(crate) fn bind(
        &self,
        thread: &JsString,
        identity: &(JsString, Value),
        chat: &Value,
        lane: &Value,
    ) {
        // Keep the last lane after a turn settles. Core must reject a stale
        // lane instead of falling back to resolving an idle thread or cwd.
        self.0.lock().unwrap().insert(
            thread.clone(),
            ThreadContext {
                identity: identity.clone(),
                claim: json!({"chatId":chat,"executionLaneId":lane}),
            },
        );
    }

    fn lookup(&self, thread: &Value, encryption: &Service) -> Value {
        let Some(thread) = thread.as_js_string() else {
            return Value::Null;
        };
        let context = self.0.lock().unwrap().get(thread).cloned();
        context
            .filter(|entry| {
                encryption
                    .bound_identity()
                    .is_ok_and(|identity| identity == entry.identity)
            })
            .map_or(Value::Null, |entry| entry.claim)
    }
}

impl Broker {
    pub(crate) async fn start(
        configuration: Arc<Mutex<Config>>,
        environment: &Environment,
        cwd: &Path,
        worker_root: &Path,
        encryption: Arc<Service>,
    ) -> Result<Self> {
        let (directory, server_url, worker) = {
            let config = configuration.lock().unwrap();
            (
                config.data_directory.clone(),
                config.server_url.clone(),
                config.worker_id.clone(),
            )
        };
        let server = server::Server::new(&server_url, worker.clone(), configuration)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let mut random = Zeroizing::new([0u8; 32]);
        getrandom::fill(random.as_mut()).context("Could not generate the CLI broker session.")?;
        let token = Arc::new(Zeroizing::new(URL_SAFE_NO_PAD.encode(random.as_ref())));
        let connection = ConnectionFile {
            path: directory.join("cli-connection.json"),
            token: token.clone(),
        };
        connection.publish(&json!({
            "version":1,"endpoint":endpoint,"serverUrl":server_url,
            "sessionToken":token.as_str(),"workerId":worker,
        }))?;
        let contexts = Contexts::default();
        let handler = Arc::new(Handler {
            token,
            handshake: json!({"protocolVersion":1,"serverUrl":server_url,"workerId":worker}),
            server,
            encryption,
            contexts: contexts.clone(),
        });
        let cli = cli_binary(environment, cwd, worker_root);
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(serve(listener, handler, stopped));
        Ok(Self {
            connection,
            cli,
            contexts,
            stop,
            task: Some(task),
        })
    }

    pub(crate) fn contexts(&self) -> Contexts {
        self.contexts.clone()
    }

    pub(crate) fn child_environment(&self, environment: &Environment) -> Environment {
        let mut child = environment.clone();
        if cfg!(windows) {
            child.retain(|key, _| !key.eq_ignore_ascii_case(CONNECTION));
        }
        child.insert(
            CONNECTION.into(),
            self.connection.path.to_string_lossy().into_owned(),
        );
        if let Some(directory) = self.cli.as_deref().and_then(Path::parent) {
            let key = child
                .keys()
                .find(|key| key.eq_ignore_ascii_case("PATH"))
                .cloned()
                .unwrap_or_else(|| "PATH".into());
            let original = child.get(&key).map_or("", String::as_str);
            let mut paths = std::env::split_paths(original)
                .filter(|entry| !entry.as_os_str().is_empty())
                .collect::<Vec<_>>();
            if !paths.iter().any(|path| path == directory) {
                paths.insert(0, directory.to_owned());
            }
            if let Ok(path) = std::env::join_paths(paths) {
                child.insert(key, path.to_string_lossy().into_owned());
            }
        }
        child
    }

    pub(crate) async fn close(mut self) -> Result<()> {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            task.await??;
        }
        Ok(())
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

impl ConnectionFile {
    fn publish(&self, document: &Value) -> Result<()> {
        let parent = self
            .path
            .parent()
            .context("CLI connection document directory")?;
        cantrip_host::files::private_directory(parent)?;
        let mut file = tempfile::Builder::new()
            .prefix(".cli-connection-")
            .tempfile_in(parent)?;
        writeln!(file, "{}", document.stringify_pretty())?;
        file.as_file().sync_all()?;
        file.persist(&self.path).map_err(|error| error.error)?;
        Ok(())
    }
}

impl Drop for ConnectionFile {
    fn drop(&mut self) {
        // Keep any replacement document installed by a newer lifetime.
        let stored = crate::run_definitions::repository::read_bounded(&self.path, 16 * 1024)
            .ok()
            .and_then(|bytes| parse_json_text(&String::from_utf8_lossy(&bytes)).ok());
        if stored.is_some_and(|value| value["sessionToken"] == self.token.as_str()) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn cli_binary(environment: &Environment, cwd: &Path, worker_root: &Path) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        "cantrip.exe"
    } else {
        "cantrip"
    };
    let configured = environment
        .get("CANTRIP_CLI_BIN")
        .map(|value| cantrip_wire::text::trim(value))
        .filter(|value| !value.is_empty())
        .map(|value| cantrip_config::resolve(cwd, Path::new(value)));
    configured
        .into_iter()
        .chain([
            cwd.join("bin").join(executable),
            cwd.join("cantrip_cli/target/debug").join(executable),
            cwd.join("../cantrip_cli/target/debug").join(executable),
            worker_root.join("bin").join(executable),
            worker_root.join(executable),
        ])
        .find(|path| {
            std::fs::metadata(path).is_ok_and(|metadata| {
                if !metadata.is_file() {
                    return false;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode() & 0o111 != 0
                }
                #[cfg(not(unix))]
                true
            })
        })
}

async fn serve(
    listener: TcpListener,
    handler: Arc<Handler>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut requests = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break Ok(()),
            _ = requests.join_next(), if !requests.is_empty() => {}
            accepted = listener.accept(), if requests.len() < MAX_CONNECTIONS => match accepted {
                Ok((socket, _)) => {
                    let handler = handler.clone();
                    requests.spawn(async move {
                        let _ = http1::Builder::new()
                            .timer(TokioTimer::new())
                            .header_read_timeout(READ_TIMEOUT)
                            .keep_alive(false)
                            .serve_connection(TokioIo::new(socket), service_fn(move |request| {
                                let handler = handler.clone();
                                async move { Ok::<_, Infallible>(handler.handle(request).await) }
                            })).await;
                    });
                }
                Err(error) => break Err(error.into()),
            }
        }
    };
    drop(listener);
    requests.shutdown().await;
    result
}

impl Handler {
    async fn handle(&self, request: Request<Incoming>) -> Reply {
        let (parts, body) = request.into_parts();
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        if !token.is_some_and(|token| bool::from(token.as_bytes().ct_eq(self.token.as_bytes()))) {
            return reply(StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"}));
        }
        match (parts.method, parts.uri.path()) {
            (Method::GET, "/v1/handshake") => return reply(StatusCode::OK, self.handshake.clone()),
            (Method::POST, "/v1/execute") => {}
            _ => return reply(StatusCode::NOT_FOUND, json!({"error":"Not found"})),
        }
        let request = match read_request(body).await {
            Ok(request) => request,
            Err(error) => {
                return reply(
                    StatusCode::BAD_REQUEST,
                    json!({"code":"invalid","error":error.to_string()}),
                );
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let result = self.execute(request, &id).await;
        match result {
            Ok(result) => reply(StatusCode::OK, result),
            Err(error) => {
                if let Some(rejected) = error.downcast_ref::<server::Rejected>() {
                    let mut payload = json!({"error":rejected.message});
                    if let Some(code) = &rejected.code {
                        payload["code"] = json!(code);
                    }
                    reply(rejected.status, payload)
                } else {
                    reply(
                        StatusCode::BAD_GATEWAY,
                        json!({"code":"unavailable","error":error.to_string()}),
                    )
                }
            }
        }
    }

    async fn execute(&self, request: Value, id: &str) -> Result<Value> {
        let relay = self.server.relay(
            self.contexts
                .lookup(&request["context"]["codexThreadId"], &self.encryption),
        );
        match request["command"].as_str().context("CLI command name")? {
            "council.inventory" => {
                let identity = self.encryption.bound_identity()?;
                let mut result = relay.execute(request, id).await?;
                result["data"] = crate::protected_content::council_inventory::open(
                    &self.encryption,
                    &identity,
                    &result["data"],
                )?;
                checked("cantripCliCommandResultSchema", &result)
            }
            "run.logs" => run::logs(&relay, &self.encryption, request, id).await,
            "run.secret-set" => run::set_secret(&relay, &self.encryption, request, id).await,
            "policy.list" | "policy.read" => {
                policy::execute(&relay, &self.encryption, &request, id).await
            }
            "explorer.list" | "explorer.read" | "explorer.write" | "terminal.read"
            | "terminal.send" => surface::execute(&relay, &self.encryption, &request, id).await,
            "browser.open" => browser::open(&relay, &self.encryption, &request, id).await,
            _ => relay.execute(request, id).await,
        }
    }
}

async fn read_request(body: Incoming) -> Result<Value> {
    let body = tokio::time::timeout(READ_TIMEOUT, Limited::new(body, MAX_REQUEST).collect())
        .await
        .map_err(|_| anyhow!("CLI request body timed out."))?
        .map_err(|_| anyhow!("CLI request body is too large or could not be read."))?
        .to_bytes();
    if body.is_empty() {
        anyhow::bail!("CLI request body is required.");
    }
    let value =
        parse_json_text(&String::from_utf8_lossy(&body)).map_err(|error| anyhow!("{error}"))?;
    checked("cantripCliCommandRequestSchema", &value)
}

fn reply(status: StatusCode, value: Value) -> Reply {
    let bytes = Bytes::from(format!("{}\n", value.stringify()));
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Full::new(bytes))
        .expect("fixed CLI response headers")
}
