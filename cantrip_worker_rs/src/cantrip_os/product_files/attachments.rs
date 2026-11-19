//! Materialize uploaded Chat attachments with the legacy guest operation identity.
#[cfg(all(feature = "guest-files", target_os = "linux"))]
pub(super) mod guest;

use super::{ProductFiles, text};
use crate::{
    attachments::paths::{MAX_BYTES, safe_filename},
    encryption::Service,
    filesystem::Scope,
    run_definitions::repository::read_bounded,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::{Zeroizing, content::attachment_digest};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

pub(super) const REQUEST: &str = "chat.attachment.materialize";
pub(super) const RESULT: &str = "chat.attachment.materialized";

impl ProductFiles {
    pub(crate) async fn materialize(
        &self,
        execution: &Value,
        metadata: &Value,
        path: &Path,
        server: &JsString,
        image_input: bool,
        service: &Service,
    ) -> Result<(JsString, Option<Value>)> {
        ensure!(
            metadata["status"] == "ready",
            "The uploaded attachment is not ready."
        );
        let size = size(metadata)?;
        let path = path.to_owned();
        let bytes = tokio::task::spawn_blocking(move || read_bounded(&path, size as u64)).await??;
        let bytes = Zeroizing::new(bytes);
        let sha256 = attachment_digest(&bytes);
        ensure!(
            bytes.len() == size && (metadata["sha256"].is_null() || metadata["sha256"] == sha256),
            "The uploaded attachment changed before Linux materialization."
        );
        let filename = metadata["fileName"]
            .as_js_string()
            .context("Missing attachment filename.")?;
        // Keep schema property order for the Node helper's operation and receipt digests.
        let request = json!({
            "type": REQUEST, "chatId": metadata["chatId"], "attachmentId": metadata["id"],
            "fileName": safe_filename(filename), "sizeBytes": size, "sha256": sha256,
            "dataBase64": STANDARD.encode(&*bytes),
        });
        drop(bytes);
        let mut operation = [0_u8; 16];
        operation.copy_from_slice(&Sha256::digest(request.stringify().as_bytes())[..16]);
        operation[6] = (operation[6] & 15) | 80;
        operation[8] = (operation[8] & 63) | 128;
        let context = json!({
            "serverId": server, "surfaceKind": "chat-files", "surfaceId": metadata["chatId"],
            "operationId": Uuid::from_bytes(operation).to_string(), "sequence": 0,
        });
        let (outcome, complete) = self
            .execute(execution, &request, &context, service, &Scope::default())
            .await?;
        if outcome["ok"] != true {
            anyhow::bail!("{}", text(&outcome, "error")?);
        }
        let receipt = &outcome["result"]["value"];
        ensure!(
            complete
                && outcome["result"]["type"] == RESULT
                && receipt["sha256"] == request["sha256"]
                && receipt["sizeBytes"] == request["sizeBytes"],
            "Misrouted Linux attachment receipt."
        );
        let path = receipt["path"]
            .as_js_string()
            .context("Missing Linux attachment path.")?;
        // The app-server runs on the worker. Inline images carry bytes without
        // making a worker path available to the guest or model.
        let image = if image_input {
            let mime = text(metadata, "mimeType")?;
            let bytes = text(&request, "dataBase64")?;
            Some(json!({"type":"image","url":format!("data:{mime};base64,{bytes}")}))
        } else {
            None
        };
        Ok((path.clone(), image))
    }
}

fn size(value: &Value) -> Result<usize> {
    value["sizeBytes"]
        .as_u64()
        .filter(|size| *size <= MAX_BYTES as u64)
        .map(|size| size as usize)
        .context("Linux attachment is too large or has an invalid size.")
}

fn hash(value: &Value) -> Result<&str> {
    let hash = text(value, "sha256")?;
    ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f')),
        "Invalid Linux attachment digest."
    );
    Ok(hash)
}

pub(super) fn validate_receipt(receipt: &Value) -> Result<&str> {
    size(receipt)?;
    hash(receipt)?;
    let path = text(receipt, "path")?;
    ensure!(
        path.starts_with('/') && !path.contains('\0'),
        "Invalid Linux attachment path."
    );
    Ok(path)
}
