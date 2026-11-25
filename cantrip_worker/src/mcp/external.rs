//! Third-party MCP entry points for the local Cantrip discovery profile.
use super::{rpc, shutdown_signal, stdio};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_protocol::external_mcp::{
    DiscoveryRequest, DiscoveryTool, HOSTED_CAPABILITIES_PATH, HOSTED_DISCOVERY_PATH,
    HOSTED_RELAY_PATH, LEGACY_VERSIONS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MODERN_VERSION,
    PATH, WORKER_CONTEXT_TOOL, WorkerContextInput, loopback_authority, proxy_header,
    valid_integration_credential, worker_context_tool,
};
use cantrip_wire::{Value, parse_json_text, value::json};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Incoming},
    header,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use std::{
    convert::Infallible,
    ffi::OsString,
    io::Read as _,
    net::Ipv4Addr,
    path::Path,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::BufReader,
    net::TcpListener,
    sync::{Semaphore, mpsc},
};
use url::Url;
use zeroize::Zeroizing;

mod relay;

const USAGE: &str = "Usage: cantrip-worker external-mcp --server <origin> [--http-port <port> | --credential-file <path>]";

pub(super) fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<()> {
    let mut arguments = arguments.into_iter();
    let Some(flag) = arguments.next() else {
        bail!("{USAGE}");
    };
    if flag == "--help" || flag == "-h" {
        println!("{USAGE}");
        return Ok(());
    }
    ensure!(flag == "--server", "{USAGE}");
    let origin = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .context(USAGE)?;
    let (http_port, credential) = match arguments.next() {
        None => (None, None),
        Some(flag) if flag == "--http-port" => (
            Some(
                arguments
                    .next()
                    .and_then(|value| value.to_str()?.parse::<u16>().ok())
                    .context(USAGE)?,
            ),
            None,
        ),
        Some(flag) if flag == "--credential-file" => {
            let path = arguments.next().context(USAGE)?;
            (None, Some(read_credential(Path::new(&path))?))
        }
        Some(_) => bail!("{USAGE}"),
    };
    ensure!(arguments.next().is_none(), "{USAGE}");
    let origin = server_origin(&origin, credential.is_some())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let host = Host {
            origin,
            credential,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()?,
        };
        tokio::select! {
            result = async {
                match http_port {
                    Some(port) => host.serve_http(port).await,
                    None => host.serve_stdio().await,
                }
            } => result,
            result = shutdown_signal() => result,
        }
    });
    // stdin can still be blocked in an OS read when the parent sends a signal.
    runtime.shutdown_background();
    result
}

fn read_credential(path: &Path) -> Result<Zeroizing<String>> {
    let mut credential = Zeroizing::new(String::new());
    super::broker::private_document(path)?
        .take(256)
        .read_to_string(&mut credential)?;
    let length = credential.trim_end_matches(['\r', '\n']).len();
    credential.truncate(length);
    ensure!(
        valid_integration_credential(&credential),
        "Invalid Cantrip MCP integration credential file."
    );
    Ok(credential)
}

fn server_origin(origin: &str, hosted: bool) -> Result<Url> {
    let url = Url::parse(origin).context("Invalid Cantrip MCP server origin")?;
    let loopback = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    ensure!(
        (loopback || (hosted && url.scheme() == "https" && url.host_str().is_some()))
            && url.port_or_known_default().is_some_and(|port| port > 0)
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Use the Cantrip loopback origin for local MCP or a Cantrip HTTPS origin with an integration credential."
    );
    Ok(url)
}

struct Host {
    origin: Url,
    credential: Option<Zeroizing<String>>,
    client: reqwest::Client,
}

fn profile() -> &'static Value {
    static PROFILE: OnceLock<Value> = OnceLock::new();
    PROFILE.get_or_init(|| json!({
        "serverInfo":json!({"name":"cantrip-external","title":"Cantrip external MCP","version":crate::version::value()["version"]}),
        "capabilities":json!({"tools":json!({"listChanged":false})}),
        "instructions":"Find a project with project_list, then use agent_list to find its Cantrip agent chats. Use placement_list to check the exact worker and worktree.",
        "tools":DiscoveryTool::ALL.map(|tool| Value::from_serialize(&tool.definition())),
    }))
}

