//! Relay authenticated ciphertext; only the workers handle attachment plaintext.
use super::{
    execute::{execution_error, unavailable},
    service::Service,
    *,
};
use crate::settings::parse_response;
impl Service {
    pub(super) async fn relay_attachments(&self, claimed: &Value) -> Result<()> {
        let target = text(&claimed["job"]["targetPlacement"]["workerId"])?;
        let chat = &claimed["job"]["chatId"];
        for item in claimed["snapshot"]["payload"]["attachments"]
            .as_array()
            .context("Relocation attachments")?
        {
            let attachment = &item["attachment"];
            let id = text(&attachment["id"])?;
            if self
                .repository
                .is_attachment_available(&id, &target)
                .await?
            {
                continue;
            }
            let mut candidates = vec![item["sourceWorkerId"].clone()];
            candidates.extend(
                item["availableWorkerIds"]
                    .as_array()
                    .context("Attachment workers")?
                    .iter()
                    .cloned(),
            );
            let mut source = None;
            for candidate in candidates {
                let worker = text(&candidate)?;
                if self.dependencies.commands.is_connected(&worker) {
                    source = Some(worker);
                    break;
                }
            }
            let source = source.ok_or_else(|| {
                execution_error(
                    "attachment-unavailable",
                    "No online worker has the required attachment content.",
                    true,
                )
            })?;
            let operation = uuid::Uuid::new_v4().to_string();
            let transferred:Result<()>=async {
                self.dependencies.commands.request(&target,json!({"type":"attachment.upload.begin","chatId":chat,"attachmentId":id,"operationId":operation,"direction":"relay","protectedMetadata":attachment["protectedMetadata"],"sizeBytes":attachment["sizeBytes"]}),None,None).await?;
                let size=attachment["sizeBytes"].as_f64().context("Attachment size")?;
                let (mut offset,mut sequence)=(0.0,0_u64);
                while offset<size||(size==0.0&&offset==0.0) {
                    let response=self.dependencies.commands.request(&source,json!({"type":"attachment.read","chatId":chat,"attachmentId":id,"operationId":operation,"direction":"relay","protectedMetadata":attachment["protectedMetadata"],"sequence":sequence,"offset":offset,"limit":262144}),None,None).await?;
                    let chunk=parse_response("workerAttachmentReadResultSchema",response.as_ref())?;
                    anyhow::ensure!(chunk["sizeBytes"]==attachment["sizeBytes"],"Attachment size changed during relocation.");
                    let count=chunk["chunk"]["plaintextBytes"].as_f64().context("Attachment plaintext byte count")?;
                    let eof=chunk["chunk"]["eof"].as_bool().context("Attachment EOF")?;
                    anyhow::ensure!(chunk["chunk"]["sequence"]==json!(sequence)&&count<=262144.0_f64.min((size-offset).max(0.0))&&(eof||count!=0.0),"Attachment source returned an invalid chunk.");
                    self.dependencies.commands.request(&target,json!({"type":"attachment.upload.chunk","chatId":chat,"attachmentId":id,"operationId":operation,"direction":"relay","chunk":chunk["chunk"]}),None,None).await?;
                    offset+=count;sequence+=1;
                    if eof {anyhow::ensure!(offset==size,"Attachment source truncated the content.");break;}
                    anyhow::ensure!(offset<size,"Attachment source did not terminate the stream.");
                }
                let response=self.dependencies.commands.request(&target,json!({"type":"attachment.upload.complete","chatId":chat,"attachmentId":id,"operationId":operation}),None,None).await?;
                let uploaded=parse_response("workerAttachmentUploadResultSchema",response.as_ref())?;
                anyhow::ensure!(uploaded["verified"]==true&&uploaded["sizeBytes"]==attachment["sizeBytes"],"Target attachment verification failed.");
                self.repository.mark_attachment_available(&id,&target).await?;
                Ok(())
            }.await;
            if let Err(error) = transferred {
                let _ = self
                    .dependencies
                    .commands
                    .request(
                        &target,
                        json!({"type":"attachment.delete","chatId":chat,"attachmentId":id}),
                        None,
                        None,
                    )
                    .await;
                if unavailable(&error) {
                    return Err(error);
                }
                let message = crate::settings::operation_error_message(&error);
                let mut units = "Could not transfer attachment content: "
                    .encode_utf16()
                    .collect::<Vec<_>>();
                units.extend_from_slice(message.units());
                return Err(execution_error(
                    "attachment-unavailable",
                    crate::wire::JsString::new(units),
                    true,
                ));
            }
        }
        Ok(())
    }
}
