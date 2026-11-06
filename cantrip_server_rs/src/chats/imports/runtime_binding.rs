use super::{failures::Offline, service::Service, *};
use crate::{
    chats::{eligibility, hydration, managed_console},
    operations::logging::LogCall,
    projects::targets::TargetRepository,
    settings::{parse_response, repository::SettingsRepository},
    wire::coercion::truthy,
};
use std::time::Duration;
const METHODS: &[&str] = &[
    "thread/start",
    "thread/read",
    "thread/inject_items",
    "skills/list",
    "permissionProfile/list",
    "collaborationMode/list",
    "thread/settings/update",
];
impl Service {
    async fn select_runtime(&self, claimed: &Value, context: &Value) -> Result<(Value, Value)> {
        let owner = text(&claimed["ownerId"])?;
        let settings = SettingsRepository::new(self.repository.database.clone());
        let preferences = Value::from_serialize(&settings.get_user_settings(&owner).await?);
        let model = context
            .get("modelId")
            .filter(|v| !v.is_null())
            .unwrap_or(&preferences["defaultModelId"]);
        anyhow::ensure!(
            truthy(Some(model)),
            "The imported chat has no selected model and no default model is configured."
        );
        let model_id = text(model)?;
        let route = optional(&claimed["job"]["targetModelRouteId"])?;
        let mut runtimes = settings
            .get_model_runtimes(&owner, Some(&model_id), route.as_deref(), false, None)
            .await?
            .iter()
            .map(Value::from_serialize)
            .collect::<Vec<_>>();
        if route.as_ref().is_none_or(|s| s.is_empty()) {
            runtimes.sort_by_key(|r| r["routeId"] != context["modelRouteId"]);
        }
        let worker = text(&context["workerId"])?;
        let preferred = claimed["job"]
            .get("targetProviderAccountId")
            .filter(|v| !v.is_null())
            .unwrap_or(&context["providerAccountId"]);
        let mut unavailable = Vec::new();
        for runtime in runtimes {
            if eligibility::account_provider(&runtime["provider"]["kind"]) {
                let accounts = settings
                    .list_provider_account_runtimes(
                        &owner,
                        &text(&runtime["provider"]["id"])?,
                        &worker,
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
                    &context["workerId"],
                );
                if let Some(diagnostic) = diagnostic {
                    (self.dependencies.logger)(diagnostic);
                }
                for reason in selection["unavailable"]
                    .as_array()
                    .context("Unavailable import routes")?
                {
                    unavailable.push(text(reason)?);
                }
                if let Some(runtime) = selection["runtimes"]
                    .as_array()
                    .context("Import account routes")?
                    .first()
                {
                    return Ok((model.clone(), runtime.clone()));
                }
                continue;
            }
            return Ok((model.clone(), runtime));
        }
        anyhow::bail!(
            "No target model route is authenticated and available{}",
            if unavailable.is_empty() {
                ".".to_owned()
            } else {
                format!(": {}", unavailable.join("; "))
            }
        )
    }
    pub(super) async fn hydrate_import(&self, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        if !truthy(job.get("chatId")) {
            return Err(conflict(
                "Canonical chat state is missing before hydration.",
            ));
        }
        let owner = text(&claimed["ownerId"])?;
        let chat = text(&job["chatId"])?;
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let chats = crate::chats::Repository::new(self.repository.database.clone());
        let context = chats
            .execution_context(&owner, &chat)
            .await?
            .filter(|c| {
                c["workerId"] == job["targetPlacement"]["workerId"]
                    && c["worktreeId"] == job["targetPlacement"]["worktreeId"]
            })
            .ok_or_else(|| conflict("The imported chat destination is no longer available."))?;
        let worker = TargetRepository::new(self.repository.database.clone())
            .worker(&owner, &context["workerId"])
            .await?;
        let worker = worker
            .filter(|_| {
                self.dependencies
                    .commands
                    .is_connected(context["workerId"].as_str().unwrap_or_default())
            })
            .ok_or(Offline)?;
        if matches!(
            worker["codexRuntime"]["compatibility"].as_str(),
            Some("missing" | "incompatible")
        ) {
            return self
                .without_hydration(claimed, "runtime-incompatible")
                .await;
        }
        if METHODS
            .iter()
            .any(|m| worker["codexRuntime"]["methods"][*m] != "available")
        {
            return self.without_hydration(claimed, "capability-missing").await;
        }
        let payload = self
            .repository
            .hydration_context(&id, &command)
            .await?
            .ok_or_else(|| {
                conflict("The canonical transcript is no longer available for hydration.")
            })?;
        let (model, runtime) = self.select_runtime(claimed, &context).await?;
        let worker = text(&context["workerId"])?;
        let mcp = Value::Array(
            chats
                .effective_mcp_servers(&owner, Some(&text(&job["projectId"])?), &worker, "ide")
                .await?,
        );
        let permission = managed_console::permission_profile(&context);
        let hydrated = hydration::hydrate(
            &self.dependencies.commands,
            hydration::Input {
                chat_id: &job["chatId"],
                cwd: &context["cwd"],
                expected_sha256: None,
                mcp_servers: &mcp,
                payload: &payload["payload"],
                permission_profile_id: &permission["effectiveId"],
                plan_mode: &context["planMode"],
                runtime: &runtime,
                snapshot_id: &job["id"],
                worker_id: &worker,
            },
        )
        .await?;
        let verified=self.dependencies.commands.request(&worker,json!({"type":"chat.sync","executionProfile":"ide","chatId":job["chatId"],"cwd":context["cwd"],"threadId":hydrated["threadId"],"model":runtime["model"],"provider":runtime["provider"]}),Some(Duration::from_secs(30)),None).await?;
        let verified = parse_response("agentThreadSyncSchema", verified.as_ref())?;
        anyhow::ensure!(
            verified["threadId"] == hydrated["threadId"],
            "The managed Codex thread could not be verified after hydration."
        );
        let completed=self.repository.complete_hydration(&id,&command,job["attempt"].as_f64().context("Import attempt")?,&json!({"threadId":hydrated["threadId"],"modelId":model,"modelRouteId":runtime["routeId"],"providerAccountId":runtime["provider"]["accountId"]})).await?;
        (self.dependencies.logger)(LogCall::event(
            "info",
            "Chat import completed",
            json!({"attachmentCount":completed["attachmentCount"],"attachmentWarningCount":completed["attachmentWarningCount"],"attempt":completed["attempt"],"chatId":completed["chatId"],"chatImportJobId":completed["id"],"projectId":completed["projectId"],"sourceWorkerId":completed["sourceWorkerId"],"targetWorkerId":completed["targetPlacement"]["workerId"]}),
        ));
        self.publish(&owner, &completed);
        Ok(())
    }
    pub(super) async fn without_hydration(&self, claimed: &Value, reason: &str) -> Result<()> {
        let completed = self
            .repository
            .complete_without_hydration(
                &text(&claimed["job"]["id"])?,
                &text(&claimed["commandId"])?,
                claimed["job"]["attempt"]
                    .as_f64()
                    .context("Import attempt")?,
            )
            .await?;
        (self.dependencies.logger)(LogCall::event(
            "info",
            "Chat import completed with canonical history",
            json!({"chatId":completed["chatId"],"chatImportJobId":completed["id"],"projectId":completed["projectId"],"reason":reason,"targetWorkerId":completed["targetPlacement"]["workerId"]}),
        ));
        self.publish(&text(&claimed["ownerId"])?, &completed);
        Ok(())
    }
}
