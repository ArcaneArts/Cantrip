//! Protected Cantrip OS system checkpoints and operation outcomes.
use super::{aad, authenticate, encode_json, open_field, seal_field};
use crate::{Zeroizing, checked, decryption_error, encode};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
pub enum SystemFrame {
    Manifest,
    Chunk,
    End,
    Result,
}

impl SystemFrame {
    pub const METADATA_BYTES: usize = 16 * 1024 * 1024;
    pub const CHUNK_BYTES: usize = 1024 * 1024;
    pub const END_BYTES: usize = 4096;

    fn kind(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::Chunk => "chunk",
            Self::End => "end",
            Self::Result => "result",
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::Manifest | Self::Result => Self::METADATA_BYTES,
            Self::Chunk => Self::CHUNK_BYTES,
            Self::End => Self::END_BYTES,
        }
    }
}

fn identity_fields(context: &Value) -> Vec<Value> {
    [
        "serverId",
        "workerId",
        "instanceId",
        "guestInstanceId",
        "attachmentGeneration",
        "targetGeneration",
        "operationId",
    ]
    .into_iter()
    .map(|field| context[field].clone())
    .collect()
}

fn identity_hash(fields: Vec<Value>) -> String {
    encode(&Sha256::digest(Value::Array(fields).stringify().as_bytes()))
}

pub struct SystemCipher<'a> {
    identity: Value,
    stream_hash: String,
    key: &'a [u8],
}

impl<'a> SystemCipher<'a> {
    pub fn new(context: &Value, stream: &Value, revision: u64, key: &'a [u8]) -> Result<Self> {
        let context = checked("cantripOsSystemCryptoContextSchema", context)?;
        let mut fields = identity_fields(&context);
        fields.extend([
            context["checkpointId"].clone(),
            context["containerId"].clone(),
            stream.clone(),
        ]);
        Ok(Self {
            identity: json!({"ownerId":context["ownerId"],"keyRevision":revision}),
            stream_hash: identity_hash(fields),
            key,
        })
    }

    fn associated(&self, kind: SystemFrame, sequence: u64) -> Result<Value> {
        ensure!(
            sequence <= (1 << 53) - 1,
            "Invalid system archive sequence."
        );
        let row = Value::Array(vec![
            json!(self.stream_hash),
            json!(kind.kind()),
            json!(sequence),
        ])
        .stringify();
        aad(
            &self.identity,
            &json!("repository-content"),
            &json!("protocol:cantrip-os-private-system"),
            &json!(row),
            &json!(format!("private_system_{}", kind.kind())),
        )
    }

    pub fn seal(&self, kind: SystemFrame, sequence: u64, bytes: &[u8]) -> Result<Value> {
        ensure!(
            bytes.len() <= kind.limit(),
            "Private system frame is too large."
        );
        let envelope = seal_field(self.key, &self.associated(kind, sequence)?, bytes)?;
        Ok(json!({"kind":kind.kind(),"sequence":sequence,"envelope":envelope}))
    }

    pub fn open(
        &self,
        kind: SystemFrame,
        sequence: u64,
        frame: &Value,
    ) -> Result<Zeroizing<Vec<u8>>> {
        authenticate(|| {
            let frame = checked("cantripOsSystemFrameSchema", frame)?;
            let envelope = &frame["envelope"];
            ensure!(
                frame["kind"] == kind.kind()
                    && frame["sequence"].as_u64() == Some(sequence)
                    && envelope["keyRevision"] == self.identity["keyRevision"]
                    && envelope["ciphertext"]
                        .as_js_string()
                        .is_some_and(
                            |ciphertext| ciphertext.len() <= (kind.limit() + 16).div_ceil(3) * 4
                        ),
                decryption_error()
            );
            let bytes = open_field(self.key, &self.associated(kind, sequence)?, envelope)?;
            ensure!(bytes.len() <= kind.limit(), decryption_error());
            Ok(bytes)
        })
    }
}

pub fn seal_system_operation_result(
    context: &Value,
    revision: u64,
    key: &[u8],
    outcome: &Value,
) -> Result<Value> {
    let mut context = checked("cantripOsSystemOperationContextSchema", context)?;
    let command = &outcome["command"];
    ensure!(
        command["operationId"] == context["operationId"]
            && command["target"]["generation"] == context["targetGeneration"]
            && command["target"]["containerId"] == context["containerId"]
            && command["scope"]
                .as_object()
                .context("Missing system result scope")?
                .iter()
                .all(
                    |(field, value)| field.as_str().and_then(|name| context.get(name))
                        == Some(value)
                ),
        "The private system result belongs to another admission"
    );
    let plaintext = encode_json(
        "cantripOsSystemPrivateOperationResultSchema",
        outcome,
        SystemFrame::METADATA_BYTES,
        "Private system outcome is too large",
    )?;
    let mut fields = identity_fields(&context);
    fields.push(context["containerId"].clone());
    let row = identity_hash(fields);
    context["keyRevision"] = json!(revision);
    let associated = aad(
        &context,
        &json!("repository-content"),
        &json!("protocol:cantrip-os-system-operations"),
        &json!(row),
        &json!("private_result"),
    )?;
    seal_field(key, &associated, &plaintext)
}
