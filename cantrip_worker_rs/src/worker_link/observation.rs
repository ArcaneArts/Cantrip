//! Provisional observation envelopes match the client contract. Durable
//! outcomes remain on the command and notification connection.
use crate::http::checked;
use cantrip_wire::{JsString, Value, value::json};
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};

pub(super) struct Observation {
    pub topic: &'static str,
    pub operation: JsString,
    pub sequence: Option<u64>,
    turn: Value,
    message: Value,
    observed: Value,
    payload: Value,
}

impl Observation {
    pub fn from_event(command: &Value, event: &Value) -> Option<Self> {
        let kind = event["type"].as_str()?;
        let (turn, message, sequence) = match kind {
            "agent.activity" => (
                &event["activity"]["correlation"]["turnId"],
                &event["activity"]["id"],
                None,
            ),
            "agent.message" => (
                &event["message"]["correlation"]["turnId"],
                &event["message"]["id"],
                None,
            ),
            "agent.protected-message" | "agent.protected-task-message" => {
                (&event["telemetry"]["turnId"], &event["message"]["id"], None)
            }
            "agent.inference-progress" => (
                &Value::Null,
                &event["progress"]["requestId"],
                event["progress"]["sequence"].as_u64(),
            ),
            _ => return None,
        };
        let topic = "chat-progress";
        Some(Self {
            topic,
            operation: command["clientMessageId"].as_js_string()?.clone(),
            sequence,
            turn: turn.clone(),
            message: message.clone(),
            observed: now(),
            payload: json!({
                "topic":topic,"chatId":command["chatId"],
                "clientMessageId":command["clientMessageId"],
                "executionLaneId":command["executionLaneId"],
                "contextKind":command["contextKind"],
                "worktreeId":command["worktreeId"],"scratchRootId":command["scratchRootId"],
                "event":event,
            }),
        })
    }

    pub fn from_notification(value: &Value) -> Option<Self> {
        let kind = value["type"].as_str()?;
        let (topic, parts): (_, &[&Value]) = match kind {
            "worktree.filesystem.changed" => (
                "filesystem",
                &[&value["sourcePath"], &value["worktreePath"]],
            ),
            "worktree.inventory.observed" => ("worktree", &[&value["sourcePath"]]),
            "worktree.status.observed" => {
                ("worktree", &[&value["sourcePath"], &value["worktreePath"]])
            }
            "git.operation.observed" => ("worktree", &[&value["projectId"], &value["worktreeId"]]),
            "terminal.runtime.observed" => ("runtime", &[&value["terminalId"]]),
            "codegraph.status.observed" => (
                "runtime",
                &[
                    &value["status"]["projectId"],
                    &value["status"]["worktreeId"],
                ],
            ),
            "project.run-configuration-runtime.observed" => (
                "runtime",
                &[
                    &value["observation"]["projectId"],
                    &value["observation"]["runtimeId"],
                ],
            ),
            "project.run-configuration-definitions.changed" => (
                "runtime",
                &[
                    &value["projectId"],
                    value["change"]
                        .get("id")
                        .filter(|id| !id.is_null())
                        .unwrap_or(&value["sourcePath"]),
                ],
            ),
            _ => return None,
        };
        let mut hash = Sha256::new();
        for part in parts {
            append(&mut hash, part.as_js_string()?);
        }
        let operation = if kind == "git.operation.observed" {
            value["operationId"].as_js_string()?.clone()
        } else {
            super::hex_digest(&hash.finalize()).into()
        };
        let mut message = Sha256::new();
        append(&mut message, value["type"].as_js_string()?);
        for part in parts {
            append(&mut message, part.as_js_string()?);
        }
        // This carrier goes through Core. Retain the existing private-path
        // invalidation used by the control connection.
        let notification = crate::git::worktrees::observations::notification::for_server(value);
        Some(Self {
            topic,
            operation,
            sequence: None,
            turn: Value::Null,
            message: json!(super::hex_digest(&message.finalize())),
            observed: if kind == "git.operation.observed" {
                value["observedAt"].clone()
            } else {
                now()
            },
            payload: json!({"topic":topic,"notification":notification}),
        })
    }

    pub fn envelope(
        &self,
        subscription: &Value,
        continuity: u64,
        sequence: u64,
    ) -> Option<Vec<u8>> {
        let value = checked(
            "workerObservationEnvelopeSchema",
            &json!({
                "protocolVersion":1,"subscriptionId":subscription,"continuitySequence":continuity,
                "observedAt":self.observed,
                "identity":json!({"operationId":self.operation,"turnId":self.turn,"messageId":self.message,"sequence":sequence}),
                "payload":self.payload,
            }),
        )
        .ok()?;
        Some(value.stringify().into_bytes())
    }
}

fn append(hash: &mut Sha256, part: &JsString) {
    hash.update(part.lossy().as_bytes());
    hash.update([0]);
}

fn now() -> Value {
    json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
}
