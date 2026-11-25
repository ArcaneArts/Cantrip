use super::*;
use crate::{
    chats::{live_mutations::MessageOptions, message_queries::MessageKind, steering},
    native_commands,
};

impl Service {
    pub(super) async fn steer_active(&self, owner: &str, chat: &str) -> Result<()> {
        let native = native_commands::Repository::new(self.dependencies.database.clone());
        let control = native.control_context(owner, chat).await?;
        let Some(activation) = control["activationGeneration"].as_str() else {
            return Ok(());
        };
        let context = &control["context"];
        let worker = text(&context["workerId"])?;
        let Some(claim) = self.queue.claim_next_steer(owner, chat, activation).await? else {
            return Ok(());
        };
        let claim_id = text(&claim["id"])?;
        let delivery = self
            .deliver_steer(owner, chat, &worker, &control, &claim, &claim_id)
            .await;
        if delivery.is_err() {
            // The claim can only be released here if no native operation
            // admitted it. A worker that forwarded input owns its settlement.
            self.queue.defer_unadmitted(owner, chat, &claim_id).await?;
        }
        delivery?;
        // Process the next prompt against fresh durable turn state.
        drop(self.dispatch(owner, chat));
        Ok(())
    }

    async fn deliver_steer(
        &self,
        owner: &str,
        chat: &str,
        worker: &str,
        control: &Value,
        claim: &Value,
        claim_id: &str,
    ) -> Result<()> {
        let prompt = self
            .prompts
            .get_encrypted(owner, &text(&claim["promptId"])?)
            .await?
            .context("Claimed steering prompt is unavailable")?;
        let context = &control["context"];
        let attachments = self
            .chats
            .prompt_attachments(owner, context, &prompt["classification"]["attachmentIds"])
            .await?;
        let mut command = steering::native_command(
            control,
            &prompt,
            json!(
                attachments
                    .iter()
                    .map(super::super::turn_storage::attachment_summary)
                    .collect::<Vec<_>>()
            ),
        );
        let operation = json!(format!("council-steer:{claim_id}"));
        steering::bind_claim(&mut command, &prompt, claim, &operation)?;
        if context["contextKind"] == "project" {
            command["control"]["recoverQueueSteer"] = json!(true);
        }
        self.dependencies
            .commands
            .request(worker, command, None, None)
            .await?;

        let attribution = steering::attribution(context);
        self.dependencies
            .live
            .write_message(
                owner,
                chat,
                &prompt["pendingMessage"],
                MessageOptions {
                    attribution: attribution.as_ref(),
                    kind: MessageKind::Encrypted,
                    upsert: false,
                    routing: None,
                },
            )
            .await?;
        Ok(())
    }
}
