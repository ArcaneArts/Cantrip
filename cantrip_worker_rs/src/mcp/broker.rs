use anyhow::{Result, anyhow, bail};
use cantrip_protocol::{date_milliseconds, mcp_host};
use cantrip_wire::{Value, parse_json_text, value::json};
use reqwest::{Client, Method, Url, header};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
    time::Duration,
};

const MAXIMUM_RESPONSE: usize = 512 * 1024;
const DEADLINE: Duration = Duration::from_secs(55);

pub(super) fn operation_timeout(operation: &str) -> Option<Duration> {
    (!matches!(operation, "web.session.pointer" | "task.wait")).then_some(DEADLINE)
}

#[derive(Clone)]
pub(super) struct Broker {
    http: Client,
    document: Value,
    endpoint: Url,
    expires_at: i64,
}

impl Broker {
    pub(super) async fn connect(path: &Path) -> Result<Self> {
        let mut source = String::new();
        private_document(path)?.read_to_string(&mut source)?;
        let value = parse_json_text(&source)
            .map_err(|_| anyhow!("Invalid Cantrip MCP connection document JSON."))?;
        let document = mcp_host::parse("cantripMcpConnectionDocumentSchema", Some(&value))
            .map_err(|_| anyhow!("Invalid Cantrip MCP connection document."))?;
        let endpoint = Url::parse(document["endpoint"].as_str().unwrap())?;
        if endpoint.scheme() != "http"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            bail!("Cantrip MCP broker endpoint is not an authorized loopback URL.");
        }
        let expires_at = document["expiresAt"]
            .as_js_string()
            .and_then(date_milliseconds)
            .ok_or_else(|| anyhow!("Invalid Cantrip MCP binding expiry."))?;
        let broker = Self {
            http: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()?,
            document,
            endpoint,
            expires_at,
        };
        broker.assert_current()?;
        let receipt = broker
            .request(
                Method::GET,
                &format!(
                    "/v1/bindings/{}",
                    broker.document["bindingId"].as_str().unwrap()
                ),
                None,
                Some(DEADLINE),
                MAXIMUM_RESPONSE,
            )
            .await?;
        if ["protocolVersion", "bindingId", "expiresAt"]
            .iter()
            .any(|key| receipt[*key] != broker.document[*key])
        {
            bail!("Cantrip MCP broker handshake did not match the binding.");
        }
        Ok(broker)
    }

    fn assert_current(&self) -> Result<()> {
        if self.expires_at <= chrono::Utc::now().timestamp_millis() {
            bail!("Cantrip MCP binding has expired.");
        }
        Ok(())
    }

    pub(super) async fn call(&self, operation: &str, arguments: Value) -> Result<Value> {
        self.assert_current()?;
        let request = json!({
            "bindingId":self.document["bindingId"],
            "request":json!({"operation":operation,"arguments":arguments}),
        });
        let request = mcp_host::parse("cantripMcpBrokerOperationRequestSchema", Some(&request))
            .map_err(|_| anyhow!("Cantrip MCP result validation failed."))?;
        let value = self
            .request(
                Method::POST,
                "/v1/execute",
                Some(request),
                operation_timeout(operation),
                MAXIMUM_RESPONSE,
            )
            .await?;
        mcp_host::parse("cantripAgentOperationResultSchema", Some(&value))
            .map_err(|_| anyhow!("Cantrip MCP result validation failed."))
    }

    pub(super) async fn call_cua(&self, request: Value) -> Result<Value> {
        self.assert_current()?;
        let request = mcp_host::parse(
            "cuaMcpBrokerRequestSchema",
            Some(&json!({"bindingId":self.document["bindingId"],"request":request})),
        )
        .map_err(|_| {
            anyhow!("CUA requires a bounded request and actual Codex thread/turn metadata.")
        })?;
        self.request(
            Method::POST,
            "/v1/computer-use",
            Some(request),
            None,
            super::cua::MAXIMUM_RESPONSE,
        )
        .await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        timeout: Option<Duration>,
        maximum_response: usize,
    ) -> Result<Value> {
        let url = self.endpoint.join(path)?;
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(self.document["credential"].as_str().unwrap());
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(body) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(body.stringify());
        }
        let mut response = request.send().await.map_err(transport_error)?;
        if response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|len| len > maximum_response)
        {
            bail!("Cantrip MCP response is too large.");
        }
        let status = response.status();
        let mut raw = Vec::new();
        while let Some(data) = response.chunk().await.map_err(transport_error)? {
            if data.len() > maximum_response - raw.len() {
                bail!("Cantrip MCP response is too large.");
            }
            raw.extend_from_slice(&data);
        }
        if raw.is_empty() {
            bail!("Cantrip MCP response body is empty.");
        }
        let value = parse_json_text(&String::from_utf8_lossy(&raw))
            .map_err(|_| anyhow!("Cantrip MCP broker returned invalid JSON."))?;
        if !status.is_success() {
            return Err(match value["error"].as_js_string() {
                Some(message) => anyhow!("{}", message.lossy()),
                None => anyhow!("Cantrip MCP broker failed with HTTP {}.", status.as_u16()),
            });
        }
        Ok(value)
    }
}

fn transport_error(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!("The operation was aborted due to timeout")
    } else {
        anyhow!("fetch failed")
    }
}

fn private_document(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT opens the link itself.
        options.custom_flags(0x00200000);
    }
    let source = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return anyhow!("Cantrip MCP connection document must be a regular file.");
        }
        anyhow!("Could not open Cantrip MCP connection document: {error}")
    })?;
    let metadata = source.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("Cantrip MCP connection document must be a regular file.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            bail!("Cantrip MCP connection document permissions are unsafe.");
        }
        if metadata.uid() != unsafe { libc::getuid() } {
            bail!("Cantrip MCP connection document has the wrong owner.");
        }
    }
    Ok(source)
}
