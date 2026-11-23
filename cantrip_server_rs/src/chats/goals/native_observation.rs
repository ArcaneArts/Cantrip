use super::*;

impl Service {
    /// Resolve configuration and read a retained native turn without submitting
    /// input or changing the general Chat runtime binding.
    pub async fn observe_native_turn(
        &self,
        owner: &str,
        context: &Value,
        turn: &Value,
    ) -> Result<Value> {
        anyhow::ensure!(
            truthy(context.get("threadId")),
            "Task recovery requires its original native thread."
        );
        let runtime = self
            .dependencies
            .routing
            .runtime_for_context(owner, context)
            .await?
            .context("Selected model was not found.")?;
        let fields = self
            .dependencies
            .console
            .configuration(owner, context, &runtime)
            .await?;
        let mut command = json!({"type":"chat.thread.ensure","cwd":context["cwd"],"threadId":context["threadId"],"recoveryTurnId":turn});
        for (key, value) in fields.as_object().context("Task runtime configuration")? {
            command[key.lossy().as_ref()] = value.clone();
        }
        let result = self
            .dependencies
            .commands
            .request_with_timeout(
                &text(&context["workerId"])?,
                command,
                RequestTimeout::Disabled,
                None,
            )
            .await?
            .context("The recovered Task thread changed.")?;
        anyhow::ensure!(
            result["threadId"] == context["threadId"],
            "The recovered Task thread changed."
        );
        let observed = parse("nativeTurnRecoveryObservationSchema", &result["recovery"])?;
        anyhow::ensure!(
            observed["threadId"] == context["threadId"] && observed["turnId"] == *turn,
            "The observed native turn belongs to another Task input."
        );
        let mut fields = observed.clone();
        fields["event"] = json!("task.native-turn.observed");
        fields["chatId"] = context["chatId"].clone();
        self.log("info", "Observed retained native Task turn", fields);
        Ok(observed)
    }
}
