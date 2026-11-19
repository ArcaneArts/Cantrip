//! Core's durable GUI receipt is independent of the physical inference grant.
use super::{Key, Runtime, id};
use crate::{
    chat_content::Scope,
    config::Config,
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Context, Result, bail};
use cantrip_crypto::content::{
    open_native_command_result, protect_native_command_request, protect_native_command_result,
    protect_native_command_terminal_result,
};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone)]
pub(super) struct Client {
    configuration: Arc<Mutex<Config>>,
    generation: String,
    http: reqwest::Client,
}

#[derive(Debug)]
pub(super) struct Unacknowledged(pub(super) String);

impl std::fmt::Display for Unacknowledged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Core did not acknowledge native command {}.", self.0)
    }
}
impl std::error::Error for Unacknowledged {}

#[derive(Debug)]
pub(super) struct MetadataHttpError {
    pub status: u16,
    pub code: Value,
    message: String,
}
impl std::fmt::Display for MetadataHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for MetadataHttpError {}

#[derive(Clone)]
pub(super) struct Operation {
    pub operation: JsString,
    pub generation: JsString,
    pub activation: Value,
    payload: Value,
    pub(super) lane: Value,
    method: &'static str,
    restored: Option<Lineage>,
}

#[derive(Clone)]
struct Lineage {
    previous: Value,
    logical: Value,
}

