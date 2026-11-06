//! Cold Stop acquires a held observer and commits native cancellation, never Resume.
use super::*;

fn terminal(state: &Value) -> bool {
    matches!(
        state["phase"].as_str(),
        Some("stopped" | "completed" | "failed" | "idle")
    )
}

impl Service {
    pub async fn stop_suspended(
        &self,
        owner: &str,
        context: &Value,
        control: &Value,
    ) -> Result<Value> {
        let chat = text(&context["chatId"])?;
        let requested = self.native.request_suspension_stop(owner, &chat).await?;
        if terminal(&requested) {
            return Ok(json!({"interrupted":true}));
        }
        let attempt: Result<Value> = async {
            if truthy(control.get("activationGeneration")) {
                let packet = json!({"type":"chat.native-control","chatId":context["chatId"],"threadId":context["threadId"],
                    "nativeActivationGeneration":control["activationGeneration"],"nativeRuntimeGeneration":control["runtimeGeneration"],
                    "modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"control":json!({"kind":"interrupt"})});
                let _ = self.commands.request_with_timeout(&text(&context["workerId"])?, packet, RequestTimeout::Disabled, None).await;
                let observed = self.chats.native_suspension(owner, &chat).await?.unwrap_or(Value::Null);
                if observed["controlId"] != requested["controlId"] {
                    return Err(failure(409, "This Stop was superseded by a newer control."));
                }
                if terminal(&observed) { return Ok(json!({"interrupted":true})); }
                if observed["actorControlId"] == observed["controlId"] {
                    return Err(failure(409, "The native Stop has not received a committed acknowledgement. Retry Stop."));
                }
            }
            let Some(launch) = self.goals.suspended_launch(owner, context).await? else {
                return Err(failure(409, "The saved runtime is unavailable. Restore it and retry Stop."));
            };
            if launch["session"].is_null() || launch["threadId"] != requested["active"]["threadId"] || requested["checkpoint"].is_null() {
                return Err(failure(409, "The saved turn no longer matches its chat attachment. Restore its placement and retry Stop."));
            }
            let mut packet = json!({"type":"chat.suspension.stop","chatId":context["chatId"],"threadId":launch["threadId"],"controlId":requested["controlId"],"checkpoint":requested["checkpoint"],"nativeActivationGeneration":control["activationGeneration"],"nativeRuntimeGeneration":control["runtimeGeneration"],"session":launch["session"],"cwd":context["cwd"],"executionProfile":if context["contextKind"]=="standalone"{"standalone-chat"}else{"ide"}});
            packet["session"]["heldSuspension"] = requested["checkpoint"].clone();
            for field in ["model", "provider", "permissionProfileId", "planMode", "subagentDefaults", "mcpServers"] {
                packet[field] = launch[field].clone();
            }
            let reply = self.commands.request_with_timeout(&text(&context["workerId"])?, packet, RequestTimeout::Disabled, None).await?;
            let result = crate::settings::parse_response("chatInterruptAcceptedSchema", reply.as_ref())?;
            let observed = self.chats.native_suspension(owner, &chat).await?.unwrap_or(Value::Null);
            if result["interrupted"] != true || observed["controlId"] != requested["controlId"] || !terminal(&observed) {
                return Err(failure(409, "Stop has not received a committed native acknowledgement. Retry Stop."));
            }
            Ok(result)
        }.await;
        let result = match attempt {
            Ok(result) => Ok(result),
            Err(_) => {
                let current = self
                    .chats
                    .native_suspension(owner, &chat)
                    .await?
                    .unwrap_or(Value::Null);
                if current["controlId"] == requested["controlId"] && terminal(&current) {
                    Ok(json!({"interrupted":true}))
                } else {
                    if current["controlId"] == requested["controlId"] {
                        self.native
                            .fail_suspension_control(
                                owner,
                                &chat,
                                &current,
                                &json!({"code":"stop-failed","protectedDetails":Value::Null}),
                            )
                            .await?;
                    }
                    Err(failure(
                        409,
                        "The suspended turn could not be stopped. Its saved state is retained; retry Stop.",
                    ))
                }
            }
        };
        self.publish(owner, context);
        result
    }
}
