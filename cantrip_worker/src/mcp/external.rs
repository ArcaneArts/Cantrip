//! Third-party MCP entry points for the local Cantrip discovery profile.
use super::{rpc, shutdown_signal, stdio};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_protocol::external_mcp::{
    DiscoveryRequest, DiscoveryTool, LEGACY_VERSIONS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
    MODERN_VERSION, PATH, loopback_authority, proxy_header,
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
    net::Ipv4Addr,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::BufReader,
    net::TcpListener,
    sync::{Semaphore, mpsc},
};
use url::Url;

const USAGE: &str =
    "Usage: cantrip-worker external-mcp --server <loopback-origin> [--http-port <port>]";

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
    let http_port = match arguments.next() {
        None => None,
        Some(flag) if flag == "--http-port" => Some(
            arguments
                .next()
                .and_then(|value| value.to_str()?.parse::<u16>().ok())
                .context(USAGE)?,
        ),
        Some(_) => bail!("{USAGE}"),
    };
    ensure!(arguments.next().is_none(), "{USAGE}");
    let control = control_endpoint(&origin)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let host = Host {
            control,
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

fn control_endpoint(origin: &str) -> Result<Url> {
    let url = Url::parse(origin).context("Invalid local MCP server origin")?;
    ensure!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port_or_known_default().is_some_and(|port| port > 0)
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "External MCP discovery requires the 127.0.0.1 HTTP origin published by Cantrip Server."
    );
    Ok(url.join(PATH)?)
}

struct Host {
    control: Url,
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
    async fn call(&self, params: &Value) -> Value {
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let input = json!({"tool":params["name"],"arguments":arguments});
        let Ok(request) = DiscoveryRequest::decode(&input.stringify()) else {
            return rpc::tool_error("Unknown discovery tool or invalid arguments.");
        };
        if let Err(message) = request.validate() {
            return rpc::tool_error(message);
        }
        match self.discover(&request).await {
            Ok(payload) => json!({
                "content":vec![json!({"type":"text","text":payload["summary"]})],
                "structuredContent":payload,
            }),
            Err(error) => rpc::tool_error(error.to_string()),
        }
    }

    async fn discover(&self, request: &DiscoveryRequest) -> Result<Value> {
        let mut response = self
            .client
            .post(self.control.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .body(request.encode())
            .send()
            .await
            .context(
                "Cantrip discovery is unavailable. Check the server's external MCP listener.",
            )?;
        if response.status() == StatusCode::NOT_FOUND {
            bail!("The project or Cantrip external MCP listener is unavailable.");
        }
        ensure!(
            response.status().is_success(),
            "Cantrip discovery failed with HTTP {}.",
            response.status().as_u16()
        );
        let mut payload = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                payload.len().saturating_add(chunk.len()) <= MAX_RESPONSE_BYTES,
                "Cantrip discovery response is too large. Retry with a smaller limit."
            );
            payload.extend_from_slice(&chunk);
        }
        let result = parse_json_text(std::str::from_utf8(&payload)?)
            .map_err(|_| anyhow::anyhow!("Invalid Cantrip discovery response."))?;
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
            "tools/list" => json!({"tools":profile()["tools"]}),
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
