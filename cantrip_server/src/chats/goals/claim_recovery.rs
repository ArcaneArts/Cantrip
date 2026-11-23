//! Wake an applied Goal's first cycle through its existing canonical claim.
use super::*;
use crate::native_commands::managed_queue::{QueueRepository, deep_equal};

impl Service {
    pub fn recover_managed_goal_claim(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        claim: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, chat, claim) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            claim.clone(),
        );
        self.operations.run(async move {
            this.recover_managed_goal_claim_one(&owner, &chat, &claim)
                .await
        })
    }
    async fn recover_managed_goal_claim_one(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        claim: &Value,
    ) -> Result<()> {
        let queue = QueueRepository::new(self.dependencies.database.clone());
        if queue
            .goal_claim_recovery(owner, chat)
            .await?
            .as_ref()
            .is_none_or(|c| !deep_equal(c, claim))
        {
            return Ok(());
        }
        let context = self
            .chats
            .execution_context(owner, chat)
            .await?
            .context("The Goal first-cycle recovery placement changed.")?;
        anyhow::ensure!(
            context["experience"] == "agent" && context.get("threadId") == claim.get("threadId"),
            "The Goal first-cycle recovery placement changed."
        );
        let runtime = self
            .dependencies
            .routing
            .runtime_for_context(owner, &context)
            .await?
            .context("Selected Goal recovery model was not found.")?;
        let mut command = self
            .dependencies
            .console
            .prepare_launch(owner, &context, &runtime)
            .await?;
        command["type"] = json!("chat.goal.claim-recover");
        command["claim"] = claim.clone();
        command["chatId"] = json!(chat);
        command["cwd"] = context["cwd"].clone();
        command["subagentDefaults"] = command["subagentDefaults"].clone();
        command["mcpServers"] = selected(command.get("mcpServers"), &Value::Array(Vec::new()));
        command["planMode"] = selected(command.get("planMode"), &json!("default"));
        command["permissionProfileId"] =
            managed_console::permission_profile(&context)["effectiveId"].clone();
        let worker = text(&context["workerId"])?;
        let response = self
            .dependencies
            .commands
            .request_with_timeout(
                &worker,
                command,
                RequestTimeout::After(std::time::Duration::from_secs(10)),
                None,
            )
            .await?;
        let result = crate::settings::parse_response(
            "nativeGoalClaimRecoveryReceiptSchema",
            response.as_ref(),
        )?;
        let generation = if result["status"] == "queued" {
            &result["admission"]["workerGeneration"]
        } else {
            &result["workerGeneration"]
        };
        anyhow::ensure!(
            deep_equal(&result["claim"], claim)
                && self
                    .dependencies
                    .commands
                    .connection_identity(&worker)
                    .is_some_and(|identity| identity.owner == owner
                        && Some(identity.process_generation.as_str()) == generation.as_str()),
            "Goal claim recovery belongs to a replaced worker connection."
        );
        queue
            .confirm_goal_claim_recovery(owner, chat, &result)
            .await?;
        if matches!(result["status"].as_str(), Some("deferred" | "ineligible"))
            && queue
                .goal_claim_recovery(owner, chat)
                .await?
                .as_ref()
                .is_some_and(|c| deep_equal(c, claim))
        {
            anyhow::bail!("The applied Goal's first cycle remains unconfirmed.");
        }
        Ok(())
    }
}
