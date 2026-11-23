//! Canonical transcript bytes remain opaque and match JavaScript UTF-16 key order.
use crate::{
    settings::parse_response,
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc, time::Duration};

const CHUNK_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const HYDRATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy)]
pub enum Error {
    DigestMismatch,
    TargetMismatch,
    TooManySkills,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::DigestMismatch => "digest-mismatch",
            Self::TargetMismatch => "target-mismatch",
            Self::TooManySkills => "too-many-skills",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::DigestMismatch => "The immutable canonical transcript failed server-side digest verification.",
            Self::TargetMismatch => "The target worker returned hydration state for a different snapshot.",
            Self::TooManySkills => "The canonical transcript references more than 64 skills and cannot be hydrated safely.",
        })
    }
}
impl std::error::Error for Error {}

pub struct Input<'a> {
    pub chat_id: &'a Value,
    pub cwd: &'a Value,
    pub expected_sha256: Option<&'a Value>,
    pub mcp_servers: &'a Value,
    pub payload: &'a Value,
    pub permission_profile_id: &'a Value,
    pub plan_mode: &'a Value,
    pub runtime: &'a Value,
    pub snapshot_id: &'a Value,
    pub worker_id: &'a str,
}

pub fn required_skills(payload: &Value) -> Result<Vec<Value>> {
    if payload["kind"] != "visible" {
        return Ok(Vec::new());
    }
    let mut names = BTreeSet::new();
    for message in payload["messages"]
        .as_array()
        .context("Canonical messages")?
    {
        for item in message["content"]
            .as_array()
            .context("Canonical message content")?
        {
            if item["type"] == "text" {
                for name in super::turn_runtime::payload::mentioned_skills(&item["text"])? {
                    names.insert(name.as_str().context("ASCII skill name")?.to_owned());
                }
            }
        }
    }
    if names.len() > 64 {
        return Err(Error::TooManySkills.into());
    }
    Ok(names.into_iter().map(|name| json!(name)).collect())
}

pub async fn hydrate(commands: &Arc<LimitedCommandBus>, input: Input<'_>) -> Result<Value> {
    let bytes = encode_canonical_payload(input.payload);
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if input
        .expected_sha256
        .is_some_and(|expected| truthy(Some(expected)) && expected != &json!(digest))
    {
        return Err(Error::DigestMismatch.into());
    }
    let skills = required_skills(input.payload)?;
    let begin = commands.request(input.worker_id, json!({
        "type":"chat.relocation.hydration.begin", "chatId":input.chat_id,
        "snapshotId":input.snapshot_id, "transcriptSha256":digest,
        "sizeBytes":bytes.len(), "cwd":input.cwd, "requiredSkillNames":skills,
        "planMode":input.plan_mode, "model":input.runtime["model"],
        "provider":input.runtime["provider"], "permissionProfileId":input.permission_profile_id,
        "mcpServers":input.mcp_servers
    }), Some(REQUEST_TIMEOUT), None).await?;
    let begin = parse_response("chatRelocationHydrationBeginResultSchema", begin.as_ref())?;
    if begin["status"] == "hydrated" {
        return Ok(json!({"threadId":begin["threadId"],"transcriptSha256":digest}));
    }
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        commands
            .request(
                input.worker_id,
                json!({
                    "type":"chat.relocation.hydration.chunk", "snapshotId":input.snapshot_id,
                    "chunkIndex":index, "data":STANDARD.encode(chunk)
                }),
                Some(REQUEST_TIMEOUT),
                None,
            )
            .await?;
    }
    let hydrated = commands
        .request(
            input.worker_id,
            json!({
                "type":"chat.relocation.hydration.complete", "snapshotId":input.snapshot_id
            }),
            Some(HYDRATION_TIMEOUT),
            None,
        )
        .await?;
    let hydrated = parse_response("chatRelocationHydrationResultSchema", hydrated.as_ref())?;
    if &hydrated["snapshotId"] != input.snapshot_id || hydrated["transcriptSha256"] != json!(digest)
    {
        return Err(Error::TargetMismatch.into());
    }
    Ok(json!({"threadId":hydrated["threadId"],"transcriptSha256":digest}))
}

pub fn encode_canonical_payload(value: &Value) -> Vec<u8> {
    enum Part<'a> {
        Value(&'a Value),
        Key(&'a JsString),
        Text(&'static str),
    }
    let mut pending = vec![Part::Value(value)];
    let mut output = String::new();
    while let Some(part) = pending.pop() {
        match part {
            Part::Text(text) => output.push_str(text),
            Part::Key(key) => output.push_str(&Value::String(key.clone()).stringify()),
            Part::Value(Value::Array(values)) => {
                output.push('[');
                pending.push(Part::Text("]"));
                for (i, item) in values.iter().enumerate().rev() {
                    pending.push(Part::Value(item));
                    if i > 0 {
                        pending.push(Part::Text(","));
                    }
                }
            }
            Part::Value(Value::Object(values)) => {
                output.push('{');
                pending.push(Part::Text("}"));
                let mut entries = values.iter().collect::<Vec<_>>();
                entries.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));
                for (i, (key, item)) in entries.into_iter().enumerate().rev() {
                    pending.push(Part::Value(item));
                    pending.push(Part::Text(":"));
                    pending.push(Part::Key(key));
                    if i > 0 {
                        pending.push(Part::Text(","));
                    }
                }
            }
            Part::Value(value) => output.push_str(&value.stringify()),
        }
    }
    output.into_bytes()
}
