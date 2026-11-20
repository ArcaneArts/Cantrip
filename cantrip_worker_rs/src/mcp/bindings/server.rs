use anyhow::{Context, Result, anyhow, bail, ensure};
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
    pub compact: bool,
    pub policy_list: bool,
    pub policy_read: bool,
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
                compact: false,
                policy_list: false,
                policy_read: false,
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
            compact: operations.iter().any(|op| op == "context.compact"),
            policy_list: operations.iter().any(|op| op == "policy.list"),
            policy_read: operations.iter().any(|op| op == "policy.read"),
        })
    }

    pub(super) async fn context(
        &self,
        binding: Value,
        version: u64,
        legacy_root: Option<&Value>,
        request: Value,
        request_id: &str,
    ) -> Result<Value> {
        let result = self
            .invoke(binding, version, legacy_root, request, request_id)
            .await?;
        crate::http::checked("cantripMcpContextGetResultSchema", &result)
            .map_err(|_| anyhow!("Cantrip MCP operation validation failed on the worker."))
    }

    pub(super) async fn authorize_compaction(
        &self,
        binding: &Value,
        version: u64,
        legacy_root: Option<&Value>,
        request: Value,
    ) -> Result<()> {
        let result = self
            .invoke(
                binding.clone(),
                version,
                legacy_root,
                request,
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        let result = mcp_host::parse("cantripAgentOperationResultSchema", Some(&result))
            .map_err(response_error)?;
        ensure!(
            result["mutated"] == true && result["worktreeId"] == binding["worktreeId"],
            "Cantrip did not authorize compaction for the current worktree."
        );
        Ok(())
    }

    pub(super) async fn inspect_browser(
        &self,
        mut binding: Value,
        version: u64,
        legacy_root: Option<&Value>,
        target: Value,
        bound_server: &JsString,
    ) -> Result<crate::browser_surface::AgentTarget> {
        ensure!(
            target["kind"] == "surface"
                && target["surfaceKind"] == "browser"
                && target["projectId"] == binding["projectId"],
            "The Browser target is outside this execution scope."
        );
        let mut delegated = binding["allowedOperations"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !delegated.iter().any(|op| op == "target.inspect") {
            delegated.push(json!("target.inspect"));
        }
        binding["allowedOperations"] = Value::Array(delegated);
        let result = self
            .invoke(
                binding.clone(),
                version,
                legacy_root,
                json!({"operation":"target.inspect","arguments":json!({"target":target})}),
                &format!("{}:inspect-target", uuid::Uuid::new_v4()),
            )
            .await?;
        let mut details = result["data"]
            .as_object()
            .cloned()
            .context("Cantrip returned a malformed browser target.")?;
        let server = details
            .shift_remove(&JsString::from("serverId"))
            .unwrap_or(Value::Null);
        details.shift_remove(&JsString::from("stateRevision"));
        let resolution =
            crate::http::checked("executionTargetResolutionSchema", &Value::Object(details))?;
        ensure!(
            result["target"] == target
                && resolution["target"] == target
                && resolution["availability"] == "available"
                && resolution["worker"]["workerId"] == binding["workerId"]
                && resolution["placement"]["workerId"] == binding["workerId"]
                && resolution["placement"]["projectId"] == target["projectId"]
                && resolution["placement"]["surface"]["kind"] == "browser"
                && resolution["placement"]["surface"]["id"] == target["surfaceId"]
                && server.as_js_string() == Some(bound_server),
            "The browser target cannot receive protected operations."
        );
        Ok(crate::browser_surface::AgentTarget {
            surface: target["surfaceId"]
                .as_js_string()
                .cloned()
                .context("Missing Browser target identity.")?,
            owner: binding["ownerId"]
                .as_js_string()
                .cloned()
                .context("Missing Browser owner.")?,
            project: target["projectId"].clone(),
            server,
        })
    }

    pub(super) async fn invoke(
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
            binding["allowedOperations"] = json!(vec![request["operation"].clone()]);
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
        body(response, MAXIMUM_RESPONSE).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::{
        Request, Response as Reply, body::Incoming, server::conn::http1, service::service_fn,
    };
    use hyper_util::rt::TokioIo;
    use std::convert::Infallible;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn inspect_uses_the_active_binding_and_verifies_the_returned_placement() -> Result<()> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let url = format!("http://{}", listener.local_addr()?);
        let task = tokio::spawn(async move {
            for worker in ["worker", "other-worker"] {
                let (socket, _) = listener.accept().await?;
                http1::Builder::new()
                    .keep_alive(false)
                    .serve_connection(
                        TokioIo::new(socket),
                        service_fn(move |request: Request<Incoming>| async move {
                            assert_eq!(request.uri().path(), ENDPOINT);
                            assert_eq!(request.headers()["authorization"], "Bearer fixture");
                            let bytes = request.into_body().collect().await.unwrap().to_bytes();
                            let input =
                                parse_json_text(std::str::from_utf8(&bytes).unwrap()).unwrap();
                            assert_eq!(input["binding"]["executionLaneId"], "lane");
                            assert_eq!(input["binding"]["ownerId"], "owner");
                            assert_eq!(input["request"]["operation"], "target.inspect");
                            assert!(
                                input["binding"]["allowedOperations"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .any(|operation| operation == "target.inspect")
                            );
                            let target = &input["request"]["arguments"]["target"];
                            let data = json!({
                                "target":target,
                                "placement":json!({"projectId":"project","workerId":worker,
                                    "projectReplicaId":Value::Null,"worktreeId":Value::Null,
                                    "surface":json!({"kind":"browser","id":"browser"})}),
                                "worker":json!({"workerId":worker,"name":"Fixture","online":true}),
                                "availability":"available","unavailableReason":Value::Null,
                                "serverId":"server","stateRevision":1,
                            });
                            let answer =
                                json!({"summary":"Browser available","target":target,"data":data});
                            Ok::<_, Infallible>(Reply::new(Full::new(Bytes::from(
                                answer.stringify(),
                            ))))
                        }),
                    )
                    .await?;
            }
            Ok::<_, anyhow::Error>(())
        });
        let server = Server::new(&url, Arc::new(|| Ok("fixture".to_owned())))?;
        let target = json!({"kind":"surface","projectId":"project","surfaceId":"browser","surfaceKind":"browser"});
        let binding = json!({
            "bindingId":uuid::Uuid::new_v4().to_string(), "ownerId":"owner", "workerId":"worker",
            "executionLaneId":"lane", "chatId":"chat", "projectId":"project", "contextKind":"project",
            "worktreeId":"worktree","rootKind":"git-worktree","scratchRootId":Value::Null,
            "permissionProfileId":":workspace", "allowedOperations":vec!["web.session.open"],
            "issuedAt":"2026-01-01T00:00:00.000Z", "expiresAt":"2026-01-01T01:00:00.000Z",
        });
        let admitted = server
            .inspect_browser(binding.clone(), 2, None, target.clone(), &"server".into())
            .await?;
        assert_eq!(admitted.surface.as_str(), Some("browser"));
        let refused = server
            .inspect_browser(binding, 2, None, target, &"server".into())
            .await
            .err()
            .unwrap();
        assert!(
            refused
                .to_string()
                .contains("cannot receive protected operations")
        );
        task.await??;
        Ok(())
    }
}
