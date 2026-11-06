use super::*;

impl Execution {
    pub(super) async fn interrupt(&self, chat: &str) -> Result<Response> {
        let control = self.native.control_context(&self.owner, chat).await?;
        let context = &control["context"];
        if context.is_null() {
            return Ok(error(404, "Chat source not found."));
        }
        if context["experience"] == "task" {
            return match self
                .service
                .execution
                .pause
                .interrupt_task(&self.owner, chat)
                .await
            {
                Ok(result) => output(200, "chatInterruptAcceptedSchema", &result),
                Err(cause) => {
                    match downcast_ref::<crate::chats::automation_pause::PauseError>(&cause) {
                        Some(failure) => Ok(error(failure.status_code, failure.message.clone())),
                        None => Err(cause),
                    }
                }
            };
        }
        let autonomy_stopped = if managed(context) {
            self.native
                .stop_autonomy(&self.owner, chat, control["activationGeneration"].as_str())
                .await?
        } else {
            false
        };
        if !executing(context) {
            return output(
                200,
                "chatInterruptAcceptedSchema",
                &json!({"interrupted":autonomy_stopped}),
            );
        }
        if let Some(generation) = control["activationGeneration"].as_str()
            && let Some(cancelled) = self
                .native
                .cancel_preparing(&self.owner, chat, generation)
                .await?
        {
            if truthy(cancelled.get("logicalRoot")) {
                let result = self.service.workers.commands.request_with_timeout(&text(&cancelled["workerId"])?,
                        json!({"type":"chat.native-logical.cancel","chatId":chat,
                            "rootOperationId":cancelled["logicalRoot"]["operationId"],"rootOperationGeneration":cancelled["logicalRoot"]["operationGeneration"]}),
                        crate::workers::command_bus::RequestTimeout::After(std::time::Duration::from_secs(5)),None).await;
                if let Err(cause) = result {
                    logging::server_logger()(LogCall::event(
                        "warn",
                        "Preparation cancellation committed but worker notification failed",
                        json!({"event":"chat.preparation.cancel-notification-failed","chatId":chat,"workerId":cancelled["workerId"],"err":logging::error_details(&cause.into())}),
                    ));
                }
            }
            self.service.chat_mutations.publish_summary(
                &self.owner,
                &json!(chat),
                &context["projectId"],
            );
            return output(
                200,
                "chatInterruptAcceptedSchema",
                &json!({"interrupted":true}),
            );
        }
        let command = if truthy(control.get("activationGeneration")) {
            json!({"type":"chat.native-control","chatId":chat,"threadId":context["threadId"],
                "nativeActivationGeneration":control["activationGeneration"],"nativeRuntimeGeneration":control["runtimeGeneration"],
                "modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"control":json!({"kind":"interrupt"})})
        } else {
            json!({"type":"chat.interrupt","chatId":chat,"threadId":context["threadId"],
                "executionProfile":if context["contextKind"]=="standalone"{"standalone-chat"}else{"ide"}})
        };
        let response = self
            .service
            .workers
            .commands
            .request(&text(&context["workerId"])?, command, None, None)
            .await?;
        let result =
            crate::settings::parse_response("chatInterruptAcceptedSchema", response.as_ref())?;
        if result["interrupted"] == true && context["status"] == "waiting-for-approval" {
            self.service
                .chat_mutations
                .interrupt_interactions(&self.owner, chat, None)
                .await?;
        }
        self.log(if result["interrupted"]==true {"Agent turn interruption accepted"}else{"Agent turn was not active"},
            json!({"event":"chat.interrupt.requested","subsystem":"chat-execution","operation":"interrupt",
                "status":if result["interrupted"]==true{"accepted"}else{"not-active"},"chatId":chat,"projectId":context["projectId"],"workerId":context["workerId"]}));
        output(200, "chatInterruptAcceptedSchema", &result)
    }
}
