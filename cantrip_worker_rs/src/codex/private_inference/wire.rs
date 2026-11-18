use super::*;
use cantrip_wire::value::json;

/// Core's exact physical request identity. A logical thread/turn pair is not a
/// claim and may appear in more than one runner or inference scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub thread_id: JsString,
    pub turn_id: JsString,
    pub runner_generation: JsString,
    pub attempt_id: JsString,
}

impl Key {
    pub(super) fn parse(raw: &Value) -> Result<Self> {
        let field = |name: &str| {
            raw[name]
                .as_js_string()
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or_else(|| anyhow!("Invalid private inference request identity: {name}."))
        };
        Ok(Self {
            thread_id: field("threadId")?,
            turn_id: field("turnId")?,
            runner_generation: field("runnerGeneration")?,
            attempt_id: field("attemptId")?,
        })
    }

    pub(super) fn resolve_params(&self, scope: Option<&JsString>) -> Value {
        let operation = scope.map(|scope| {
            let units = "inference:"
                .encode_utf16()
                .chain(scope.units().iter().copied())
                .chain([u16::from(b':')])
                .chain(self.attempt_id.units().iter().copied())
                .collect();
            JsString::new(units)
        });
        json!({
            "threadId":self.thread_id, "runnerGeneration":self.runner_generation,
            "attemptId":self.attempt_id, "operationGeneration":operation, "allow":scope.is_some()
        })
    }
}

/// Only these phases have a pending resolve barrier in Core.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Begin,
    BeginIndependent,
    Suspend,
    Resume,
}
impl Phase {
    pub(super) fn is_begin(self) -> bool {
        matches!(self, Self::Begin | Self::BeginIndependent)
    }
}

#[derive(Clone, Debug)]
pub struct Gate {
    pub key: Key,
    pub phase: Phase,
    pub scope_id: JsString,
    pub root_thread_id: Option<JsString>,
    pub goal_epoch: Option<JsString>,
}

impl Gate {
    pub fn root_thread(&self) -> &JsString {
        self.root_thread_id.as_ref().unwrap_or(&self.key.thread_id)
    }

    pub(super) fn claim_params(&self) -> Value {
        json!({
            "threadId":self.key.thread_id, "turnId":self.key.turn_id, "scopeId":self.scope_id,
            "runnerGeneration":self.key.runner_generation, "attemptId":self.key.attempt_id
        })
    }
}

pub(super) enum Control {
    Gate(Gate),
    Finish {
        scope: JsString,
        failed_before_output: bool,
    },
    Cancel {
        scope: JsString,
        request: Option<JsString>,
    },
}

impl Control {
    pub(super) fn parse(key: &Key, raw: &Value) -> Result<Self> {
        let input = &raw["input"];
        let scope = input["scopeId"]
            .as_js_string()
            .filter(|value| is_uuid(value))
            .ok_or_else(|| anyhow!("The private inference scope ID is invalid."))?
            .clone();
        let request = optional_string(input, "requestId", false)?;
        let root_thread_id = optional_string(input, "rootThreadId", false)?;
        let goal_epoch = optional_string(raw, "goalEpoch", true)?;
        let failed_before_output = match input.get("modelFailedBeforeOutput") {
            None => false,
            Some(value) => value
                .as_bool()
                .ok_or_else(|| anyhow!("Invalid private inference failure evidence."))?,
        };
        let phase = match input["phase"].as_str() {
            Some("cancel") => return Ok(Self::Cancel { scope, request }),
            Some("finish") => {
                return Ok(Self::Finish {
                    scope,
                    failed_before_output,
                });
            }
            Some("begin") => Phase::Begin,
            Some("begin-independent") => Phase::BeginIndependent,
            Some("suspend") => Phase::Suspend,
            Some("resume") => Phase::Resume,
            _ => bail!("The private inference phase is invalid."),
        };
        Ok(Self::Gate(Gate {
            key: key.clone(),
            phase,
            scope_id: scope,
            root_thread_id,
            goal_epoch,
        }))
    }
}

/// The worker's current strict receipt of Core's inferenceClaim response.
pub(super) fn verify_claim(receipt: Value) -> Result<Value> {
    let invalid = || anyhow!("Core returned an invalid private inference claim.");
    let Value::Object(fields) = &receipt else {
        return Err(invalid());
    };
    if fields.keys().any(|key| {
        !matches!(
            key.as_str(),
            Some("claimed" | "goalEpoch" | "inferenceOnly")
        )
    }) || receipt["claimed"].as_bool().is_none()
        || receipt
            .get("inferenceOnly")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err(invalid());
    }
    optional_string(&receipt, "goalEpoch", true).map_err(|_| invalid())?;
    Ok(receipt)
}

fn optional_string(raw: &Value, key: &str, nonempty: bool) -> Result<Option<JsString>> {
    match raw.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_js_string()
            .filter(|s| !nonempty || !s.is_empty())
            .cloned()
            .map(Some)
            .ok_or_else(|| anyhow!("Invalid private inference field: {key}.")),
    }
}

fn is_uuid(value: &JsString) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    if text.len() != 36 {
        return false;
    }
    let Ok(uuid) = uuid::Uuid::parse_str(text) else {
        return false;
    };
    let bytes = uuid.as_bytes();
    uuid.is_nil()
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
        || (bytes[8] & 0xc0 == 0x80 && (1..=8).contains(&(bytes[6] >> 4)))
}
