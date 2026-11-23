//! The Core attachment command adapter for ordinary uploads and worker relays.
use super::Store;
use crate::{encryption::Service, filesystem::Scope, http::checked};
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::content::{
    decrypt_attachment_chunk, decrypt_attachment_metadata, encrypt_attachment_chunk,
};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, Weak},
};

type Queue = tokio::sync::Mutex<()>;

pub(crate) struct Commands {
    store: Store,
    queues: Mutex<HashMap<(JsString, JsString), Weak<Queue>>>,
}

impl Commands {
    pub(crate) fn new(data: &Path, logs: Arc<crate::logging::Logs>) -> Result<Self> {
        Ok(Self {
            store: Store::new(data, Some(logs))?,
            queues: Mutex::default(),
        })
    }

    pub(crate) fn supports(kind: &str) -> bool {
        matches!(
            kind,
            "attachment.upload.begin"
                | "attachment.upload.chunk"
                | "attachment.upload.complete"
                | "attachment.read"
                | "attachment.delete"
        )
    }

    pub(crate) async fn execute(
        &self,
        command: &Value,
        service: &Service,
        scope: &Scope,
    ) -> Result<Value> {
        let kind = command["type"]
            .as_str()
            .context("Missing attachment command.")?;
        let chat = text(command, "chatId")?;
        let id = text(command, "attachmentId")?;
        let queue = {
            let key = (chat.clone(), id.clone());
            let mut queues = self.queues.lock().unwrap();
            queues.retain(|_, queue| queue.strong_count() != 0);
            let queue = queues.get(&key).and_then(Weak::upgrade).unwrap_or_default();
            queues.insert(key, Arc::downgrade(&queue));
            queue
        };
        let _guard = tokio::select! {
            _ = scope.stopped() => bail!("Attachment command stopped."),
            guard = queue.lock() => guard,
        };
        scope.check()?;
        let accepted = json!({"accepted":true});
        match kind {
            "attachment.upload.complete" => {
                return self
                    .store
                    .complete(chat, id, text(command, "operationId")?)
                    .await;
            }
            "attachment.delete" => {
                self.store.remove(chat, id).await?;
                return Ok(accepted);
            }
            _ => {}
        }
        let grant = service.bound_component("attachment-content", None)?;
        let identity = (grant.owner_id.clone(), grant.server_id.clone());
        let mut context = json!({"ownerId":grant.owner_id,"chatId":chat,
            "attachmentId":id,"keyRevision":grant.component.key_revision,"operationId":command["operationId"],
            "direction":command["direction"]});
        if kind == "attachment.upload.chunk" {
            let chunk = &command["chunk"];
            context["sequence"] = chunk["sequence"].clone();
            let bytes = decrypt_attachment_chunk(&grant.component.key, &context, chunk)?;
            ensure!(
                service.bound_identity()? == identity,
                "The worker binding changed during attachment upload."
            );
            self.store
                .append(
                    chat,
                    id,
                    number(chunk, "sequence")?,
                    bytes,
                    text(command, "operationId")?,
                    chunk["eof"]
                        .as_bool()
                        .context("Missing attachment end marker.")?,
                )
                .await?;
            return Ok(accepted);
        }
        let metadata = decrypt_attachment_metadata(
            &grant.component.key,
            &context,
            &command["protectedMetadata"],
        )?;
        ensure!(
            service.bound_identity()? == identity,
            "The worker binding changed during attachment processing."
        );
        let filename = text(&metadata, "fileName")?;
        match kind {
            "attachment.upload.begin" => {
                ensure!(
                    metadata["error"].is_null(),
                    "Unavailable attachment metadata cannot be uploaded."
                );
                self.store
                    .begin(
                        chat,
                        id,
                        filename,
                        number(command, "sizeBytes")?,
                        text(command, "operationId")?,
                        metadata["sha256"]
                            .as_str()
                            .context("Missing attachment digest.")?
                            .to_owned(),
                    )
                    .await?;
                Ok(accepted)
            }
            "attachment.read" => {
                let data = self
                    .store
                    .read(
                        chat,
                        id,
                        filename,
                        number(command, "offset")?,
                        number(command, "limit")?,
                    )
                    .await?;
                ensure!(
                    service.bound_identity()? == identity,
                    "The worker binding changed during attachment read."
                );
                context["sequence"] = command["sequence"].clone();
                context["eof"] = json!(data.eof);
                let chunk = encrypt_attachment_chunk(&grant.component.key, &context, &data.bytes)?;
                checked(
                    "workerAttachmentReadResultSchema",
                    &json!({"chunk":chunk,"sizeBytes":data.size_bytes}),
                )
            }
            _ => bail!("Unsupported attachment command."),
        }
    }
}

fn text(value: &Value, key: &str) -> Result<JsString> {
    value[key]
        .as_js_string()
        .cloned()
        .context("Missing attachment text field.")
}

fn number(value: &Value, key: &str) -> Result<f64> {
    value[key]
        .as_f64()
        .context("Missing attachment number field.")
}
