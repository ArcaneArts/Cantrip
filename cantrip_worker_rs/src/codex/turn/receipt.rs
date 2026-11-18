//! Core's durable GUI receipt is independent of the physical inference grant.
use super::{Key, Runtime, id};
use crate::{chat_content::Scope, config::Config, http::checked, metadata::Guard};
use anyhow::{Result, bail};
use cantrip_crypto::content::protect_native_command_result;
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(super) struct Client {
    configuration: Arc<Mutex<Config>>,
    generation: String,
    http: reqwest::Client,
}

#[derive(Debug)]
struct Unacknowledged(String);

impl std::fmt::Display for Unacknowledged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Core did not acknowledge native command {}.", self.0)
    }
}
impl std::error::Error for Unacknowledged {}

#[derive(Clone)]
pub(super) struct Root {
    pub operation: JsString,
    pub generation: JsString,
    pub activation: JsString,
    payload: Value,
    lane: Value,
}

impl Root {
    pub fn read(command: &Value) -> Result<Option<Self>> {
        let receipt = &command["nativeCommandReceipt"];
        if receipt.is_null() {
            return Ok(None);
        }
        if receipt["method"] != "turn/start"
            || receipt["status"] != "accepted"
            || receipt["startsExecution"] != true
            || receipt["chatId"] != command["chatId"]
            || receipt["executionLaneId"] != command["executionLaneId"]
            || (!receipt["threadId"].is_null() && receipt["threadId"] != command["threadId"])
            || (!receipt["logicalOperationId"].is_null()
                && receipt["logicalOperationId"] != receipt["operationId"])
            || !receipt["previousOperationId"].is_null()
        {
            bail!("The native GUI receipt does not match the admitted host turn.");
        }
        let digest = Sha256::digest(command["protectedPrompt"].stringify().as_bytes());
        let digest: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        if receipt["payloadDigest"] != digest {
            bail!("The protected prompt does not match the admitted native command.");
        }
        Ok(Some(Self {
            operation: id(&receipt["operationId"], "native operation")?,
            generation: id(
                &receipt["operationGeneration"],
                "native operation generation",
            )?,
            activation: id(
                &receipt["activationGeneration"],
                "native activation generation",
            )?,
            payload: receipt["payloadDigest"].clone(),
            lane: receipt["executionLaneId"].clone(),
        }))
    }

    pub fn matches(&self, command: &Value) -> bool {
        command["rootOperationId"].as_js_string() == Some(&self.operation)
            && command["rootOperationGeneration"].as_js_string() == Some(&self.generation)
    }
}

pub(super) struct Receipt<'a> {
    client: &'a Client,
    root: &'a Root,
    session: Value,
    scope: Scope,
}

impl Client {
    pub fn new(configuration: Arc<Mutex<Config>>, generation: String) -> Result<Self> {
        Ok(Self {
            configuration,
            generation,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .gzip(true)
                .deflate(true)
                .brotli(true)
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
        })
    }

    async fn post(&self, action: &str, body: &Value, guard: &Guard) -> Result<Value> {
        let (url, token) = {
            let config = self.configuration.lock().unwrap();
            (
                url::Url::parse(&config.server_url)?
                    .join(&format!("/api/internal/native-commands/{action}"))?,
                config.token.clone(),
            )
        };
        let unacknowledged = || Unacknowledged(action.to_owned());
        let response = guard
            .run(async {
                self.http
                    .post(url)
                    .bearer_auth(token)
                    .header("content-type", "application/json")
                    .body(body.stringify())
                    .send()
                    .await
                    .map_err(|_| unacknowledged().into())
            })
            .await?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            if status >= 500 || matches!(status, 408 | 429) {
                return Err(unacknowledged().into());
            }
            bail!("Core rejected native command {action} with HTTP {status}.");
        }
        let bytes = guard
            .run(async { response.bytes().await.map_err(|_| unacknowledged().into()) })
            .await?;
        let text = String::from_utf8_lossy(&bytes);
        let body = parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .map_err(|_| unacknowledged())?;
        let schema = if action == "dispatch" {
            "nativeCommandAdmissionResultSchema"
        } else {
            "nativeCommandSettlementResultSchema"
        };
        checked(schema, &body)
    }
}

