//! Connect a prepared broker lane to the runtime that owns each native turn.
use crate::{
    http::checked,
    metadata::{Abort, Signal},
};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value};
use futures::future::BoxFuture;
use std::sync::Arc;

pub(crate) struct Authority {
    server: super::Server,
    binding: Value,
    server_id: JsString,
    pub(crate) captured: Value,
}

impl Authority {
    pub(super) fn new(
        server: super::Server,
        binding: Value,
        server_id: JsString,
        raw: &Value,
    ) -> Result<Self> {
        let captured = checked_authority(raw, &binding, &server_id)?;
        Ok(Self {
            server,
            binding,
            server_id,
            captured,
        })
    }

    pub(crate) async fn current(&self) -> Result<bool> {
        let raw = self.server.computer_use_authority(&self.binding).await;
        match raw {
            Ok(raw) => Ok(checked_authority(&raw, &self.binding, &self.server_id)
                .ok()
                .as_ref()
                == Some(&self.captured)),
            Err(error)
                if error
                    .downcast_ref::<super::server::Rejected>()
                    .is_some_and(|error| matches!(error.status, 401 | 403 | 409)) =>
            {
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
}

/// The native runtime is responsible for observing and retiring its own turns.
/// Model metadata selects an observed identity and cannot establish ownership.
pub trait ComputerUseExecutor: Send + Sync {
    fn owns_turn(&self, thread: &JsString, turn: &JsString) -> bool;

    fn begin_call(&self, _request_id: uuid::Uuid) {}

    fn execute(
        &self,
        request: Value,
        request_id: uuid::Uuid,
        signal: Signal,
    ) -> BoxFuture<'_, Result<Value>>;
}

pub(super) struct Execution {
    pub(super) authority: Value,
    pub(super) executor: Arc<dyn ComputerUseExecutor>,
    revoke: Abort,
    pub(super) revoked: Signal,
}

impl Execution {
    pub(super) fn new(authority: Value, executor: Arc<dyn ComputerUseExecutor>) -> Self {
        let (revoke, revoked) = Abort::new();
        Self {
            authority,
            executor,
            revoke,
            revoked,
        }
    }

    pub(super) fn revoke(&self) {
        self.revoke
            .abort(anyhow::anyhow!("Computer-use authority changed."));
    }

    pub(super) fn owns(&self, request: &Value) -> bool {
        self.revoked.check().is_ok()
            && request["threadId"]
                .as_js_string()
                .zip(request["turnId"].as_js_string())
                .is_some_and(|(thread, turn)| self.executor.owns_turn(thread, turn))
    }
}

pub(super) fn checked_authority(raw: &Value, binding: &Value, server: &JsString) -> Result<Value> {
    let authority = checked("cuaAgentAuthoritySchema", raw)?;
    let placement = if binding["contextKind"] == "project" {
        "worktreeId"
    } else {
        "scratchRootId"
    };
    ensure!(
        authority["serverId"].as_js_string() == Some(server)
            && authority["placementId"] == binding[placement]
            && [
                "ownerId",
                "workerId",
                "chatId",
                "contextKind",
                "projectId",
                "executionLaneId"
            ]
            .iter()
            .all(|key| authority[*key] == binding[*key]),
        "Computer-use authority belongs to another execution context."
    );
    Ok(authority)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::bindings::{Broker, Server};
    use anyhow::anyhow;
    use bytes::Bytes;
    use cantrip_wire::{parse_json_text, value::json};
    use http_body_util::{BodyExt, Full};
    use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
    use hyper_util::rt::TokioIo;
    use std::{
        convert::Infallible,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio::{net::TcpListener, sync::Notify, time::timeout};

    #[derive(Default)]
    struct NativeTurn {
        executions: AtomicUsize,
        started: Notify,
        cancelled: Arc<Notify>,
        observation: Mutex<Option<Signal>>,
    }

    impl ComputerUseExecutor for NativeTurn {
        fn owns_turn(&self, thread: &JsString, turn: &JsString) -> bool {
            thread.as_str() == Some("observed-thread") && turn.as_str() == Some("current-turn")
        }

        fn execute(
            &self,
            request: Value,
            _id: uuid::Uuid,
            signal: Signal,
        ) -> BoxFuture<'_, Result<Value>> {
            Box::pin(async move {
                signal.check()?;
                self.executions.fetch_add(1, Ordering::Relaxed);
                if request["script"] == "hold" {
                    let cancelled = self.cancelled.clone();
                    tokio::spawn(async move {
                        let _ = signal.cancelled().await;
                        cancelled.notify_one();
                    });
                    self.started.notify_one();
                    std::future::pending().await
                } else if request["operation"] == "js" {
                    self.observation.lock().unwrap().replace(signal);
                    let data = "BwcH".repeat(200_000);
                    Ok(
                        json!({"content":vec![json!({"type":"image","mimeType":"image/png","data":data})]}),
                    )
                } else {
                    Ok(json!({"content":Vec::<Value>::new()}))
                }
            })
        }
    }

    #[tokio::test]
    async fn computer_use_mcp_checks_worker_core_authority_and_native_turn_for_both_transports()
    -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let authority = json!({
            "serverId":"logical-server","ownerId":"owner","workerId":"worker","chatId":"chat",
            "projectId":Value::Null,"contextKind":"standalone","placementId":"scratch",
            "executionLaneId":"lane","generation":7,"cantripAppAllowed":false,
            "profile":json!({
                "selectedId":":workspace","effectiveId":":workspace","forcedByWorktreePolicy":false,"usesDefault":true
            }),
        });
        let current = Arc::new(Mutex::new(authority.clone()));
        let core_requests = Arc::new(AtomicUsize::new(0));
        let core = tokio::spawn({
            let current = current.clone();
            let requests = core_requests.clone();
            async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let current = current.clone();
                    let requests = requests.clone();
                    tokio::spawn(async move {
                        let handler = service_fn(move |request: Request<Incoming>| {
                            let current = current.clone();
                            let requests = requests.clone();
                            async move {
                                if request.uri().path() != "/api/internal/computer-use/authority" {
                                    return Ok::<_, Infallible>(
                                        Response::builder()
                                            .status(404)
                                            .body(Full::new(Bytes::from_static(b"{}")))
                                            .unwrap(),
                                    );
                                }
                                let (parts, body) = request.into_parts();
                                assert_eq!(
                                    parts.headers["authorization"],
                                    "Bearer core-worker-fixture"
                                );
                                let bytes = body.collect().await.unwrap().to_bytes();
                                let request =
                                    parse_json_text(std::str::from_utf8(&bytes).unwrap()).unwrap();
                                let binding = &request["binding"];
                                assert_eq!(binding["ownerId"], "owner");
                                assert_eq!(binding["workerId"], "worker");
                                assert_eq!(binding["chatId"], "chat");
                                assert_eq!(binding["executionLaneId"], "lane");
                                assert_eq!(binding["scratchRootId"], "scratch");
                                requests.fetch_add(1, Ordering::Relaxed);
                                let body = current.lock().unwrap().stringify();
                                Ok(Response::new(Full::new(Bytes::from(body))))
                            }
                        });
                        let _ = http1::Builder::new()
                            .serve_connection(TokioIo::new(socket), handler)
                            .await;
                    });
                }
            }
        });
        let data = tempfile::tempdir()?;
        let broker = Broker::start(
            data.path(),
            "worker".into(),
            Arc::new(|| Ok(("owner".into(), "logical-server".into()))),
            Server::new(
                &format!("http://{address}"),
                Arc::new(|| Ok("core-worker-fixture".into())),
            )?,
        )
        .await?;
        let claims = json!({
            "contextKind":"standalone","ownerId":"owner","workerId":"worker","chatId":"chat",
            "scratchRootId":"scratch","projectId":Value::Null,"worktreeId":Value::Null,
            "rootKind":Value::Null,"permissionProfileId":":workspace","allowedOperations":["tool.help"],
        });
        let attachment = broker.prepare_for_turn(claims.clone(), None, true).await?;
        let binding = &attachment.connection["bindingId"];
        let base = attachment.connection["endpoint"].as_str().unwrap();
        let token = attachment.connection["credential"].as_str().unwrap();
        let client = reqwest::Client::builder().no_proxy().build()?;
        let payload = |turn| {
            json!({
                "bindingId":binding,
                "request":json!({"operation":"js_reset","threadId":"observed-thread",
                    "turnId":turn,"itemId":Value::Null,"callId":Value::Null}),
            })
        };
        let post = |token, body: Value| {
            client
                .post(format!("{base}/v1/computer-use"))
                .bearer_auth(token)
                .header("content-type", "application/json")
                .body(body.stringify())
                .send()
        };
        let invoke = |method, params: Value| {
            client
                .post(format!("{base}/v1/cua-mcp/{}", binding.as_str().unwrap()))
                .bearer_auth(token)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).stringify())
                .send()
        };
        assert_eq!(post("wrong", payload("current-turn")).await?.status(), 401);
        assert_eq!(post(token, payload("current-turn")).await?.status(), 409);
        let catalog = invoke("tools/list", json!({})).await?;
        assert_eq!(catalog.status(), 200);
        let catalog = parse_json_text(&catalog.text().await?)
            .map_err(|_| anyhow!("Invalid catalog JSON."))?;
        let tools = catalog["result"]["tools"].as_array().unwrap();
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["js", "js_reset"]
        );
        let mut admission = claims.clone();
        admission["executionLaneId"] = json!("lane");
        let activation = broker.activate(&admission)?.unwrap();
        let runtime = Arc::new(NativeTurn::default());
        activation.register_computer_use(&authority, runtime.clone())?;
        assert_eq!(post(token, payload("foreign-turn")).await?.status(), 409);
        assert_eq!(core_requests.load(Ordering::Relaxed), 0);
        assert_eq!(post(token, payload("current-turn")).await?.status(), 200);
        let meta = json!({"threadId":"observed-thread",
            "x-codex-turn-metadata":json!({"turn_id":"current-turn"}),"itemId":"item","callId":"call"});
        let script =
            |source| json!({"name":"js","arguments":json!({"script":source}),"_meta":meta});
        let response = invoke("tools/call", script("image")).await?;
        assert_eq!(response.status(), 200);
        let output = parse_json_text(&response.text().await?)
            .map_err(|_| anyhow!("Invalid CUA relay JSON."))?;
        assert_eq!(
            output["result"]["content"].as_array().unwrap()[0]["data"]
                .as_str()
                .unwrap()
                .len(),
            800_000
        );
        assert_eq!(runtime.executions.load(Ordering::Relaxed), 2);
        assert_eq!(core_requests.load(Ordering::Relaxed), 2);
        let observation = runtime.observation.lock().unwrap().take().unwrap();
        observation.check()?;

        let held = invoke("tools/call", script("hold"));
        let retired = async {
            runtime.started.notified().await;
            let replacement = broker.activate(&admission)?.unwrap();
            runtime.cancelled.notified().await;
            Ok::<_, anyhow::Error>(replacement)
        };
        let (reply, replacement) = timeout(Duration::from_secs(5), async {
            tokio::join!(held, retired)
        })
        .await?;
        let reply = reply?;
        assert_eq!(reply.status(), 200);
        let retirement = parse_json_text(&reply.text().await?)
            .map_err(|_| anyhow!("Invalid CUA retirement JSON."))?;
        assert_eq!(retirement["result"]["isError"], true);
        assert!(observation.check().is_err());
        let replacement = replacement?;
        replacement.register_computer_use(&authority, runtime.clone())?;
        let held = client
            .post(format!("{base}/v1/cua-mcp/{}", binding.as_str().unwrap()))
            .bearer_auth(token)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(
                json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":script("hold")})
                    .stringify(),
            );
        let pending = tokio::spawn(held.send());
        timeout(Duration::from_secs(5), runtime.started.notified()).await?;
        pending.abort();
        timeout(Duration::from_secs(5), runtime.cancelled.notified()).await?;
        current.lock().unwrap()["generation"] = json!(8);
        assert_eq!(post(token, payload("current-turn")).await?.status(), 409);
        *current.lock().unwrap() = authority;
        assert_eq!(post(token, payload("current-turn")).await?.status(), 409);
        assert_eq!(runtime.executions.load(Ordering::Relaxed), 4);
        let disabled = broker.prepare_for_turn(claims, None, false).await?;
        assert_ne!(disabled.connection["bindingId"], *binding);
        assert_eq!(invoke("tools/list", json!({})).await?.status(), 401);

        broker.close().await?;
        core.abort();
        Ok(())
    }
}
