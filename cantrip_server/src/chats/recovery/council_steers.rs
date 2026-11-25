use super::*;
use crate::{chats::message_queries::MessageKind, native_commands::Repository as Commands};

impl Service {
    pub(crate) fn resume_council_steers(
        &self,
        owner: &str,
        worker: &str,
        process: &str,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, worker, process) = (
            self.clone(),
            owner.to_owned(),
            worker.to_owned(),
            process.to_owned(),
        );
        self.operations.run(async move {
            let commands = Commands::new(this.dependencies.database.clone());
            let chats = commands.council_steer_recovery_chats(&owner,&worker,&process).await
                .inspect_err(|error| this.log(
                    "warn","Could not list Council steers after Worker restart",
                    json!({"workerId":worker,"err":logging::error_details(error)}),
                ))?;
            for chat in chats {
                if let Err(error) = this.recover_council_steers(&commands,&owner,&worker,&process,&chat).await {
                    this.log("warn","Could not recover the Council steer after Worker restart",
                        json!({"chatId":chat,"workerId":worker,"err":logging::error_details(&error)}));
                }
            }
            Ok(())
        })
    }

    async fn recover_council_steers(
        &self,
        commands: &Commands,
        owner: &str,
        worker: &str,
        process: &str,
        chat: &str,
    ) -> Result<()> {
        let Some(context) = self.chats.execution_context(owner, chat).await? else {
            return Ok(());
        };
        let Some(recovery) = commands.recovery_context(owner, chat).await? else {
            return Ok(());
        };
        if recovery["threadId"] != context["threadId"] || context["workerId"] != worker {
            return Ok(());
        }
        let candidates = commands
            .council_steer_recovery_inputs(owner, worker, process, chat)
            .await?;
        if candidates.is_empty() {
            return Ok(());
        }
        let runtime = self
            .dependencies
            .routing
            .bound_managed_runtime(owner, &context)
            .await?;
        let mut command = self
            .dependencies
            .console
            .configuration(owner, &context, &runtime)
            .await?;
        command["type"] = json!("chat.thread.ensure");
        command["cwd"] = context["cwd"].clone();
        command["threadId"] = recovery["threadId"].clone();
        command["recoveryTurnId"] = recovery["turnId"].clone();
        command["recoverySteerInputs"] = json!({
            "priorRuntimeGeneration":recovery["runtimeGeneration"],
            "clientUserMessageIds":candidates.iter().map(|candidate| &candidate["clientUserMessageId"]).collect::<Vec<_>>(),
        });
        let result = self
            .dependencies
            .commands
            .request(worker, command, None, None)
            .await?;
        if !self
            .dependencies
            .commands
            .connection_identity(worker)
            .is_some_and(|connection| {
                connection.owner == owner && connection.process_generation == process
            })
        {
            return Ok(());
        }
        let observed = crate::settings::parse_response(
            "nativeTurnRecoveryObservationSchema",
            result.as_ref().and_then(|result| result.get("recovery")),
        )?;
        let Some(messages) = commands
            .settle_council_steer_recovery(
                owner, worker, process, chat, &recovery, candidates, &observed,
            )
            .await?
        else {
            return Ok(());
        };
        for message in messages {
            self.dependencies
                .live
                .publish_persisted_message(owner, &message, MessageKind::Encrypted, None)
                .await;
        }
        crate::agent_interactions::Repository::new(crate::database::Executor::Database(
            &self.dependencies.database,
        ))
        .interrupt(chat, recovery["receipt"]["executionLaneId"].as_str())
        .await?;
        self.dependencies
            .live
            .publish_summary(owner, &context["chatId"], &context["projectId"]);
        drop(self.dispatch(owner, chat));
        Ok(())
    }
}
