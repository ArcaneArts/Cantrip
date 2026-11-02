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
        let Some(context) = context.filter(|c| {
            c["contextKind"] == "project"
                && c["experience"] == "agent"
                && c.get("workerId") == state.get("workerId")
                && c.get("threadId") == state["source"].get("threadId")
                && c.get("projectId") == state["source"].get("projectId")
                && c.get("worktreeId") == state["source"].get("placementId")
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
        if matches!(
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
        let launch = console.prepare_launch(owner, &context, &runtime).await?;
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
        parse(
            "nativeRuntimeHandoffConfigurationSchema",
            &json!({"state":state,"side":side,"configuration":configuration}),
        )
    }
}
