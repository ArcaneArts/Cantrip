//! Core's durable GUI receipt is independent of the physical inference grant.
use super::{Key, Runtime, id};
use crate::{chat_content::Scope, config::Config, http::checked, metadata::Guard};
use anyhow::{Result, bail};
use cantrip_crypto::content::{
    protect_native_command_request, protect_native_command_result,
    protect_native_command_terminal_result,
};
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
    pub(super) lane: Value,
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
        let reply = self
            .exchange(
                action,
                &format!("/api/internal/native-commands/{action}"),
                body,
                guard,
            )
            .await?;
        let schema = if matches!(action, "admit" | "dispatch") {
            "nativeCommandAdmissionResultSchema"
        } else {
            "nativeCommandSettlementResultSchema"
        };
        checked(schema, &reply)
    }

    async fn exchange(
        &self,
        action: &str,
        path: &str,
        body: &Value,
        guard: &Guard,
    ) -> Result<Value> {
        let (url, token) = {
            let config = self.configuration.lock().unwrap();
            (
                url::Url::parse(&config.server_url)?.join(path)?,
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
        parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .map_err(|_| unacknowledged().into())
    }

    pub async fn queue_snapshot(&self, scope: &Scope, session: &Value) -> Result<Value> {
        scope.identity()?;
        let mut session = session.clone();
        session["connectionId"] = json!(crate::native_items::concat(&[
            "queue-owner:".into(),
            id(&session["runtimeGeneration"], "queue owner runtime")?,
        ]));
        let input = checked(
            "managedQueueReadSchema",
            &json!({
                "workerId":self.configuration.lock().unwrap().worker_id, "session":session,
            }),
        )?;
        let reply = self
            .exchange(
                "queue read",
                "/api/internal/native-queue/read",
                &input,
                &Guard::metadata(None, None),
            )
            .await?;
        scope.identity()?;
        checked("managedQueueSnapshotSchema", &reply)
    }

    pub async fn event(&self, scope: &Scope, operation: &Operation, event: Value) -> Result<()> {
        scope.identity()?;
        let input = checked(
            "nativeCommandEventSchema",
            &json!({
                "workerId":self.configuration.lock().unwrap().worker_id,
                "operationId":operation.operation,"operationGeneration":operation.generation,"event":event,
            }),
        )?;
        let result = self
            .exchange(
                "events",
                "/api/internal/native-commands/events",
                &input,
                &Guard::metadata(None, None),
            )
            .await?;
        scope.identity()?;
        if result != json!({"applied":true}) {
            bail!("Core did not apply the protected native event.");
        }
        Ok(())
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

    pub(super) fn operation(&self) -> &Operation {
        &self.operation
    }

    pub async fn admitted_goal(&self, result: &Value) -> Result<()> {
        self.report("uncertain", Some(result), None, None).await
    }

    pub async fn goal_not_started(&self) -> Result<()> {
        let grant = self.scope.material(None)?;
        let (envelope, digest) = protect_native_command_result(
            &grant.key,
            &crypto_context(&grant, &self.session["chatId"], &self.operation.operation),
            &json!({"error":json!({"code":-32000,"message":"The native attempt was not dispatched."})}),
        )?;
        let mut body = self.body();
        body["status"] = json!("rejected");
        body["resultDigest"] = json!(digest);
        body["protectedResult"] = envelope;
        body["rejectionCode"] = json!("native-request-rejected");
        body["executionComplete"] = json!(true);
        body["executionStatus"] = json!("idle");
        self.settle(body, "rejected").await
    }

    pub async fn goal_declined(&self, key: &crate::codex::private_inference::Key) -> Result<()> {
        let grant = self.scope.material(None)?;
        let (envelope, digest) = protect_native_command_terminal_result(
            &grant.key,
            &crypto_context(&grant, &self.session["chatId"], &self.operation.operation),
            &json!({"failed":true}),
        )?;
        let mut body = self.body();
        body["status"] = json!("rejected");
        body["resultDigest"] = Value::Null;
        body["protectedResult"] = Value::Null;
        body["rejectionCode"] = json!("native-request-rejected");
        body["executionComplete"] = json!(true);
        body["executionStatus"] = json!("failed");
        body["terminalResult"] = json!({"resultDigest":digest,"protectedResult":envelope});
        body["decline"] = json!({
            "nativeTurnId":key.turn_id,"runtimeGeneration":self.session["runtimeGeneration"],
            "runnerGeneration":key.runner_generation,"attemptId":key.attempt_id,
        });
        self.settle(body, "rejected").await
    }

    pub async fn finish_goal(&self, turn: &JsString, status: &str, result: &Value) -> Result<()> {
        let grant = self.scope.material(None)?;
        let (envelope, digest) = protect_native_command_terminal_result(
            &grant.key,
            &crypto_context(&grant, &self.session["chatId"], &self.operation.operation),
            result,
        )?;
        let mut body = self.body();
        body["status"] = json!("applied");
        body["resultDigest"] = Value::Null;
        body["protectedResult"] = Value::Null;
        body["rejectionCode"] = Value::Null;
        body["terminalResult"] = json!({"resultDigest":digest,"protectedResult":envelope});
        body["executionComplete"] = json!(true);
        body["executionStatus"] = json!(if status == "failed" { "failed" } else { "idle" });
        body["reconciliation"] = reconciliation(&self.session, Some(turn), Some(status)).unwrap();
        self.settle(body, "applied").await
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
            None,
        )
        .await
    }

    pub async fn applied_queued_goal(&self, content: &Value) -> Result<()> {
        let Some(epoch) = content["goalEpoch"]
            .as_js_string()
            .filter(|epoch| !epoch.is_empty())
        else {
            self.uncertain().await?;
            bail!("Codex did not return the queued Goal epoch.");
        };
        self.report("applied", Some(content), None, Some(epoch))
            .await
    }

    pub async fn rejected(&self, error: &Value) -> Result<()> {
        self.report("rejected", Some(&json!({"error": error})), None, None)
            .await
    }

    pub async fn defer_queue_input(&self, error: &Value) -> Result<()> {
        let (envelope, digest) = self.seal_result(&json!({"error":error}))?;
        let mut body = self.body();
        body["status"] = json!("rejected");
        body["resultDigest"] = digest;
        body["protectedResult"] = envelope;
        body["rejectionCode"] = json!("native-settings-pending");
        body["executionComplete"] = json!(true);
        body["executionStatus"] = json!("idle");
        body["deferred"] = json!({
            "reason":"pendingSettings","inputConsumed":false,
            "threadId":self.session["threadId"],"runtimeGeneration":self.session["runtimeGeneration"],
        });
        self.settle(body, "rejected").await
    }

    fn seal_result(&self, content: &Value) -> Result<(Value, Value)> {
        let grant = self.scope.material(None)?;
        let (envelope, digest) = protect_native_command_result(
            &grant.key,
            &crypto_context(&grant, &self.session["chatId"], &self.operation.operation),
            content,
        )?;
        Ok((envelope, json!(digest)))
    }

    pub async fn uncertain(&self) -> Result<()> {
        self.report("uncertain", None, None, None).await
    }

    pub async fn observed(&self, turn: &JsString, status: Option<&str>) -> Result<()> {
        self.report(
            "applied",
            None,
            reconciliation(&self.session, Some(turn), status),
            None,
        )
        .await
    }

    async fn report(
        &self,
        status: &str,
        content: Option<&Value>,
        evidence: Option<Value>,
        goal_epoch: Option<&JsString>,
    ) -> Result<()> {
        let (envelope, digest) = if let Some(content) = content {
            self.seal_result(content)?
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
        if let Some(epoch) = goal_epoch {
            body["goalEpoch"] = json!(epoch);
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
    pub async fn admit_autonomous(
        &self,
        scope: Scope,
        session: Value,
        attempt: &Value,
        permission: &Value,
        queue: &Value,
    ) -> Result<(Receipt<'_>, Value)> {
        let operation = crate::native_items::concat(&[
            "native:".into(),
            id(&attempt["runnerGeneration"], "native runner")?,
            ":".into(),
            id(&attempt["attemptId"], "native attempt")?,
        ]);
        let grant = scope.material(None)?;
        let (envelope, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &json!({"method":"turn/start","params":json!({"threadId":session["threadId"]}),"nativeAttempt":attempt}),
        )?;
        let mut input = json!({
            "workerId":self.configuration.lock().unwrap().worker_id, "operationId":operation,
            "origin":"autonomous","session":session,"method":"turn/start",
            "intent":json!({"scope":"thread","expectedTurnId":attempt["turnId"],
                "autonomousAttempt":json!({"runnerGeneration":attempt["runnerGeneration"],"attemptId":attempt["attemptId"],
                    "turnId":attempt["turnId"],"trigger":"goal","goalEpoch":attempt["goalEpoch"]}),
                "permissionProfileId":permission,"workerGeneration":self.generation}),
            "payloadDigest":digest,"protectedPayload":envelope,"expectedActivationGeneration":Value::Null,
        });
        if let Some(claim) = queue["claims"].as_array().and_then(|claims| {
            claims.iter().find(|claim| {
                claim["awaitingGoal"] == true
                    && claim["goalCancelled"] != true
                    && attempt["goalEpoch"].is_string()
                    && claim["goalEpoch"] == attempt["goalEpoch"]
                    && claim["operationId"].is_string()
                    && claim["operationGeneration"].is_string()
                    && claim["goalOperationId"].is_null()
                    && matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
            })
        }) {
            input["goalQueueHandoff"] = json!({
                "claimId":claim["id"],"operationId":claim["operationId"],
                "operationGeneration":claim["operationGeneration"],"goalEpoch":attempt["goalEpoch"],
            });
        }
        let input = checked("nativeCommandAdmissionSchema", &input)?;
        let response = self
            .post("admit", &input, &Guard::metadata(None, None))
            .await?;
        scope.identity()?;
        let row = &response["receipt"];
        if response["replayed"] == true || row["status"] != "accepted" {
            bail!("Core did not admit the autonomous Goal producer.");
        }
        let receipt = Receipt {
            client: self,
            operation: Operation {
                operation,
                generation: id(
                    &row["operationGeneration"],
                    "autonomous operation generation",
                )?,
                activation: Value::String(id(
                    &row["activationGeneration"],
                    "autonomous activation",
                )?),
                payload: json!(digest),
                lane: Value::String(id(&row["executionLaneId"], "autonomous execution lane")?),
                method: "turn/start",
            },
            session,
            scope,
        };
        receipt.verify(&response, "accepted")?;
        Ok((receipt, response))
    }

    pub async fn admit_goal(
        &self,
        scope: Scope,
        session: Value,
        method: &'static str,
        params: &Value,
        command: &Value,
        activation: Value,
    ) -> Result<(Receipt<'_>, bool)> {
        let claim = command
            .get("queueClaim")
            .filter(|_| command["type"] == crate::codex::goals::QUEUE_EXECUTE);
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
        }
        let resume = params["status"] == "active"
            || (claim.is_some()
                && method == "thread/goal/set"
                && params.get("status").is_none()
                && params["objective"].is_string());
        if resume {
            intent["resumeAutonomy"] = json!(true);
        }
        let mut request = json!({
            "workerId":self.configuration.lock().unwrap().worker_id, "operationId":operation,
            "origin":"gui", "session":session, "method":method, "intent":intent,
            "payloadDigest":digest, "protectedPayload":envelope,
            "expectedActivationGeneration":activation,
        });
        if let Some(claim) = claim {
            request["queueClaim"] = claim.clone();
        }
        let body = checked("nativeCommandAdmissionSchema", &request)?;
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
        Ok((control, claim.is_some() && resume))
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
