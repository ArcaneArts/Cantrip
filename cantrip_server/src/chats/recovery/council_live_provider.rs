//! A compatible account can take over a held native Council turn.
use super::*;
use crate::{
    chats::routing::NoProviderRoutes, native_commands::Repository as Commands,
    workers::command_bus::RequestTimeout,
};

impl Service {
    pub(super) async fn recover_live_council_provider(
        &self,
        owner: &str,
        context: &Value,
    ) -> Result<bool> {
        let Some(pause) = &self.dependencies.council_pause else {
            return Ok(false);
        };
        let commands = Commands::new(self.dependencies.database.clone());
        let chat = text(&context["chatId"])?;
        let worker = text(&context["workerId"])?;
        while let Some(entry) = commands.pending_council_live_switch(owner, &chat).await? {
            let source = text(&entry["source_operation_id"])?;
            let phase = text(&entry["phase"])?;
            let state = self
                .chats
                .native_suspension(owner, &chat)
                .await?
                .unwrap_or(Value::Null);
            let owns_pause =
                state["controlId"] == entry["pause_control_id"] && !state["controlId"].is_null();
            if !matches!(phase.as_str(), "resuming" | "reconciling")
                && (entry["source_ended"] == true
                    || (!owns_pause
                        && !state.is_null()
                        && !matches!(
                            state["phase"].as_str(),
                            Some("running" | "completed" | "failed" | "stopped" | "idle")
                        )))
            {
                commands
                    .set_council_live_switch_phase(owner, &chat, &source, &phase, "cancelled")
                    .await?;
                self.publish_council_switch(owner, context);
                return Ok(false);
            }
            let advanced = match phase.as_str() {
                "observed" => {
                    if entry["source_active"] != true {
                        return Ok(false);
                    }
                    let model = text(&entry["model_id"])?;
                    let routes = match self
                        .dependencies
                        .routing
                        .available_runtimes(owner, context, &model)
                        .await
                    {
                        Ok(routes) => routes,
                        Err(error) if error.is::<NoProviderRoutes>() => return Ok(false),
                        Err(error) => return Err(error),
                    };
                    let Some(target) = routes.iter().find(|route| {
                        let provider = &route["provider"];
                        provider["id"] == entry["provider_id"]
                            && route["routeId"] == entry["from_route"]
                            && provider["accountId"].is_string()
                            && provider["accountId"] != entry["from_account"]
                    }) else {
                        return Ok(false);
                    };
                    commands
                        .reserve_council_live_switch(
                            owner,
                            &chat,
                            &source,
                            &text(&target["routeId"])?,
                            target["provider"]["accountId"].as_str(),
                        )
                        .await?
                }
                "pausing" => {
                    if !owns_pause {
                        let mut packet = council_source(&entry, &chat);
                        packet["type"] = json!("chat.native-control");
                        packet["operationId"] = entry["pause_control_id"].clone();
                        packet["control"] = json!({"kind":"pause","paused":true});
                        self.dependencies
                            .commands
                            .request_with_timeout(&worker, packet, RequestTimeout::Disabled, None)
                            .await?;
                    }
                    let Some(saved) = self.chats.native_suspension(owner, &chat).await? else {
                        return Ok(true);
                    };
                    if saved["phase"] != "paused"
                        || saved["controlId"] != entry["pause_control_id"]
                        || saved["checkpoint"].is_null()
                    {
                        return Ok(true);
                    }
                    commands
                        .set_council_live_switch_phase(owner, &chat, &source, &phase, "restarting")
                        .await?
                }
                "restarting" => {
                    if !owns_pause || state["phase"] != "paused" || state["checkpoint"].is_null() {
                        return Ok(true);
                    }
                    let mut packet = council_source(&entry, &chat);
                    packet["type"] = json!("chat.council-provider-retire");
                    packet["checkpoint"] = state["checkpoint"].clone();
                    let retirement = self
                        .dependencies
                        .commands
                        .request(&worker, packet, None, None)
                        .await?
                        .context("The source Worker did not confirm retirement.")?;
                    commands
                        .commit_council_live_switch(owner, &chat, &source, &retirement)
                        .await?
                }
                "resuming" => {
                    let current = if restored(&state, &entry)
                        || state["error"]["code"] == "checkpoint-incompatible"
                    {
                        state
                    } else {
                        let attempt = pause.set(owner, &chat, false, false).await;
                        let current = self
                            .chats
                            .native_suspension(owner, &chat)
                            .await?
                            .unwrap_or(Value::Null);
                        if current["error"]["code"] != "checkpoint-incompatible" {
                            attempt?;
                        }
                        current
                    };
                    if current["error"]["code"] == "checkpoint-incompatible" {
                        if commands
                            .begin_council_checkpoint_fallback(owner, &chat, &source, &current)
                            .await?
                        {
                            self.publish_council_switch(owner, context);
                            continue;
                        }
                        return Ok(true);
                    }
                    if !restored(&current, &entry) {
                        return Ok(true);
                    }
                    commands
                        .set_council_live_switch_phase(owner, &chat, &source, &phase, "completed")
                        .await?
                }
                "reconciling" => {
                    if state["controlId"] != entry["fallback_stop_id"] {
                        return Ok(true);
                    }
                    if !matches!(
                        state["phase"].as_str(),
                        Some("stopping" | "error" | "stopped")
                    ) {
                        return Ok(true);
                    }
                    if state["phase"] != "stopped" {
                        // The old provider is already retired. Use the existing
                        // cold Stop path to collect the actual native outcome.
                        let Some(current) = self.chats.execution_context(owner, &chat).await?
                        else {
                            return Ok(true);
                        };
                        pause.stop_suspended(owner, &current, &Value::Null).await?;
                    }
                    commands
                        .finish_council_checkpoint_fallback(owner, &chat, &source)
                        .await?
                }
                _ => return Ok(false),
            };
            if !advanced {
                return Ok(true);
            }
            self.publish_council_switch(owner, context);
        }
        Ok(false)
    }

    fn publish_council_switch(&self, owner: &str, context: &Value) {
        self.dependencies
            .live
            .publish_summary(owner, &context["chatId"], &context["projectId"]);
    }
}

fn council_source(entry: &Value, chat: &str) -> Value {
    json!({"chatId":chat,"threadId":entry["source_thread_id"],
        "nativeActivationGeneration":entry["activation_generation"],"nativeRuntimeGeneration":entry["source_runtime_generation"],
        "modelRouteId":entry["from_route"],"providerAccountId":entry["from_account"]})
}

fn restored(state: &Value, entry: &Value) -> bool {
    matches!(
        state["phase"].as_str(),
        Some("running" | "completed" | "failed")
    ) && state["active"]["threadId"] == entry["source_thread_id"]
        && state["active"]["turnId"] == entry["source_turn_id"]
        && state["target"]["modelRouteId"] == entry["target_model_route_id"]
        && state["target"]["providerAccountId"] == entry["target_provider_account_id"]
        && state["executionOwner"]["runtimeGeneration"].is_string()
        && state["executionOwner"]["runtimeGeneration"] != entry["source_runtime_generation"]
}