impl<'a> Receipt<'a> {
    pub fn new(
        client: &'a Client,
        root: &'a Root,
        command: &Value,
        runtime: &Runtime,
        thread: &JsString,
        scope: Scope,
        key: &Key,
    ) -> Result<Self> {
        if scope.owner != key.0 || scope.server != key.1 {
            bail!("The worker binding changed before native GUI preparation.");
        }
        let placement = if command["contextKind"] == "standalone" {
            &command["scratchRootId"]
        } else {
            &command["worktreeId"]
        };
        let connection = crate::native_items::concat(&["gui:".into(), root.generation.clone()]);
        let session = checked(
            "nativeCommandSessionSchema",
            &json!({
                "chatId": key.2, "threadId": thread,
                "contextKind": command["contextKind"], "projectId": command["policyProjectId"],
                "placementId": placement, "modelRouteId": command["model"]["routeId"],
                "providerAccountId": command["provider"]["accountId"],
                "runtimeGeneration": runtime.generation(), "connectionId": connection,
            }),
        )?;
        Ok(Self {
            client,
            root,
            session,
            scope,
        })
    }

    fn body(&self) -> Value {
        json!({
            "workerId": self.client.configuration.lock().unwrap().worker_id,
            "operationId": self.root.operation, "operationGeneration": self.root.generation,
        })
    }

    fn verify(&self, response: &Value, status: &str) -> Result<()> {
        let receipt = &response["receipt"];
        if receipt["operationId"].as_js_string() != Some(&self.root.operation)
            || receipt["operationGeneration"].as_js_string() != Some(&self.root.generation)
            || receipt["activationGeneration"].as_js_string() != Some(&self.root.activation)
            || receipt["payloadDigest"] != self.root.payload
            || receipt["executionLaneId"] != self.root.lane
            || receipt["chatId"] != self.session["chatId"]
            || receipt["threadId"] != self.session["threadId"]
            || (!receipt["logicalOperationId"].is_null()
                && receipt["logicalOperationId"].as_js_string() != Some(&self.root.operation))
            || !receipt["previousOperationId"].is_null()
            || receipt["method"] != "turn/start"
            || receipt["status"] != status
            || receipt["startsExecution"] != true
        {
            bail!("Core returned an unrelated native command receipt.");
        }
        Ok(())
    }

    pub async fn prepare(&self) -> Result<()> {
        self.bind("bind-preparation", "accepted").await
    }

    pub async fn dispatch(&self) -> Result<()> {
        self.bind("dispatch", "dispatched").await
    }

    async fn bind(&self, action: &str, status: &str) -> Result<()> {
        self.scope.identity()?;
        let mut body = self.body();
        body["payloadDigest"] = self.root.payload.clone();
        body["session"] = self.session.clone();
        if action == "dispatch" {
            body["workerGeneration"] = json!(self.client.generation);
        }
        let body = checked("nativeCommandDispatchSchema", &body)?;
        let response = self
            .client
            .post(action, &body, &Guard::metadata(None, None))
            .await?;
        self.scope.identity()?;
        self.verify(&response, status)
    }

    pub async fn result(&self, content: &Value, turn: Option<&JsString>) -> Result<()> {
        let grant = self.scope.material(None)?;
        let (envelope, digest) = protect_native_command_result(
            &grant.key,
            &json!({
                "ownerId": grant.owner_id, "serverId": grant.server_id,
                "chatId": self.session["chatId"], "operationId": self.root.operation, "keyRevision": grant.key_revision,
            }),
            content,
        )?;
        let mut body = self.body();
        let status = if turn.is_some() {
            "applied"
        } else {
            "rejected"
        };
        body["status"] = json!(status);
        body["resultDigest"] = json!(digest);
        body["protectedResult"] = envelope;
        body["rejectionCode"] = if let Some(turn) = turn {
            body["reconciliation"] = json!({
                "nativeTurnId": turn, "runtimeGeneration": self.session["runtimeGeneration"],
            });
            Value::Null
        } else {
            json!("native-request-rejected")
        };
        self.settle(body, status).await
    }

    pub async fn terminal(&self, turn: &JsString, status: &str) -> Result<()> {
        let mut body = self.body();
        body["status"] = json!("applied");
        body["resultDigest"] = Value::Null;
        body["protectedResult"] = Value::Null;
        body["rejectionCode"] = Value::Null;
        body["reconciliation"] = json!({
            "nativeTurnId": turn, "runtimeGeneration": self.session["runtimeGeneration"], "terminalStatus": status,
        });
        self.settle(body, "applied").await
    }

    async fn settle(&self, body: Value, status: &str) -> Result<()> {
        let body = checked("nativeCommandSettlementSchema", &body)?;
        let guard = Guard::metadata(None, None);
        let mut backoff = 250;
        loop {
            self.scope.identity()?;
            match self.client.post("receipt", &body, &guard).await {
                Ok(response) => {
                    self.scope.identity()?;
                    return self.verify(&response, status);
                }
                Err(error) if error.is::<Unacknowledged>() => {
                    guard.delay(backoff).await?;
                    backoff = (backoff * 2).min(4000);
                }
                Err(error) => return Err(error),
            }
        }
    }
}
