use anyhow::{Context, Result, anyhow, bail};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use reqwest::{Client, Response, Url, header};
use std::{sync::Arc, time::Duration};

const ENDPOINT: &str = "/api/internal/agent-operations";
const MAXIMUM_RESPONSE: usize = 8 * 1024 * 1024;
const MAXIMUM_CAPABILITIES: usize = 256 * 1024;

pub type WorkerToken = Arc<dyn Fn() -> Result<String> + Send + Sync>;

#[derive(Clone)]
pub struct Server {
    http: Client,
    endpoint: Url,
    token: WorkerToken,
}

#[derive(Clone)]
pub(super) struct Capabilities {
    pub version: u64,
    pub context: bool,
}

#[derive(Debug)]
pub(super) struct Rejected {
    pub status: u16,
    pub code: Option<JsString>,
    pub message: JsString,
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message.lossy())
    }
}

impl std::error::Error for Rejected {}

impl Server {
    pub fn new(server_url: &str, token: WorkerToken) -> Result<Self> {
        Ok(Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint: Url::parse(server_url)?.join(ENDPOINT)?,
            token,
        })
    }

    pub(super) async fn capabilities(&self, worker: &JsString) -> Result<Capabilities> {
        let mut url = self
            .endpoint
            .join("/api/internal/agent-operations/capabilities")?;
        url.query_pairs_mut()
            .append_pair("workerId", &worker.lossy());
        let response = self
            .http
            .get(url)
            .bearer_auth((self.token)()?)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| anyhow!("Cantrip MCP capability request failed."))?;
        if response.status().as_u16() == 404 {
            return Ok(Capabilities {
                version: 1,
                context: true,
            });
        }
        let response = body(response, MAXIMUM_CAPABILITIES).await?;
        let capabilities =
            mcp_host::parse("workerCantripMcpServerCapabilitiesSchema", Some(&response))
                .map_err(response_error)?;
        let versions = capabilities["bindingProtocolVersions"].as_array().unwrap();
        let version = [2, 1]
            .into_iter()
            .find(|version| {
                versions
                    .iter()
                    .any(|candidate| candidate.as_u64() == Some(*version))
            })
            .context("The Cantrip server does not support a compatible MCP binding protocol.")?;
        let operations = capabilities["operations"].as_array().unwrap();
        Ok(Capabilities {
            version,
            context: operations.iter().any(|op| op == "context.get"),
        })
    }

    pub(super) async fn context(
        &self,
        mut binding: Value,
        version: u64,
        legacy_root: Option<&Value>,
        request: Value,
        request_id: &str,
    ) -> Result<Value> {
        let mut call = crate::http::checked(
            "workerCantripMcpOperationCallSchema",
            &json!({"binding":binding,"request":request,"requestId":request_id}),
        )?;
        if version == 1 {
            binding["canonicalRoot"] = legacy_root
                .context("Legacy MCP context requires a protected root handle.")?
                .clone();
            // The v1 server accepts only the historical startup operations.
            binding["allowedOperations"] = json!(vec!["context.get"]);
            call["binding"] = binding;
        }
        let response = self
            .http
            .post(self.endpoint.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .bearer_auth((self.token)()?)
            .body(call.stringify())
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| anyhow!("Cantrip MCP operation request failed."))?;
        let result = body(response, MAXIMUM_RESPONSE).await?;
        crate::http::checked("cantripMcpContextGetResultSchema", &result)
            .map_err(|_| anyhow!("Cantrip MCP operation validation failed on the worker."))
    }
}

async fn body(mut response: Response, maximum: usize) -> Result<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        bail!("Cantrip MCP response is too large.");
    }
    let mut raw = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("Cantrip MCP response could not be read."))?
    {
        if maximum - raw.len() < chunk.len() {
            bail!("Cantrip MCP response is too large.");
        }
        raw.extend_from_slice(&chunk);
    }
    let value = parse_json_text(&String::from_utf8_lossy(&raw))
        .map_err(|_| anyhow!("Cantrip MCP server returned invalid JSON."))?;
    let status = response.status();
    if !status.is_success() {
        return Err(Rejected {
            status: status.as_u16(),
            code: value["code"].as_js_string().cloned(),
            message: value["error"].as_js_string().cloned().unwrap_or_else(|| {
                format!(
                    "Cantrip MCP operation failed with HTTP {}.",
                    status.as_u16()
                )
                .into()
            }),
        }
        .into());
    }
    Ok(value)
}