impl Host {
    fn request(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder> {
        let request = self.client.request(method, self.origin.join(path)?);
        Ok(match &self.credential {
            Some(credential) => request.bearer_auth(credential.as_str()),
            None => request,
        })
    }

    async fn tools(&self) -> Result<Value> {
        if self.credential.is_none() {
            return Ok(profile()["tools"].clone());
        }
        let payload = response_payload(
            self.request(Method::GET, HOSTED_CAPABILITIES_PATH)?
                .send()
                .await?,
        )
        .await?;
        let allowed = payload["tools"]
            .as_array()
            .context("Invalid Cantrip integration capabilities")?;
        let tools = profile()["tools"]
            .as_array()
            .expect("external MCP tool catalog");
        let mut scoped: Vec<_> = tools
            .iter()
            .filter(|tool| allowed.contains(&tool["name"]))
            .cloned()
            .collect();
        if allowed.contains(&json!(WORKER_CONTEXT_TOOL)) {
            scoped.push(Value::from_serialize(&worker_context_tool()));
        }
        Ok(Value::Array(scoped))
    }

    async fn call(&self, params: &Value) -> Value {
        let result = if params["name"] == WORKER_CONTEXT_TOOL {
            self.worker_context(&params["arguments"]).await
        } else {
            self.call_discovery(params).await
        };
        match result {
            Ok(payload) => json!({
                "content":vec![json!({"type":"text","text":payload["summary"]})],
                "structuredContent":payload,
            }),
            Err(error) => rpc::tool_error(error.to_string()),
        }
    }

    async fn worker_context(&self, arguments: &Value) -> Result<Value> {
        let credential = self
            .credential
            .as_deref()
            .context("Worker context requires an external MCP integration credential.")?;
        let input: WorkerContextInput =
            cantrip_protocol::external_mcp::parse_worker_context(&arguments.stringify())
                .map_err(|_| anyhow::anyhow!("Enter a Cantrip project ID."))?;
        input.validate().map_err(anyhow::Error::msg)?;
        let opened = response_payload(
            self.request(Method::POST, HOSTED_RELAY_PATH)?
                .header(header::CONTENT_TYPE, "application/json")
                .body(arguments.stringify())
                .send()
                .await?,
        )
        .await?;
        let session = relay::session_id(&opened)?;
        let path = format!("{HOSTED_RELAY_PATH}/{session}");
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            relay::worker_context(
                self.origin.join(&path)?,
                credential,
                &opened,
                &input.project_id,
            ),
        )
        .await;
        let _ = self
            .request(Method::DELETE, &path)?
            .timeout(Duration::from_secs(3))
            .send()
            .await;
        result.context("The assigned worker did not respond in time.")?
    }

    async fn call_discovery(&self, params: &Value) -> Result<Value> {
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let input = json!({"tool":params["name"],"arguments":arguments});
        let Ok(request) = DiscoveryRequest::decode(&input.stringify()) else {
            bail!("Unknown discovery tool or invalid arguments.");
        };
        if let Err(message) = request.validate() {
            bail!(message);
        }
        self.discover(&request).await
    }

    async fn discover(&self, request: &DiscoveryRequest) -> Result<Value> {
        let path = if self.credential.is_some() {
            HOSTED_DISCOVERY_PATH
        } else {
            PATH
        };
        let response = self
            .request(Method::POST, path)?
            .header(header::CONTENT_TYPE, "application/json")
            .body(request.encode())
            .send()
            .await
            .context(
                "Cantrip discovery is unavailable. Check the server's external MCP listener.",
            )?;
        let result = response_payload(response).await?;
        ensure!(
            result["summary"].is_string()
                && result["entries"]
                    .as_array()
                    .is_some_and(|entries| entries.len() <= usize::from(request.arguments.limit))
                && result.get("nextCursor").is_some()
                && result["sourceTruncated"].as_bool().is_some(),
            "Invalid Cantrip discovery response."
        );
        Ok(result)
    }

