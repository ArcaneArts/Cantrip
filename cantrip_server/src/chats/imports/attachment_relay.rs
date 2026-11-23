use super::{failures::Offline, service::Service, *};
use crate::settings::parse_response;
impl Service {
    pub(super) async fn transfer_attachments(
        &self,
        claimed: &Value,
        descriptors: &Value,
    ) -> Result<Vec<Value>> {
        let job = &claimed["job"];
        let target = text(&job["targetPlacement"]["workerId"])?;
        let source = text(&job["sourceWorkerId"])?;
        let mut imported = Vec::new();
        for descriptor in descriptors.as_array().context("Import attachments")? {
            let id = &descriptor["id"];
            if descriptor["status"] != "available" {
                imported.push(json!({"descriptor":descriptor,"id":id}));
                continue;
            }
            if !self.dependencies.commands.is_connected(&target) {
                return Err(Offline.into());
            }
            let operation = uuid::Uuid::new_v4().to_string();
            let mut upload_started = false;
            let transfer:Result<()>=async {
                self.dependencies.commands.request(&target,json!({"type":"attachment.upload.begin","chatId":job["id"],"attachmentId":id,"operationId":operation,"direction":"relay","protectedMetadata":descriptor["protectedMetadata"],"sizeBytes":descriptor["sizeBytes"]}),None,None).await?;
                upload_started=true;
                let size=descriptor["sizeBytes"].as_f64().context("Import attachment size")?;
                let (mut offset,mut sequence)=(0.0,0_u64);
                while offset<size || (size==0.0&&offset==0.0) {
                    let response=self.dependencies.commands.request(&source,json!({"type":"external.chat-history.attachment.read","ownerId":claimed["ownerId"],"chatId":job["id"],"sourceKind":job["sourceKind"],"sourceId":job["sourceId"],"sourceThreadId":job["sourceThreadId"],"attachmentId":descriptor["sourceAttachmentId"],"targetAttachmentId":id,"operationId":operation,"sequence":sequence,"offset":offset,"limit":262144}),None,None).await?;
                    let response=parse_response("externalChatAttachmentReadResultSchema",response.as_ref())?;
                    anyhow::ensure!(response["status"]!="unavailable","The source attachment became unavailable.");
                    anyhow::ensure!(response["sizeBytes"]==descriptor["sizeBytes"],"The source attachment changed during import.");
                    let chunk=&response["chunk"];
                    let count=chunk["plaintextBytes"].as_f64().context("Import attachment byte count")?;
                    let eof=chunk["eof"].as_bool().context("Import attachment EOF")?;
                    anyhow::ensure!(chunk["sequence"]==json!(sequence)&&count<=262144.0_f64.min(size-offset)&&(eof||count!=0.0),"The source worker returned an invalid attachment stream.");
                    self.dependencies.commands.request(&target,json!({"type":"attachment.upload.chunk","chatId":job["id"],"attachmentId":id,"operationId":operation,"direction":"relay","chunk":chunk}),None,None).await?;
                    offset+=count;sequence+=1;
                    if eof {anyhow::ensure!(offset==size,"The source attachment was truncated.");break;}
                    anyhow::ensure!(offset!=size,"The source worker did not terminate the attachment stream.");
                }
                let uploaded=self.dependencies.commands.request(&target,json!({"type":"attachment.upload.complete","chatId":job["id"],"attachmentId":id,"operationId":operation}),None,None).await?;
                let uploaded=parse_response("workerAttachmentUploadResultSchema",uploaded.as_ref())?;
                upload_started=false;
                if uploaded["sizeBytes"]!=descriptor["sizeBytes"]||uploaded["verified"]!=true {
                    self.dependencies.commands.request(&target,json!({"type":"attachment.delete","chatId":job["id"],"attachmentId":id}),None,None).await?;
                    anyhow::bail!("The destination worker failed imported attachment verification.");
                }
                Ok(())
            }.await;
            if let Err(error) = transfer {
                if upload_started {
                    let _=self.dependencies.commands.request(&target,json!({"type":"attachment.delete","chatId":job["id"],"attachmentId":id}),None,None).await;
                }
                return Err(error);
            }
            imported.push(json!({"descriptor":descriptor,"id":id}));
        }
        Ok(imported)
    }
}
