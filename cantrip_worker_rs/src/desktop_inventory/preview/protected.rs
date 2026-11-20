//! Protected preview actions and image chunks use the existing endpoint codec.
use super::{
    Lease,
    native::{Rejected, ResultData},
};
use crate::{
    encryption::Service,
    http::checked,
    protected_content::{open_endpoint_bytes, protect_endpoint_bytes, protect_endpoint_content},
};
use anyhow::{Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};

const CONTROL_BYTES: usize = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 256 * 1024;
const MAX_CHUNKS: usize = 64;

pub(super) struct Content<'a> {
    encryption: &'a Service,
    request: &'a Value,
    binding: Value,
}

impl<'a> Content<'a> {
    pub(super) fn new(encryption: &'a Service, lease: &Lease, request: &'a Value) -> Self {
        let scope = json!(vec![
            json!("cua-preview-v1"),
            lease.authority["chatId"].clone(),
            json!(lease.id)
        ]);
        Self {
            encryption,
            request,
            binding: json!({
                "domain":"client-control-content","serverId":lease.authority["serverId"],
                "workerId":lease.authority["workerId"],"scopeId":scope.stringify(),
                "operationId":request["operationId"],"operation":request["operation"],
                "direction":"request","sequence":0,
            }),
        }
    }

    pub(super) fn open(&self) -> Result<Value> {
        let bytes = open_endpoint_bytes(
            self.encryption,
            &self.binding,
            &self.request["protectedContent"],
        )?;
        ensure!(
            bytes.len() <= CONTROL_BYTES,
            "Computer-use request is too large."
        );
        let text = std::str::from_utf8(&bytes)?;
        let action = checked(
            "computerUseNativePreviewActionSchema",
            &parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(text))
                .map_err(|_| anyhow::anyhow!("Invalid computer-use action."))?,
        )?;
        ensure!(
            action["operation"] == self.request["operation"],
            "Computer-use operation binding changed."
        );
        Ok(action)
    }

    pub(super) fn respond(
        mut self,
        result: Result<ResultData>,
        assert_delivery: impl Fn(bool) -> Result<()>,
        emit: impl Fn(Value) -> Result<()>,
    ) -> Result<Value> {
        let operation = &self.request["operation"];
        let active_required = result.is_ok();
        let (result, pixels) = match result {
            Ok(result) => {
                let chunks = result.pixels.len().div_ceil(CHUNK_BYTES);
                ensure!(chunks <= MAX_CHUNKS, "Computer-use capture is too large.");
                if !result.pixels.is_empty() {
                    let image = &result.data["image"];
                    let digest = Sha256::digest(&*result.pixels)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    ensure!(
                        image["byteCount"].as_u64() == Some(result.pixels.len() as u64)
                            && image["sha256"] == digest,
                        "Computer-use capture does not match its native metadata."
                    );
                }
                (
                    json!({"status":"ok","operation":operation,"data":result.data,"chunkCount":chunks}),
                    Some(result.pixels),
                )
            }
            Err(error) => {
                let (code, message, outcome) = error.downcast_ref::<Rejected>().map_or(
                    (
                        "operation-failed",
                        "Computer-use operation could not be completed or authenticated.",
                        "rejected",
                    ),
                    |error| (error.code.as_str(), error.message, error.outcome),
                );
                (
                    json!({"status":"error","operation":operation,"code":code,
                    "message":message,"outcome":outcome}),
                    None,
                )
            }
        };
        assert_delivery(active_required)?;
        self.binding["direction"] = json!("response");
        let protected = protect_endpoint_content(
            self.encryption,
            &self.binding,
            &result,
            "computerUseNativePreviewResultSchema",
        )?;
        let revision = &protected["keyRevision"];
        if let Some(pixels) = pixels {
            self.binding["direction"] = json!("event");
            for (sequence, slice) in pixels.chunks(CHUNK_BYTES).enumerate() {
                assert_delivery(true)?;
                self.binding["sequence"] = json!(sequence);
                let content = protect_endpoint_bytes(self.encryption, &self.binding, slice)?;
                ensure!(
                    &content["keyRevision"] == revision,
                    "Computer-use capture key changed."
                );
                emit(checked(
                    "computerUseChunkEventSchema",
                    &json!({
                        "type":"computer-use.snapshot.chunk","operationId":self.request["operationId"],
                        "sequence":sequence,"protectedContent":content,
                    }),
                )?)?;
            }
        }
        assert_delivery(active_required)?;
        checked(
            "computerUseResponseSchema",
            &json!({"operationId":self.request["operationId"],"protectedContent":protected}),
        )
    }
}