    async fn handle(&self, frame: &Value) -> Option<Value> {
        if !valid_frame(frame) {
            return Some(rpc::rpc_error(
                &Value::Null,
                -32600,
                "Invalid JSON-RPC request",
            ));
        }
        let id = frame.get("id")?;
        let params = &frame["params"];
        let method = frame["method"].as_str()?;
        let meta = &params["_meta"];
        let version = meta["io.modelcontextprotocol/protocolVersion"].as_str();
        let modern = method == "server/discover" || version.is_some();
        if modern {
            let Some(version) = version else {
                return Some(rpc::rpc_error(
                    id,
                    -32602,
                    "MCP request metadata requires a protocol version",
                ));
            };
            if version != MODERN_VERSION {
                return Some(unsupported_version(id, version));
            }
            let client = &meta["io.modelcontextprotocol/clientInfo"];
            if !client["name"].is_string()
                || !client["version"].is_string()
                || !meta["io.modelcontextprotocol/clientCapabilities"].is_object()
            {
                return Some(rpc::rpc_error(id, -32602, "Invalid MCP client metadata"));
            }
        }
        let mut payload = match method {
            "server/discover" => json!({
                "supportedVersions":supported_versions(),
                "capabilities":profile()["capabilities"],
                "instructions":profile()["instructions"],
                "_meta":json!({"io.modelcontextprotocol/serverInfo":profile()["serverInfo"]}),
                "ttlMs":0,"cacheScope":"private",
            }),
            "initialize" if !modern => {
                return Some(rpc::initialize_profile(id, params, profile(), |version| {
                    json!(
                        LEGACY_VERSIONS
                            .iter()
                            .copied()
                            .find(|supported| *supported == version)
                            .unwrap_or(LEGACY_VERSIONS[0])
                    )
                }));
            }
            "ping" => json!({}),
            "tools/list" => match self.tools().await {
                Ok(tools) => json!({"tools":tools}),
                Err(error) => return Some(rpc::rpc_error(id, -32000, &error.to_string())),
            },
            "tools/call" => self.call(params).await,
            _ => return Some(rpc::rpc_error(id, -32601, "Method not found")),
        };
        if modern {
            payload["resultType"] = json!("complete");
        }
        Some(rpc::result(id, payload))
    }

    async fn serve_stdio(&self) -> Result<()> {
        let (sender, mut frames) = mpsc::channel(8);
        let reader = tokio::spawn(stdio::read_frames(
            BufReader::new(tokio::io::stdin()),
            sender,
            MAX_REQUEST_BYTES,
        ));
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = frames.recv().await {
            if let Some(reply) = self.handle(&frame).await {
                stdio::write_frame(&mut stdout, reply, true).await?;
            }
        }
        reader.await??;
        Ok(())
    }

    async fn serve_http(self, port: u16) -> Result<()> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
        let address = listener.local_addr()?;
        eprintln!("Cantrip external MCP listening on http://{address}/mcp");
        let host = Arc::new(self);
        let connections = Arc::new(Semaphore::new(16));
        loop {
            let permit = connections.clone().acquire_owned().await?;
            let (socket, _) = listener.accept().await?;
            let host = host.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let connection = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .serve_connection(
                        TokioIo::new(socket),
                        service_fn(|request| async {
                            Ok::<_, Infallible>(host.http_request(address.port(), request).await)
                        }),
                    );
                let _ = tokio::time::timeout(Duration::from_secs(20), connection).await;
            });
        }
    }

    async fn http_request(&self, port: u16, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let headers = request.headers();
        let origin = headers
            .get(header::ORIGIN)
            .map(|value| value.to_str().unwrap_or("invalid"));
        if headers.get_all(header::HOST).iter().count() != 1
            || headers.get_all(header::ORIGIN).iter().count() > 1
            || headers.keys().any(|name| proxy_header(name.as_str()))
            || !headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|host| loopback_authority(host, origin, port))
        {
            return reply(StatusCode::FORBIDDEN, None);
        }
        if request.uri().path() != "/mcp" || request.uri().query().is_some() {
            return reply(StatusCode::NOT_FOUND, None);
        }
        if request.method() != Method::POST {
            let mut response = reply(StatusCode::METHOD_NOT_ALLOWED, None);
            response
                .headers_mut()
                .insert(header::ALLOW, header::HeaderValue::from_static("POST"));
            return response;
        }
        if !headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
        {
            return reply(StatusCode::UNSUPPORTED_MEDIA_TYPE, None);
        }
        let (parts, body) = request.into_parts();
        let Ok(body) = Limited::new(body, MAX_REQUEST_BYTES).collect().await else {
            return reply(StatusCode::PAYLOAD_TOO_LARGE, None);
        };
        let body = body.to_bytes();
        let Some(frame) = std::str::from_utf8(&body)
            .ok()
            .and_then(|body| parse_json_text(body).ok())
        else {
            return reply(
                StatusCode::BAD_REQUEST,
                Some(rpc::rpc_error(&Value::Null, -32700, "Parse error")),
            );
        };
        if !valid_frame(&frame) {
            return reply(
                StatusCode::BAD_REQUEST,
                Some(rpc::rpc_error(
                    &Value::Null,
                    -32600,
                    "Invalid JSON-RPC request",
                )),
            );
        }
        let null = Value::Null;
        let id = frame.get("id").unwrap_or(&null);
        let version = header_text(&parts.headers, "mcp-protocol-version");
        let method = frame["method"].as_str().expect("validated method");
        let params = &frame["params"];
        let body_version = params["_meta"]["io.modelcontextprotocol/protocolVersion"].as_str();
        let modern = version == Some(MODERN_VERSION)
            || body_version.is_some()
            || method == "server/discover";
        if let Some(version) = version
            && version != MODERN_VERSION
            && !LEGACY_VERSIONS.contains(&version)
        {
            return reply(
                StatusCode::BAD_REQUEST,
                Some(unsupported_version(id, version)),
            );
        }
        if (version.is_none() && parts.headers.contains_key("mcp-protocol-version"))
            || (modern
                && (version != body_version
                    || version.is_none()
                    || header_text(&parts.headers, "mcp-method") != Some(method)
                    || (method == "tools/call" && !name_matches(&parts.headers, &params["name"]))))
        {
            return reply(
                StatusCode::BAD_REQUEST,
                Some(rpc::rpc_error(
                    id,
                    -32020,
                    "Missing or mismatched MCP request headers",
                )),
            );
        }
        match self.handle(&frame).await {
            Some(response) => {
                let status = match (modern, response["error"]["code"].as_i64()) {
                    (true, Some(-32601)) => StatusCode::NOT_FOUND,
                    (true, Some(-32602 | -32022)) => StatusCode::BAD_REQUEST,
                    _ => StatusCode::OK,
                };
                reply(status, Some(response))
            }
            None => reply(StatusCode::ACCEPTED, None),
        }
    }
}

