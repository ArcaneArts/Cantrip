//! Best-effort message and Task titles retain protected metadata and an atomic claim.
use super::{
    Repository, catalog::raw, live_mutations::Service as Live, routing::ModelRouting,
    summary::wire_summary, turn_runtime::stages::Operations,
};
use crate::{
    database::Database,
    operations::logging::{LogCall, Logger},
    settings::repository::SettingsRepository,
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use futures::future::BoxFuture;
use std::{sync::Arc, time::Duration};

impl Repository {
    pub async fn claim_automatic_title(
        &self,
        owner: &str,
        chat: &str,
        message: Option<&str>,
    ) -> Result<Option<String>> {
        let claim = uuid::Uuid::new_v4().to_string();
        let message = message.filter(|v| !v.is_empty());
        let rows=self.database.query("UPDATE chats SET auto_title_pending=false,auto_title_claim=$3 WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL AND auto_title_pending=true AND auto_title_claim IS NULL AND ($4::text IS NULL OR NOT EXISTS(SELECT 1 FROM chat_messages WHERE chat_id=$1 AND role='user' AND id<>$4)) RETURNING id",&[&chat,&owner,&claim,&message]).await?;
        Ok((!rows.is_empty()).then_some(claim))
    }
    pub async fn finish_automatic_title(
        &self,
        owner: &str,
        chat: &str,
        claim: &str,
        title: Option<&Value>,
        empty: bool,
    ) -> Result<Option<Value>> {
        let title = title.filter(|v| truthy(Some(v))).map(Value::stringify);
        let rows=self.database.query("UPDATE chats SET auto_title_claim=NULL,auto_title_pending=$4,protected_label=CASE WHEN $5::text IS NULL THEN protected_label ELSE $5::text::jsonb END,updated_at=CASE WHEN $5::text IS NULL THEN updated_at ELSE $6 END WHERE id=$1 AND owner_id=$2 AND auto_title_claim=$3 AND archived_at IS NULL RETURNING to_jsonb(chats)::text",&[&chat,&owner,&claim,&empty,&title,&crate::auth::now()]).await?;
        rows.first().map(|r| wire_summary(&raw(r)?)).transpose()
    }
}
pub struct MessageTitles {
    chats: Repository,
    settings: SettingsRepository,
    routing: Arc<ModelRouting>,
    commands: Arc<LimitedCommandBus>,
    live: Arc<Live>,
    logger: Logger,
    operations: Arc<Operations>,
}
fn enabled(settings: &Value, task: bool) -> bool {
    if task {
        settings["autoNameTasks"] == true
    } else {
        settings["autoNameChats"] == true && settings["randomAgentNames"] != true
    }
}
pub fn lowest_effort(supported: Option<&Value>, fallback: Value) -> Value {
    for effort in [
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ] {
        if supported
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|v| v["effort"] == effort))
        {
            return json!(effort);
        }
    }
    fallback
}
impl MessageTitles {
    pub fn new(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        commands: Arc<LimitedCommandBus>,
        live: Arc<Live>,
        logger: Logger,
    ) -> Arc<Self> {
        Arc::new(Self {
            chats: Repository::new(database.clone()),
            settings: SettingsRepository::new(database),
            routing,
            commands,
            live,
            logger,
            operations: Arc::new(Operations::default()),
        })
    }
    /// Dropping the returned waiter never cancels a claimed metadata operation.
    pub fn generate(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        message: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        self.generate_with_context(owner, chat, message, None)
    }
    pub fn generate_with_context(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        message: &Value,
        route_context: Option<&Value>,
    ) -> BoxFuture<'static, Result<()>> {
        self.generate_input(
            owner,
            chat,
            &json!({"kind":"message","message":message}),
            route_context,
        )
    }
    pub fn generate_task(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        task: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        self.generate_input(owner, chat, &json!({"kind":"task","task":task}), None)
    }
    fn generate_input(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        input: &Value,
        route_context: Option<&Value>,
    ) -> BoxFuture<'static, Result<()>> {
        let route_context = route_context.cloned();
        let (this, owner, chat, mut input) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            input.clone(),
        );
        self.operations.run(async move {
            let mut reconcile = true;
            loop {
                let mut claim = None;
                let result = this
                    .generate_claimed(
                        &owner,
                        &chat,
                        &input,
                        route_context.as_ref(),
                        reconcile,
                        &mut claim,
                    )
                    .await;
                if result.is_err() {
                    // Provider errors may contain the private brief or generated title.
                    (this.logger)(LogCall::event(
                        "debug",
                        "Automatic title unavailable",
                        json!({"event":"labeling.unavailable","chatId":chat}),
                    ));
                }
                if let Some(claim) = claim {
                    let _ = this
                        .chats
                        .finish_automatic_title(&owner, &chat, &claim, None, false)
                        .await;
                }
                if let Ok(Some(next)) = result {
                    input = json!({"kind":"task","task":next});
                    reconcile = false;
                } else {
                    break;
                }
            }
            Ok(())
        })
    }
    async fn generate_claimed(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        route_context: Option<&Value>,
        reconcile: bool,
        claim: &mut Option<String>,
    ) -> Result<Option<Value>> {
        let Some(context) = self.chats.execution_context(owner, chat).await? else {
            return Ok(None);
        };
        let is_task = input["kind"] == "task";
        if !is_task && context["experience"] == "task" {
            return Ok(None);
        }
        let settings = Value::from_serialize(&self.settings.get_user_settings(owner).await?);
        if !enabled(&settings, is_task) {
            return Ok(None);
        }
        let model = settings
            .get("labelingModelId")
            .filter(|v| !v.is_null())
            .unwrap_or(&settings["defaultModelId"]);
        if !truthy(Some(model)) {
            return Ok(None);
        }
        *claim = self
            .chats
            .claim_automatic_title(
                owner,
                chat,
                if is_task {
                    None
                } else {
                    input["message"]["id"].as_str()
                },
            )
            .await?;
        if claim.is_none() {
            return Ok(None);
        }
        let runtime = if is_task {
            self.routing
                .available_runtimes(
                    owner,
                    route_context.unwrap_or(&context),
                    model.as_str().context("Label model")?,
                )
                .await?
                .into_iter()
                .next()
                .context("No labeling route.")?
        } else {
            let configuration = json!({"modelId":model,"reasoningEffort":Value::Null,"customSubagentModel":false,"subagentModelId":Value::Null,"subagentReasoningEffort":Value::Null});
            self.routing
                .route_pairs(
                    owner,
                    route_context.unwrap_or(&context),
                    &configuration,
                    None,
                )
                .await?
                .first()
                .context("No labeling route.")?["root"]["runtime"]
                .clone()
        };
        let catalog = &runtime["model"]["catalog"];
        let fallback = if settings["labelingModelId"].is_null() {
            settings["defaultReasoningEffort"].clone()
        } else {
            Value::Null
        };
        let fallback = if fallback.is_null() {
            catalog["defaultReasoningEffort"].clone()
        } else {
            fallback
        };
        let mut model = runtime["model"].clone();
        model["reasoningEffort"] =
            lowest_effort(catalog.get("supportedReasoningEfforts"), fallback);
        let reply=self.commands.request(context["workerId"].as_str().context("Label worker")?,json!({"type":"label.generate","chatId":chat,"labelKind":if is_task {"task"}else if context["contextKind"]=="standalone" {"chat"}else{"agent"},"input":input,"model":model,"provider":runtime["provider"]}),Some(Duration::from_secs(30)),None).await?;
        let reply = crate::settings::parse_response("generateLabelResultSchema", reply.as_ref())?;
        let still_enabled = enabled(
            &Value::from_serialize(&self.settings.get_user_settings(owner).await?),
            is_task,
        );
        let updated = self
            .chats
            .finish_automatic_title(
                owner,
                chat,
                claim.as_deref().unwrap(),
                still_enabled.then_some(&reply["titleProtection"]),
                reply["emptyInput"] == true,
            )
            .await?;
        *claim = None;
        if let Some(updated) = &updated
            && still_enabled
            && truthy(reply.get("titleProtection"))
        {
            self.live
                .publish_summary(owner, &json!(chat), &updated["projectId"]);
        }
        if updated.is_some()
            && reply["emptyInput"] == true
            && is_task
            && reconcile
            && let Some(latest) = crate::tasks::Repository::new(self.chats.database.clone())
                .get(owner, chat)
                .await?
            && latest["rowVersion"]
                .as_f64()
                .context("Task title revision")?
                > input["task"]["rowVersion"]
                    .as_f64()
                    .context("Task title input revision")?
            && truthy(latest.get("dispatch"))
        {
            return Ok(Some(latest));
        }
        Ok(None)
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
}
