//! Live turn analytics are best-effort consumers of the authoritative writers.
//! Observed native child turns retain their own identity and source aliases.
use super::turn_behavior::ModelBehaviorTracker;
use crate::{
    database::Database,
    operations::logging::{self, LogCall, Logger},
    settings::repository::SettingsRepository,
    wire::{JsString, Value, coercion::truthy, value::json},
};
use std::sync::Arc;

pub type Publish = Arc<dyn Fn(Value) + Send + Sync>;
pub struct RuntimeTelemetry {
    repository: SettingsRepository,
    publish_usage: Publish,
    logger: Logger,
}
fn concat(parts: &[&JsString]) -> JsString {
    JsString::new(
        parts
            .iter()
            .flat_map(|v| v.units().iter().copied())
            .collect(),
    )
}
fn field(output: &mut Value, key: &str, source: &Value) {
    if let Some(value) = source.get(key) {
        output[key] = value.clone();
    }
}
fn js_string(value: Option<&Value>) -> anyhow::Result<JsString> {
    value
        .map(crate::wire::coercion::string)
        .transpose()
        .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))
        .map(|v| v.unwrap_or_else(|| "undefined".into()))
}
fn usage_input(
    source: &JsString,
    project: &Value,
    chat: &Value,
    runtime: &Value,
    usage: Option<&Value>,
    attribution: &Value,
) -> anyhow::Result<Value> {
    let child = attribution
        .get("nativeModelAttribution")
        .filter(|v| v["isRoot"] == false);
    let mut attempt = attribution.get("executionAttemptId").cloned();
    if let Some(child) = child
        && truthy(attempt.as_ref())
        && attribution["attemptKind"] != "subagent-turn"
    {
        attempt = Some(Value::String(concat(&[
            &js_string(attempt.as_ref())?,
            &JsString::from(":subagent:"),
            &js_string(child.get("threadId"))?,
            &JsString::from(":"),
            &js_string(child.get("turnId"))?,
        ])));
    }
    let source = if let Some(child) = child {
        if let Some(attempt) = attempt.as_ref().filter(|v| truthy(Some(v))) {
            concat(&[
                &JsString::from("chat-subagent:"),
                &js_string(Some(attempt))?,
            ])
        } else {
            concat(&[
                source,
                &JsString::from(":native-child:"),
                &JsString::from(
                    Value::Array(vec![child["threadId"].clone(), child["turnId"].clone()])
                        .stringify(),
                ),
            ])
        }
    } else {
        source.clone()
    };
    let mut input = json!({"sourceKey":source,"projectId":project,"chatId":chat,"modelRouteId":runtime["routeId"],"providerAccountId":runtime["provider"]["accountId"],"reasoningEffort":runtime["model"]["reasoningEffort"],"workerVersion":Value::Null,"serverVersion":crate::settings::quota::server_version()});
    for key in [
        "nativeModelAttribution",
        "workerId",
        "turnId",
        "attemptStatus",
        "codexVersion",
        "startedAt",
        "completedAt",
        "finalizedAt",
    ] {
        field(&mut input, key, attribution);
    }
    if let Some(attempt) = attempt {
        input["executionAttemptId"] = attempt;
    }
    if child.is_some() {
        input["attemptKind"] = json!("subagent-turn");
    } else {
        field(&mut input, "attemptKind", attribution);
    }
    if let Some(usage) = usage {
        input["usage"] = usage.clone();
    }
    Ok(input)
}
impl RuntimeTelemetry {
    pub fn new(database: Arc<Database>, publish_usage: Publish, logger: Logger) -> Self {
        Self {
            repository: SettingsRepository::new(database),
            publish_usage,
            logger,
        }
    }
    pub async fn record_usage(
        &self,
        owner: &str,
        source: &JsString,
        execution: &Value,
        runtime: &Value,
        usage: Option<&Value>,
        attribution: &Value,
    ) {
        let (project, chat) = (&execution["projectId"], &execution["chatId"]);
        let result = match usage_input(source, project, chat, runtime, usage, attribution) {
            Ok(input) => self.repository.record_token_usage(owner, &input).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => {
                if truthy(Some(project)) {
                    (self.publish_usage)(
                        json!({"ownerId":owner,"projectId":project,"completed":attribution.get("attemptStatus").is_some()&&attribution["attemptStatus"]!="running"}),
                    );
                }
            }
            Err(error) => (self.logger)(LogCall::event(
                "warn",
                "Unable to persist token usage analytics",
                json!({"err":logging::error_details(&error),"sourceKey":source}),
            )),
        }
    }
    pub async fn record_behavior(
        &self,
        owner: &str,
        source: &JsString,
        execution: &Value,
        runtime: &Value,
        tracker: &ModelBehaviorTracker,
        attribution: &Value,
    ) {
        let mut input = json!({"sourceKey":source,"projectId":execution["projectId"],"chatId":execution["chatId"],"modelRouteId":runtime["routeId"],"providerAccountId":runtime["provider"]["accountId"],"workerId":execution["workerId"],"attemptKind":"chat-turn","reasoningEffort":runtime["model"]["reasoningEffort"],"workerVersion":Value::Null,"serverVersion":crate::settings::quota::server_version(),"signalAvailability":json!({"fork":true,"copy":false,"rating":false,"userRetryRegeneration":true,"immediateCorrectiveFollowup":true})});
        for key in [
            "executionAttemptId",
            "attemptStatus",
            "routeAttemptIndex",
            "retryFailoverCount",
            "startedAt",
            "completedAt",
            "finalizedAt",
            "durationMs",
            "turnId",
            "userInterrupted",
            "userRetryRegeneration",
            "immediateCorrectiveFollowup",
            "codexVersion",
        ] {
            field(&mut input, key, attribution);
        }
        if let Value::Object(ref object) = tracker.snapshot() {
            for (key, value) in object {
                if let Value::Object(input) = &mut input {
                    input.insert(key.clone(), value.clone());
                }
            }
        }
        if let Err(error) = self
            .repository
            .record_model_behavior_observation(owner, &input)
            .await
        {
            (self.logger)(LogCall::event(
                "warn",
                "Unable to persist model behavior analytics",
                json!({"err":logging::error_details(&error),"sourceKey":source}),
            ));
        }
    }
    pub fn can_resume(context: &Value, runtime: &Value) -> bool {
        runtime.get("routeId") == context.get("modelRouteId")
            && runtime["provider"].get("accountId") == context.get("providerAccountId")
    }
}
