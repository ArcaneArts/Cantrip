use super::*;
use crate::chats::{Repository as Chats, managed_console::ManagedConsole};
impl Repository {
    /// Resolve configured identity only; the worker attempts native initialization.
    pub async fn configuration(
        &self,
        owner: &str,
        state: &Value,
        side: &str,
        console: &ManagedConsole,
    ) -> Result<Value> {
        if matches!(state["phase"].as_str(), Some("completed" | "cancelled"))
            || (side == "source" && state["phase"] == "committed")
        {
            return reject("handoff-phase-conflict");
        }
        let context = Chats::new(self.database.clone())
            .execution_context(owner, &text(&state["chatId"])?)
            .await?;
        let Some(mut context) = context.filter(|c| {
            c.get("contextKind") == state["source"].get("contextKind")
                && c["experience"]
                    == (if truthy(state["queuedSource"].get("taskGoal")) {
                        "task"
                    } else {
                        "agent"
                    })
                && c.get("workerId") == state.get("workerId")
                && c.get("threadId") == state["source"].get("threadId")
                && c.get("projectId") == state["source"].get("projectId")
                && (if c["contextKind"] == "project" {
                    c.get("worktreeId")
                } else {
                    c.get("scratchRootId")
                }) == state["source"].get("placementId")
        }) else {
            return reject("handoff-source-replaced");
        };
        let (route, account) = if side == "source" {
            (
                &state["source"]["modelRouteId"],
                &state["source"]["providerAccountId"],
            )
        } else {
            (
                &state["targetModelRouteId"],
                &state["targetProviderAccountId"],
            )
        };
        let settings = crate::settings::repository::SettingsRepository::new(self.database.clone());
        let runtime = if truthy(Some(route)) {
            settings
                .get_model_runtimes(owner, None, Some(&text(route)?), true, None)
                .await?
                .into_iter()
                .next()
        } else {
            None
        };
        let Some(runtime) = runtime else {
            return reject("handoff-route-unavailable");
        };
        let mut runtime = Value::from_serialize(&runtime);
        if runtime["provider"]["kind"] == "claude-code" {
            let Some(account_id) = account.as_str() else {
                return reject("handoff-target-account-required");
            };
            let assigned = settings
                .claude_account_worker(
                    owner,
                    &text(&runtime["provider"]["id"])?,
                    account_id,
                    side != "source",
                )
                .await?;
            if assigned.as_deref() != state["workerId"].as_str() {
                return reject("handoff-target-account-mismatch");
            }
            runtime["provider"]["accountId"] = account.clone();
        } else if matches!(
            runtime["provider"]["kind"].as_str(),
            Some("chatgpt" | "grok")
        ) {
            let accounts = settings
                .list_provider_account_runtimes(
                    owner,
                    &text(&runtime["provider"]["id"])?,
                    &text(&state["workerId"])?,
                    None,
                )
                .await?;
            let account = accounts
                .iter()
                .map(Value::from_serialize)
                .find(|a| a.get("accountId") == Some(account) && a["enabled"] == true);
            let Some(account) = account else {
                return reject("handoff-target-account-mismatch");
            };
            for key in ["accountId", "credentialHomeKey", "credits"] {
                runtime["provider"][key] = account[key].clone();
            }
        } else if !account.is_null() {
            return reject("handoff-target-account-mismatch");
        }
        let automatic = one(
            Executor::Database(&self.database),
            "SELECT automatic_model_configuration::text FROM native_runtime_handoffs WHERE owner_id=$1 AND chat_id=$2 AND operation_id=$3 AND automatic_model_configuration IS NOT NULL",
            &[&owner, &text(&state["chatId"])?, &text(&state["operationId"])?],
        ).await?;
        if let Some(configuration) = automatic {
            apply_automatic_configuration(&mut context, side, configuration);
        }
        let launch = console.configuration(owner, &context, &runtime).await?;
        if launch["model"].get("routeId") != Some(route)
            || launch["provider"].get("id") != runtime["provider"].get("id")
            || launch["provider"]
                .get("accountId")
                .filter(|v| !v.is_null())
                .unwrap_or(&Value::Null)
                != account
        {
            return reject("handoff-route-replaced");
        }
        let mut configuration =
            json!({"cwd":context["cwd"],"threadId":state["source"]["threadId"]});
        for key in [
            "session",
            "model",
            "provider",
            "subagentDefaults",
            "mcpServers",
            "planMode",
            "permissionProfileId",
        ] {
            if let Some(value) = launch.get(key) {
                configuration[key] = value.clone();
            }
        }
        if truthy(state["queuedSource"].get("taskGoal")) {
            if let Value::Object(fields) = &mut configuration {
                fields.retain(|key, _| key.as_str() != Some("session"));
            }
            configuration["task"] = self
                .task_context(owner, state, &launch["provider"]["id"])
                .await?;
        }
        parse(
            "nativeRuntimeHandoffConfigurationSchema",
            &json!({"state":state,"side":side,"configuration":configuration}),
        )
    }
}

fn apply_automatic_configuration(context: &mut Value, side: &str, configuration: Value) {
    if side == "source" {
        // The worker opens the retained source session using Intent::Preserve.
        // Its bootstrap defaults must be valid for the source provider even if
        // the user has already saved a destination-only effort or child model.
        context["reasoningEffort"] = Value::Null;
        context["modelConfiguration"] = json!({
            "modelId":Value::Null,"reasoningEffort":Value::Null,
            "customSubagentModel":false,"subagentModelId":Value::Null,"subagentReasoningEffort":Value::Null,
        });
    } else {
        context["reasoningEffort"] = configuration["reasoningEffort"].clone();
        context["modelConfiguration"] = configuration;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_handoff_keeps_destination_options_out_of_source_preparation() {
        let selected = json!({
            "modelId":"opus","reasoningEffort":"max","customSubagentModel":true,
            "subagentModelId":"claude-child","subagentReasoningEffort":"high",
        });
        let mut context = json!({"reasoningEffort":"max","modelConfiguration":selected});
        apply_automatic_configuration(&mut context, "source", selected.clone());
        assert!(context["reasoningEffort"].is_null());
        assert_eq!(context["modelConfiguration"]["customSubagentModel"], false);
        assert!(context["modelConfiguration"]["subagentModelId"].is_null());
        apply_automatic_configuration(&mut context, "destination", selected.clone());
        assert_eq!(context["reasoningEffort"], "max");
        assert_eq!(context["modelConfiguration"], selected);
    }
}
