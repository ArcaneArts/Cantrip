use super::{
    execute::{HydratedTarget, execution_error},
    service::Service,
    *,
};
use crate::{
    chats::{eligibility, hydration, managed_console},
    settings::repository::SettingsRepository,
    wire::coercion::truthy,
};
use std::time::Duration;

impl Service {
    pub(super) async fn select_runtime(
        &self,
        claimed: &Value,
        worker: &str,
        preferred: &Value,
    ) -> Result<Value> {
        let owner = text(&claimed["ownerId"])?;
        let settings = SettingsRepository::new(self.repository.database.clone());
        let preferences = Value::from_serialize(&settings.get_user_settings(&owner).await?);
        let captured = &claimed["snapshot"]["summary"];
        let model = captured
            .get("modelId")
            .filter(|v| !v.is_null())
            .unwrap_or(&preferences["defaultModelId"]);
        if !truthy(Some(model)) {
            return Err(execution_error(
                "runtime-incompatible",
                "The chat has no selected model and no default model is configured.",
                false,
            ));
        }
        let mut runtimes = settings
            .get_model_runtimes(&owner, Some(&text(model)?), None, false, None)
            .await?
            .iter()
            .map(Value::from_serialize)
            .collect::<Vec<_>>();
        runtimes.sort_by_key(|runtime| runtime["routeId"] != captured["modelRouteId"]);
        let mut unavailable = Vec::new();
        for runtime in runtimes {
            if eligibility::account_provider(&runtime["provider"]["kind"]) {
                let accounts = settings
                    .list_provider_account_runtimes(
                        &owner,
                        &text(&runtime["provider"]["id"])?,
                        worker,
                        runtime["model"]["providerModelId"].as_str(),
                    )
                    .await?
                    .iter()
                    .map(Value::from_serialize)
                    .collect::<Vec<_>>();
                let (selection, diagnostic) = eligibility::account_routes_logged(
                    &runtime,
                    &accounts,
                    Some(preferred),
                    &json!(worker),
                );
                if let Some(diagnostic) = diagnostic {
                    (self.dependencies.logger)(diagnostic);
                }
                for reason in selection["unavailable"]
                    .as_array()
                    .context("Unavailable account routes")?
                {
                    unavailable.push(text(reason)?);
                }
                if let Some(runtime) = selection["runtimes"]
                    .as_array()
                    .context("Account routes")?
                    .first()
                {
                    return Ok(runtime.clone());
                }
            } else {
                return Ok(runtime);
            }
        }
        Err(execution_error(
            "runtime-incompatible",
            format!(
                "No target model route is authenticated and available{}",
                if unavailable.is_empty() {
                    ".".to_owned()
                } else {
                    format!(": {}", unavailable.join("; "))
                }
            ),
            true,
        ))
    }
    pub(super) async fn hydrate_target(
        &self,
        claimed: &Value,
        source: &Value,
        target: &Value,
        runtime: &Value,
    ) -> Result<Value> {
        let mut context = source.clone();
        context["cwd"] = target["worktree"]["path"].clone();
        context["isPrimary"] = target["worktree"]["isPrimary"].clone();
        context["threadId"] = Value::Null;
        context["workerId"] = target["workerId"].clone();
        context["worktreeId"] = target["worktree"]["id"].clone();
        let mcp = crate::chats::Repository::new(self.repository.database.clone())
            .effective_mcp_servers(
                &text(&claimed["ownerId"])?,
                Some(&text(&claimed["job"]["projectId"])?),
                &text(&target["workerId"])?,
                "ide",
            )
            .await?;
        let permission = managed_console::permission_profile(&context);
        let result = hydration::hydrate(
            &self.dependencies.commands,
            hydration::Input {
                chat_id: &claimed["job"]["chatId"],
                cwd: &target["worktree"]["path"],
                expected_sha256: Some(&claimed["snapshot"]["summary"]["transcriptSha256"]),
                mcp_servers: &Value::Array(mcp),
                payload: &claimed["snapshot"]["payload"],
                permission_profile_id: &permission["effectiveId"],
                plan_mode: &source["planMode"],
                runtime,
                snapshot_id: &claimed["snapshot"]["summary"]["id"],
                worker_id: &text(&target["workerId"])?,
            },
        )
        .await;
        match result {
            Ok(hydrated) => Ok(hydrated["threadId"].clone()),
            Err(error) => {
                if let Some(known) = error.downcast_ref::<hydration::Error>() {
                    return Err(execution_error(
                        if matches!(known, hydration::Error::TooManySkills) {
                            "policy-denied"
                        } else {
                            "stale-attempt"
                        },
                        known.to_string(),
                        false,
                    ));
                }
                Err(error)
            }
        }
    }
    pub(super) async fn release_source(&self, claimed: &Value, source: &Value) -> Result<()> {
        if !truthy(source.get("threadId")) {
            return Ok(());
        }
        let route = &claimed["snapshot"]["summary"]["modelRouteId"];
        let runtime = if truthy(Some(route)) {
            SettingsRepository::new(self.repository.database.clone())
                .get_model_runtimes(
                    &text(&claimed["ownerId"])?,
                    None,
                    Some(&text(route)?),
                    true,
                    None,
                )
                .await?
                .first()
                .map(Value::from_serialize)
        } else {
            None
        };
        let runtime=runtime.ok_or_else(||execution_error("runtime-incompatible","The source model route is no longer configured, so its runtime cannot be released safely.",false))?;
        self.dependencies.commands.request(&text(&source["workerId"])?,json!({"type":"chat.relocation.thread.release","threadId":source["threadId"],"discard":false,"model":runtime["model"],"provider":runtime["provider"]}),Some(Duration::from_secs(30)),None).await?;
        Ok(())
    }
    pub(super) async fn release_target(&self, target: &HydratedTarget) -> Result<()> {
        self.dependencies.commands.request(&target.worker_id,json!({"type":"chat.relocation.thread.release","threadId":target.thread_id,"discard":true,"model":target.runtime["model"],"provider":target.runtime["provider"]}),Some(Duration::from_secs(30)),None).await?;
        Ok(())
    }
}