async fn response_payload(mut response: reqwest::Response) -> Result<Value> {
    match response.status() {
        StatusCode::UNAUTHORIZED => {
            bail!("The Cantrip integration credential is invalid, expired, or revoked.")
        }
        StatusCode::FORBIDDEN => bail!("The Cantrip integration does not have the required scope."),
        StatusCode::NOT_FOUND => {
            bail!("The project or Cantrip external MCP endpoint is unavailable.")
        }
        StatusCode::CONFLICT => {
            bail!("The assigned worker or project placement changed or is unavailable.")
        }
        status if !status.is_success() => {
            bail!("Cantrip discovery failed with HTTP {}.", status.as_u16())
        }
        _ => {}
    }
    let mut payload = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            payload.len().saturating_add(chunk.len()) <= MAX_RESPONSE_BYTES,
            "Cantrip discovery response is too large. Retry with a smaller limit."
        );
        payload.extend_from_slice(&chunk);
    }
    parse_json_text(std::str::from_utf8(&payload)?)
        .map_err(|_| anyhow::anyhow!("Invalid Cantrip discovery response."))
}

fn valid_frame(frame: &Value) -> bool {
    frame["jsonrpc"] == "2.0"
        && frame["method"].is_string()
        && frame
            .get("id")
            .is_none_or(|id| id.is_string() || id.as_i64().is_some())
}

fn reply(status: StatusCode, payload: Option<Value>) -> Response<Full<Bytes>> {
    let response = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    let (response, body) = match payload {
        Some(value) => (
            response.header(header::CONTENT_TYPE, "application/json"),
            Bytes::from(value.stringify_unicode_scalars()),
        ),
        None => (response, Bytes::new()),
    };
    response
        .body(Full::new(body))
        .expect("static MCP response headers")
}

fn header_text<'a>(headers: &'a hyper::HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

fn name_matches(headers: &hyper::HeaderMap, name: &Value) -> bool {
    let Some(header) = header_text(headers, "mcp-name") else {
        return false;
    };
    if let Some(encoded) = header
        .strip_prefix("=?base64?")
        .and_then(|body| body.strip_suffix("?="))
    {
        return name.as_str().is_some_and(|name| {
            STANDARD
                .decode(encoded)
                .is_ok_and(|bytes| bytes == name.as_bytes())
        });
    }
    name == header
}

fn unsupported_version(id: &Value, requested: &str) -> Value {
    json!({
        "jsonrpc":"2.0","id":id,
        "error":json!({"code":-32022,"message":"Unsupported protocol version","data":json!({
            "supported":supported_versions(),"requested":requested,
        })}),
    })
}

fn supported_versions() -> Vec<&'static str> {
    std::iter::once(MODERN_VERSION)
        .chain(LEGACY_VERSIONS.iter().copied())
        .collect()
}