impl Operation {
    fn starts_execution(&self) -> bool {
        self.restored.is_some() || matches!(self.method, "turn/start" | super::shell::METHOD)
    }

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
            restored: None,
        }))
    }

    pub fn matches(&self, command: &Value) -> bool {
        self.restored.as_ref().map_or_else(
            || {
                command["rootOperationId"].as_js_string() == Some(&self.operation)
                    && command["rootOperationGeneration"].as_js_string() == Some(&self.generation)
            },
            |lineage| {
                command["rootOperationId"] == lineage.logical["operationId"]
                    && command["rootOperationGeneration"] == lineage.logical["operationGeneration"]
            },
        )
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
        let metadata = path.starts_with("/api/internal/native-queue/")
            || matches!(action, "settings-refresh" | "settings-observation");
        let mut request = self
            .http
            .post(url)
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(body.stringify());
        if action == "queue start-receipt" {
            request = request.timeout(Duration::from_secs(95));
        }
        let response = guard
            .run(async { request.send().await.map_err(|_| unacknowledged().into()) })
            .await?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            if metadata && status < 500 {
                let body = guard
                    .run(async {
                        Ok(response
                            .bytes()
                            .await
                            .ok()
                            .and_then(|bytes| {
                                parse_json_text(&String::from_utf8_lossy(&bytes)).ok()
                            })
                            .unwrap_or(Value::Null))
                    })
                    .await?;
                return Err(MetadataHttpError {
                    status,
                    code: body["code"].clone(),
                    message: body["error"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Managed {action} failed with HTTP {status}.")),
                }
                .into());
            }
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
        let mut session = session.clone();
        session["connectionId"] = json!(crate::native_items::concat(&[
            "queue-owner:".into(),
            id(&session["runtimeGeneration"], "queue owner runtime")?,
        ]));
        self.queue(scope, "read", json!({"session":session}), None)
            .await
    }

    pub(super) async fn queue(
        &self,
        scope: &Scope,
        action: &str,
        mut input: Value,
        signal: Option<Signal>,
    ) -> Result<Value> {
        let (request_schema, response_schema) = match action {
            "read" => ("managedQueueReadSchema", "managedQueueSnapshotSchema"),
            "lookup" => ("managedQueueLookupSchema", "managedQueueLookupResultSchema"),
            "mutate" => (
                "managedQueueMutateSchema",
                "managedQueueMutationResultSchema",
            ),
            "start-receipt" => (
                "managedQueueStartReceiptSchema",
                "managedQueueStartReceiptResultSchema",
            ),
            "import" => ("managedQueueImportSchema", "managedQueueImportResultSchema"),
            "import-ack" => ("managedQueueImportAckSchema", "managedQueueSnapshotSchema"),
            _ => unreachable!("supported console queue action"),
        };
        scope.identity()?;
        if matches!(action, "read" | "start-receipt" | "import" | "import-ack") {
            input["workerId"] = json!(self.configuration.lock().unwrap().worker_id);
        }
        let body = checked(request_schema, &input)?;
        let timeout = if action == "start-receipt" { 95 } else { 30 };
        let guard = Guard::metadata_timeout(signal, None, Duration::from_secs(timeout));
        let reply = self
            .exchange(
                &format!("queue {action}"),
                &format!("/api/internal/native-queue/{action}"),
                &body,
                &guard,
            )
            .await?;
        scope.identity()?;
        checked(response_schema, &reply)
            .map_err(|_| Unacknowledged(format!("queue {action}")).into())
    }

    pub(super) fn queue_admission(
        &self,
        scope: &Scope,
        session: &Value,
        permission: &Value,
        operation: &JsString,
        frame: &Value,
        activation: Value,
    ) -> Result<Value> {
        let grant = scope.material(None)?;
        let (payload, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], operation),
            frame,
        )?;
        let mut intent = json!({
            "scope":"thread", "settingKeys":Vec::<Value>::new(), "expectedTurnId":Value::Null,
            "permissionProfileId":permission, "pathsWithinPlacement":true,
        });
        if matches!(
            frame["method"].as_str(),
            Some("thread/queue/add" | "thread/queue/start")
        ) {
            intent["resumeAutonomy"] = json!(true);
        }
        Ok(json!({
            "workerId":self.configuration.lock().unwrap().worker_id, "operationId":operation,
            "origin":"terminal", "session":session, "method":frame["method"], "intent":intent,
            "payloadDigest":digest, "protectedPayload":payload, "expectedActivationGeneration":activation,
        }))
    }

    pub(super) fn open_queue_start(
        &self,
        scope: &Scope,
        session: &Value,
        claim: &Value,
        reply: &Value,
    ) -> Result<Value> {
        let receipt = &reply["receipt"];
        let actual = &reply["claim"];
        let method = receipt["method"].as_str();
        if actual["id"] != claim["id"]
            || actual["chatId"] != session["chatId"]
            || receipt["chatId"] != session["chatId"]
            || receipt["threadId"] != session["threadId"]
            || actual["operationId"] != receipt["operationId"]
            || actual["operationGeneration"] != receipt["operationGeneration"]
            || receipt["status"] != "applied"
            || !matches!(
                method,
                Some(
                    "turn/start"
                        | "thread/shellCommand"
                        | "thread/settings/update"
                        | "thread/goal/set"
                        | "thread/goal/clear"
                )
            )
        {
            return Err(Unacknowledged("queue start receipt".into()).into());
        }
        let operation = id(&receipt["operationId"], "queued native execution")?;
        let envelope = &reply["protectedResult"];
        let revision = envelope["keyRevision"]
            .as_u64()
            .ok_or_else(|| Unacknowledged("queue result key".into()))?;
        let grant = scope.material(Some(revision))?;
        let content = open_native_command_result(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            envelope,
        )?;
        let result = if content.get("error").is_none() && content["result"].is_object() {
            &content["result"]
        } else if content.get("error").is_none()
            && method == Some("turn/start")
            && content["turn"].is_object()
        {
            &content
        } else {
            return Err(Unacknowledged("queue action result".into()).into());
        };
        if method == Some("turn/start") {
            if !result["turn"]["id"].is_string() || result["turn"]["id"] != actual["nativeTurnId"] {
                return Err(Unacknowledged("queued native turn".into()).into());
            }
            Ok(result.clone())
        } else {
            Ok(
                json!({"managedAction":json!({"operationId":claim["requestOperationId"],"executionOperationId":operation,"method":receipt["method"],"status":"applied"})}),
            )
        }
    }

    pub(super) async fn refresh_settings(&self, chat: &JsString, guard: &Guard) -> Result<Value> {
        let body = checked(
            "nativeSettingsRefreshRequestSchema",
            &json!({"workerId":self.configuration.lock().unwrap().worker_id,"chatId":chat}),
        )?;
        let reply = self
            .exchange(
                "settings-refresh",
                "/api/internal/native-commands/settings-refresh",
                &body,
                guard,
            )
            .await?;
        checked("nativeSettingsStateSchema", &reply)
    }

    pub(super) async fn observe_settings(
        &self,
        binding: &Value,
        snapshot: &Value,
        guard: &Guard,
    ) -> Result<Value> {
        let body = checked(
            "nativeSettingsObservationRequestSchema",
            &json!({"workerId":self.configuration.lock().unwrap().worker_id,"bindingId":binding,"snapshot":snapshot}),
        )?;
        let reply = self
            .exchange(
                "settings-observation",
                "/api/internal/native-commands/settings-observation",
                &body,
                guard,
            )
            .await?;
        let reply = checked("nativeSettingsObservationReceiptSchema", &reply)?;
        if &reply["bindingId"] != binding {
            bail!("Core returned another native settings binding.");
        }
        Ok(reply)
    }

    pub(super) async fn publish_settings(&self, event: &Value) -> Result<()> {
        let reply = self
            .exchange(
                "settings-evidence",
                "/api/internal/native-commands/settings-evidence",
                event,
                &Guard::metadata(None, None),
            )
            .await?;
        let reply = checked("nativeSettingsEvidenceResultSchema", &reply)?;
        if ["operationId", "operationGeneration", "eventId"]
            .iter()
            .any(|key| reply[*key] != event[*key])
            || reply["application"]["nativeOperationId"] != event["nativeOperationId"]
        {
            bail!("Core returned unrelated native settings evidence acknowledgment.");
        }
        Ok(())
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
        let lineage_matches = self.operation.restored.as_ref().map_or_else(
            || {
                receipt["previousOperationId"].is_null()
                    && (receipt["logicalOperationId"].is_null()
                        || (self.operation.starts_execution()
                            && receipt["logicalOperationId"].as_js_string()
                                == Some(&self.operation.operation)))
            },
            |lineage| {
                receipt["previousOperationId"] == lineage.previous
                    && receipt["logicalOperationId"] == lineage.logical["operationId"]
            },
        );
        if receipt["operationId"].as_js_string() != Some(&self.operation.operation)
            || receipt["operationGeneration"].as_js_string() != Some(&self.operation.generation)
            || receipt["activationGeneration"] != self.operation.activation
            || receipt["payloadDigest"] != self.operation.payload
            || receipt["executionLaneId"] != self.operation.lane
            || receipt["chatId"] != self.session["chatId"]
            || receipt["threadId"] != self.session["threadId"]
            || !lineage_matches
            || receipt["method"] != self.operation.method
            || receipt["status"] != status
            || receipt["startsExecution"] != self.operation.starts_execution()
        {
            bail!("Core returned an unrelated native command receipt.");
        }
        Ok(())
    }

    pub(super) fn scope(&self) -> &Scope {
        &self.scope
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

    pub async fn not_started(&self) -> Result<()> {
        self.reject_start(
            &json!({"code":-32000,"message":"The native attempt was not dispatched."}),
            "idle",
        )
        .await
    }

    pub async fn reject_start(&self, error: &Value, status: &str) -> Result<()> {
        let grant = self.scope.material(None)?;
        let (envelope, digest) = protect_native_command_result(
            &grant.key,
            &crypto_context(&grant, &self.session["chatId"], &self.operation.operation),
            &json!({"error":error}),
        )?;
        let mut body = self.body();
        body["status"] = json!("rejected");
        body["resultDigest"] = json!(digest);
        body["protectedResult"] = envelope;
        body["rejectionCode"] = json!("native-request-rejected");
        body["executionComplete"] = json!(true);
        body["executionStatus"] = json!(status);
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

    pub async fn finish_native(&self, turn: &JsString, status: &str, result: &Value) -> Result<()> {
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
        let mut body = self.result_body(status, content)?;
        if let Some(evidence) = evidence {
            body["reconciliation"] = evidence;
        }
        if let Some(epoch) = goal_epoch {
            body["goalEpoch"] = json!(epoch);
        }
        self.settle(body, status).await
    }

    fn result_body(&self, status: &str, content: Option<&Value>) -> Result<Value> {
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
        Ok(body)
    }

    pub async fn dispatch_durable(&self) -> Result<()> {
        let result = self.dispatch().await;
        if result
            .as_ref()
            .is_err_and(|error| error.is::<Unacknowledged>())
        {
            // Core may have committed dispatch before the reply was lost.
            // Preserve that uncertainty while leaving the native turn untouched.
            let _ = self.settle_durable("uncertain", None, None).await;
        }
        result
    }

    pub async fn settle_durable(
        &self,
        status: &str,
        content: Option<&Value>,
        evidence: Option<&Value>,
    ) -> Result<()> {
        let mut body = self.result_body(status, content)?;
        body["durableSuspension"] = json!(true);
        body["workerGeneration"] = json!(self.client.generation);
        if let Some(evidence) = evidence {
            body["suspensionEvidence"] = evidence.clone();
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

pub(super) fn crypto_context(
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
                restored: None,
            },
            session,
            scope,
        };
        receipt.verify(&response, "accepted")?;
        Ok((receipt, response))
    }

    pub async fn admit_command(
        &self,
        scope: Scope,
        session: Value,
        method: &'static str,
        params: &Value,
        command: &Value,
        activation: Value,
    ) -> Result<(Receipt<'_>, bool, Value)> {
        self.admit_native(scope, session, method, params, command, activation, "gui")
            .await
    }

    pub async fn admit_console(
        &self,
        scope: Scope,
        session: Value,
        method: &'static str,
        frame: &Value,
        permission: &Value,
    ) -> Result<Receipt<'_>> {
        let command = json!({"permissionProfileId":permission, "nativeViewRequestId":frame["id"]});
        let (receipt, _, _) = self
            .admit_native(
                scope,
                session,
                method,
                &frame["params"],
                &command,
                Value::Null,
                "terminal",
            )
            .await?;
        Ok(receipt)
    }

    pub async fn admit_console_settings(
        &self,
        scope: Scope,
        session: Value,
        operation: &str,
        frame: &Value,
        permission: &Value,
        activation: Value,
    ) -> Result<Receipt<'_>> {
        let command = json!({
            "permissionProfileId":permission, "nativeViewRequestId":frame["id"], "operationId":operation,
        });
        let (receipt, _, _) = self
            .admit_native(
                scope,
                session,
                super::settings::UPDATE,
                &frame["params"],
                &command,
                activation,
                "terminal",
            )
            .await?;
        Ok(receipt)
    }

    pub async fn admit_console_turn(
        &self,
        scope: Scope,
        session: Value,
        operation: &str,
        frame: &Value,
        permission: &Value,
        retained: &Value,
    ) -> Result<(Receipt<'_>, Value)> {
        let command = json!({
            "permissionProfileId":permission, "nativeViewRequestId":frame["id"],
            "operationId":operation, "retainedInput":retained,
        });
        let (receipt, _, grant) = self
            .admit_native(
                scope,
                session,
                "turn/start",
                &frame["params"],
                &command,
                Value::Null,
                "terminal",
            )
            .await?;
        Ok((receipt, grant))
    }

    #[allow(clippy::too_many_arguments)]
    async fn admit_native(
        &self,
        scope: Scope,
        session: Value,
        method: &'static str,
        params: &Value,
        command: &Value,
        activation: Value,
        origin: &'static str,
    ) -> Result<(Receipt<'_>, bool, Value)> {
        let claim = command
            .get("queueClaim")
            .filter(|_| command["type"] == crate::codex::goals::QUEUE_EXECUTE);
        let operation = command["operationId"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string().into());
        let request_id = if origin == "terminal" {
            command["nativeViewRequestId"].clone()
        } else {
            json!(operation)
        };
        let grant = scope.material(None)?;
        let (envelope, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &json!({"id":request_id,"method":method,"params":params}),
        )?;
        let mut intent = json!({
            "scope":"thread", "settingKeys":Vec::<Value>::new(), "expectedTurnId":Value::Null,
            "permissionProfileId":command["permissionProfileId"], "workerGeneration":self.generation,
        });
        if origin == "terminal" && matches!(method, "skills/list" | "turn/start") {
            intent["pathsWithinPlacement"] = json!(true);
        }
        if let Some(status) = params.get("status") {
            intent["goalStatus"] = status.clone();
        }
        if method == super::settings::UPDATE {
            intent["settingKeys"] = json!(
                params
                    .as_object()
                    .context("Native settings parameters")?
                    .keys()
                    .filter(|key| !matches!(
                        key.as_str(),
                        Some("threadId" | "turnId" | "operationId" | "applyAt")
                    ))
                    .cloned()
                    .collect::<Vec<_>>()
            );
            intent["nativeSettingsOperationId"] = params["operationId"].clone();
            if let Some(binding) = command.get("settingsBindingId") {
                intent["settingsBindingId"] = binding.clone();
            }
            if let Some(turn) = ["expectedTurnId", "turnId"]
                .iter()
                .find_map(|key| params[*key].as_js_string())
            {
                intent["expectedTurnId"] = json!(turn);
            }
            intent["pathsWithinPlacement"] = json!(true);
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
            "origin":origin, "session":session, "method":method, "intent":intent,
            "payloadDigest":digest, "protectedPayload":envelope,
            "expectedActivationGeneration":activation,
        });
        if let Some(claim) = claim {
            request["queueClaim"] = claim.clone();
        }
        if let Some(retained) = command
            .get("retainedInput")
            .filter(|_| origin == "terminal")
        {
            request["retainedInput"] = retained.clone();
            request["intent"]["nativeClientUserMessageId"] = params["clientUserMessageId"].clone();
        }
        let body = checked("nativeCommandAdmissionSchema", &request)?;
        let response = self
            .post("admit", &body, &Guard::metadata(None, None))
            .await?;
        scope.identity()?;
        let row = &response["receipt"];
        if response["replayed"] == true {
            bail!("The native operation already has a receipt and cannot be replayed.");
        }
        if row["status"] != "accepted" {
            bail!("Core did not admit the native command.");
        }
        let activation = if matches!(method, "turn/start" | super::shell::METHOD) {
            id(&row["executionLaneId"], "native execution lane")?;
            Value::String(id(
                &row["activationGeneration"],
                "native execution activation",
            )?)
        } else {
            activation
        };
        let control = Receipt {
            client: self,
            operation: Operation {
                operation,
                generation: id(&row["operationGeneration"], "native operation generation")?,
                activation,
                payload: json!(digest),
                lane: row["executionLaneId"].clone(),
                method,
                restored: None,
            },
            session,
            scope,
        };
        control.verify(&response, "accepted")?;
        Ok((control, claim.is_some() && resume, response))
    }

    pub async fn admit_suspension(
        &self,
        scope: Scope,
        command: &Value,
        session: Value,
    ) -> Result<(Receipt<'_>, Value)> {
        let stopping = command["type"] == super::STOP_SUSPENSION;
        let operation = JsString::from(uuid::Uuid::new_v4().to_string());
        let grant = scope.material(None)?;
        let checkpoint = &command["checkpoint"];
        let (protected, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &json!({
                "method":"thread/resume",
                "params":json!({"threadId":session["threadId"],"expectedSuspension":checkpoint["suspension"]}),
            }),
        )?;
        let mut body = json!({
            "workerId":self.configuration.lock().unwrap().worker_id,
            "workerGeneration":self.generation, "controlId":command["controlId"],
            "operationId":operation, "session":session, "checkpoint":checkpoint,
            "protectedPayload":protected, "payloadDigest":digest,
        });
        if stopping {
            body["action"] = json!("stop");
        }
        let body = checked("nativeSuspensionExecutionAdmissionSchema", &body)?;
        let guard = Guard::metadata(None, None);
        let request = || {
            self.exchange(
                "suspension-execution",
                "/api/internal/native-commands/suspension-execution",
                &body,
                &guard,
            )
        };
        let response = match request().await {
            Err(error) if error.is::<Unacknowledged>() => {
                // The original transaction may have committed. Retry the exact
                // sealed request to recover its receipt without replacing it.
                scope.identity()?;
                request().await?
            }
            result => result?,
        };
        scope.identity()?;
        let response = checked("nativeSuspensionExecutionAdmissionResultSchema", &response)?;
        let state = &response["suspension"];
        let target = &state["target"];
        let actor = &state["executionOwner"];
        let row = &response["receipt"];
        let execution = &response["execution"];
        let placement = if session["contextKind"] == "project" {
            "worktreeId"
        } else {
            "scratchRootId"
        };
        if state["controlId"] != command["controlId"]
            || state["action"] != if stopping { "stop" } else { "resume" }
            || state["phase"] != if stopping { "stopping" } else { "resuming" }
            || &state["checkpoint"] != checkpoint
            || target["workerId"] != body["workerId"]
            || [
                "contextKind",
                "projectId",
                "placementId",
                "threadId",
                "modelRouteId",
                "providerAccountId",
            ]
            .iter()
            .any(|key| target[*key] != session[*key])
            || target["originalOperationId"] != response["source"]["operationId"]
            || state["active"]["threadId"] != session["threadId"]
            || state["active"]["turnId"] != checkpoint["suspension"]["turnId"]
            || actor["workerGeneration"] != self.generation
            || actor["runtimeGeneration"] != session["runtimeGeneration"]
            || actor["operationId"] != row["operationId"]
            || actor["operationGeneration"] != row["operationGeneration"]
            || !response["computerUseAuthority"].is_null()
            || execution["workerId"] != body["workerId"]
            || execution["contextKind"] != session["contextKind"]
            || execution["projectId"] != session["projectId"]
            || execution[placement] != session["placementId"]
            || execution["chatId"] != session["chatId"]
            || execution["threadId"] != session["threadId"]
            || execution["modelRouteId"] != session["modelRouteId"]
            || execution["providerAccountId"] != session["providerAccountId"]
            || execution["executionLaneId"] != row["executionLaneId"]
            || target["executionLaneId"] != row["executionLaneId"]
        {
            bail!("Core returned an unrelated suspended execution owner.");
        }
        let receipt = Receipt {
            client: self,
            operation: Operation {
                operation,
                generation: id(
                    &row["operationGeneration"],
                    "suspension observer generation",
                )?,
                activation: json!(id(
                    &row["activationGeneration"],
                    "suspension activation generation"
                )?),
                payload: json!(digest),
                lane: json!(id(&row["executionLaneId"], "suspension execution lane")?),
                method: "thread/resume",
                restored: Some(Lineage {
                    previous: json!(id(
                        &row["previousOperationId"],
                        "previous suspension owner"
                    )?),
                    logical: response["logicalRoot"].clone(),
                }),
            },
            session,
            scope,
        };
        receipt.verify(&response, "accepted")?;
        Ok((receipt, response))
    }

    pub async fn admit_control(
        &self,
        root: &Operation,
        scope: Scope,
        session: Value,
        params: &Value,
        permission: &Value,
        action: super::control::Action<'_>,
    ) -> Result<Receipt<'_>> {
        let pause = action.paused();
        let name = if pause.is_some() {
            "turn/pause"
        } else {
            "turn/interrupt"
        };
        let operation = JsString::from(uuid::Uuid::new_v4().to_string());
        let grant = scope.material(None)?;
        let (envelope, digest) = protect_native_command_request(
            &grant.key,
            &crypto_context(&grant, &session["chatId"], &operation),
            &json!({"id": operation, "method": name, "params": params}),
        )?;
        let mut intent = json!({
            "scope": "thread", "settingKeys": Vec::<Value>::new(),
            "expectedTurnId": params["turnId"], "permissionProfileId": permission, "pathsWithinPlacement": true,
        });
        if let Some(paused) = pause {
            intent["paused"] = json!(paused);
            if !paused {
                intent["resumeAutonomy"] = json!(true);
            }
        }
        if action.durable() {
            intent["durableSuspension"] = json!(true);
            intent["workerGeneration"] = json!(self.generation);
        }
        if let Some(control_id) = action.control_id() {
            intent["expectedSuspensionControlId"] = control_id;
        }
        let body = checked(
            "nativeCommandAdmissionSchema",
            &json!({
                "workerId": self.configuration.lock().unwrap().worker_id,
                "operationId": operation, "origin": "gui", "session": session, "method": name,
                "payloadDigest": digest, "protectedPayload": envelope,
                "expectedActivationGeneration": root.activation, "intent": intent,
            }),
        )?;
        let response = self
            .post("admit", &body, &Guard::metadata(None, None))
            .await?;
        scope.identity()?;
        if response["replayed"] == true || response["receipt"]["status"] != "accepted" {
            if pause.is_some() {
                bail!("Core did not admit the native Pause control.");
            }
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
                restored: None,
            },
            session,
            scope,
        };
        control.verify(&response, "accepted")?;
        Ok(control)
    }
}
