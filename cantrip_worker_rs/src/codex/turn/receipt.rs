//! Core's durable GUI receipt is independent of the physical inference grant.
use super::{Key, Runtime, id};
use crate::{chat_content::Scope, config::Config, http::checked, metadata::Guard};
use anyhow::{Result, bail};
use cantrip_crypto::content::{protect_native_command_request, protect_native_command_result};
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
pub(super) struct Operation {
    pub operation: JsString,
    pub generation: JsString,
    pub activation: Value,
    payload: Value,
    lane: Value,
    method: &'static str,
}

impl Operation {
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
            activation: Value::String(id(
                &receipt["activationGeneration"],
                "native activation generation",
            )?),
            payload: receipt["payloadDigest"].clone(),
            lane: receipt["executionLaneId"].clone(),
            method: "turn/start",
        }))
    }

    pub fn matches(&self, command: &Value) -> bool {
        command["rootOperationId"].as_js_string() == Some(&self.operation)
            && command["rootOperationGeneration"].as_js_string() == Some(&self.generation)
    }
}

pub(super) struct Receipt<'a> {
    client: &'a Client,
    operation: Operation,
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
        let schema = if matches!(action, "admit" | "dispatch") {
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
        root: &Operation,
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
            operation: root.clone(),
            session,
            scope,
        })
    }

    fn body(&self) -> Value {
        json!({
            "workerId": self.client.configuration.lock().unwrap().worker_id,
            "operationId": self.operation.operation, "operationGeneration": self.operation.generation,
        })
    }

    fn verify(&self, response: &Value, status: &str) -> Result<()> {
        let receipt = &response["receipt"];
        if receipt["operationId"].as_js_string() != Some(&self.operation.operation)
            || receipt["operationGeneration"].as_js_string() != Some(&self.operation.generation)
            || receipt["activationGeneration"] != self.operation.activation
            || receipt["payloadDigest"] != self.operation.payload
            || receipt["executionLaneId"] != self.operation.lane
            || receipt["chatId"] != self.session["chatId"]
            || receipt["threadId"] != self.session["threadId"]
            || (!receipt["logicalOperationId"].is_null()
                && (self.operation.method != "turn/start"
                    || receipt["logicalOperationId"].as_js_string()
                        != Some(&self.operation.operation)))
            || !receipt["previousOperationId"].is_null()
            || receipt["method"] != self.operation.method
            || receipt["status"] != status
            || receipt["startsExecution"] != (self.operation.method == "turn/start")
        {
            bail!("Core returned an unrelated native command receipt.");
        }
        Ok(())
    }

    pub fn session(&self) -> &Value {
        &self.session
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
        body["payloadDigest"] = self.operation.payload.clone();
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

    pub async fn applied(&self, content: &Value, turn: Option<&JsString>) -> Result<()> {
        self.report(
            "applied",
            Some(content),
            reconciliation(&self.session, turn, None),
        )
        .await
    }

    pub async fn rejected(&self, error: &Value) -> Result<()> {
        self.report("rejected", Some(&json!({"error": error})), None)
            .await
    }

    pub async fn uncertain(&self) -> Result<()> {
        self.report("uncertain", None, None).await
    }

    pub async fn observed(&self, turn: &JsString, status: Option<&str>) -> Result<()> {
        self.report(
            "applied",
            None,
            reconciliation(&self.session, Some(turn), status),
        )
        .await
    }

    async fn report(
        &self,
        status: &str,
        content: Option<&Value>,
        evidence: Option<Value>,
    ) -> Result<()> {
        let (envelope, digest) = if let Some(content) = content {
            let grant = self.scope.material(None)?;
            let (envelope, digest) = protect_native_command_result(
                &grant.key,
                &crypto_context(&grant, &self.session["chatId"], &self.operation.operation),
                content,
            )?;
            (envelope, json!(digest))
        } else {
            (Value::Null, Value::Null)
        };
        let mut body = self.body();
        body["status"] = json!(status);
        body["resultDigest"] = digest;
        body["protectedResult"] = envelope;
        body["rejectionCode"] = if status == "rejected" {
            json!("native-request-rejected")
        } else {
            Value::Null
        };
        if let Some(evidence) = evidence {
            body["reconciliation"] = evidence;
        }
        self.settle(body, status).await
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

fn reconciliation(session: &Value, turn: Option<&JsString>, status: Option<&str>) -> Option<Value> {
    turn.map(|turn| {
        let mut evidence = json!({
            "nativeTurnId": turn, "runtimeGeneration": session["runtimeGeneration"],
        });
        if let Some(status) = status {
            evidence["terminalStatus"] = json!(status);
        }
        evidence
    })
}

fn crypto_context(
    grant: &cantrip_history::content::Material,
    chat: &Value,
    operation: &JsString,
) -> Value {
    json!({
        "ownerId": grant.owner_id, "serverId": grant.server_id,
        "chatId": chat, "operationId": operation, "keyRevision": grant.key_revision,
    })
}

impl Client {
    pub async fn admit_goal(
        &self,
        scope: Scope,
        session: Value,
        method: &'static str,
        params: &Value,
        command: &Value,
        activation: Value,
    ) -> Result<Receipt<'_>> {
        let operation = command["operationId"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string().into());
        let grant = scope.material(None)?;
        let (envelope, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &json!({"id":operation,"method":method,"params":params}),
        )?;
        let mut intent = json!({
            "scope":"thread", "settingKeys":Vec::<Value>::new(), "expectedTurnId":Value::Null,
            "permissionProfileId":command["permissionProfileId"], "workerGeneration":self.generation,
        });
        if let Some(status) = params.get("status") {
            intent["goalStatus"] = status.clone();
            if status == "active" {
                intent["resumeAutonomy"] = json!(true);
            }
        }
        let body = checked(
            "nativeCommandAdmissionSchema",
            &json!({
                "workerId":self.configuration.lock().unwrap().worker_id, "operationId":operation,
                "origin":"gui", "session":session, "method":method, "intent":intent,
                "payloadDigest":digest, "protectedPayload":envelope,
                "expectedActivationGeneration":activation,
            }),
        )?;
        let response = self
            .post("admit", &body, &Guard::metadata(None, None))
            .await?;
        scope.identity()?;
        let row = &response["receipt"];
        if response["replayed"] == true {
            bail!("The native Goal operation already has a receipt and cannot be replayed.");
        }
        if row["status"] != "accepted" {
            bail!("Core did not admit the native Goal mutation.");
        }
        let control = Receipt {
            client: self,
            operation: Operation {
                operation,
                generation: id(&row["operationGeneration"], "Goal operation generation")?,
                activation,
                payload: json!(digest),
                lane: row["executionLaneId"].clone(),
                method,
            },
            session,
            scope,
        };
        control.verify(&response, "accepted")?;
        Ok(control)
    }

    pub async fn admit_interrupt(
        &self,
        root: &Operation,
        scope: Scope,
        session: Value,
        params: &Value,
        permission: &Value,
    ) -> Result<Receipt<'_>> {
        let name = "turn/interrupt";
        let operation = JsString::from(uuid::Uuid::new_v4().to_string());
        let grant = scope.material(None)?;
        let (envelope, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &json!({"id": operation, "method": name, "params": params}),
        )?;
        let body = checked(
            "nativeCommandAdmissionSchema",
            &json!({
                "workerId": self.configuration.lock().unwrap().worker_id,
                "operationId": operation, "origin": "gui", "session": session, "method": name,
                "payloadDigest": digest, "protectedPayload": envelope,
                "expectedActivationGeneration": root.activation,
                "intent": json!({
                    "scope": "thread", "settingKeys": Vec::<Value>::new(),
                    "expectedTurnId": params["turnId"], "permissionProfileId": permission, "pathsWithinPlacement": true,
                }),
            }),
        )?;
        let response = self
            .post("admit", &body, &Guard::metadata(None, None))
            .await?;
        scope.identity()?;
        if response["replayed"] == true || response["receipt"]["status"] != "accepted" {
            bail!("Core did not admit the native Stop command.");
        }
        let control = Receipt {
            client: self,
            operation: Operation {
                operation,
                generation: id(
                    &response["receipt"]["operationGeneration"],
                    "native control generation",
                )?,
                activation: root.activation.clone(),
                payload: json!(digest),
                lane: root.lane.clone(),
                method: name,
            },
            session,
            scope,
        };
        control.verify(&response, "accepted")?;
        Ok(control)
    }
}
