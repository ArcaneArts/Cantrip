//! Select another account before admission and await its real native transfer.
use super::{
    Repository, eligibility, routing::ModelRouting, turn_configuration,
    turn_runtime::stages::Operations,
};
use crate::{
    database::{Database, Executor},
    native_commands::settings_persistence,
    native_handoffs::service::Service as Handoffs,
    operations::{
        logging::{self, Logger},
        shared_failure,
    },
    settings::repository::SettingsRepository,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Preparation = Shared<BoxFuture<'static, Result<Value, Arc<anyhow::Error>>>>;
#[derive(Clone)]
pub struct Service {
    database: Arc<Database>,
    handoffs: Arc<Handoffs>,
    routing: Arc<ModelRouting>,
    active: Arc<Mutex<HashMap<String, (uuid::Uuid, Preparation)>>>,
    operations: Arc<Operations>,
    logger: Logger,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Account failover identity")?
        .lossy()
        .into_owned())
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        handoffs: Arc<Handoffs>,
        routing: Arc<ModelRouting>,
    ) -> Arc<Self> {
        Arc::new(Self {
            database,
            handoffs,
            routing,
            active: Arc::default(),
            operations: Arc::default(),
            logger: logging::server_logger(),
        })
    }

    pub(super) async fn transfer_council_provider(
        &self,
        owner: &str,
        context: &Value,
        recovery: &Value,
    ) -> Result<()> {
        let chat = text(&context["chatId"])?;
        let account = recovery["targetProviderAccountId"].clone();
        let route = recovery["targetModelRouteId"].clone();
        if context["modelRouteId"] == route && context["providerAccountId"] == account {
            return Ok(());
        }
        let state =
            settings_persistence::get(Executor::Database(&self.database), owner, &chat).await?;
        let binding = state
            .as_ref()
            .and_then(|state| state.get("binding"))
            .filter(|binding| {
                ["threadId", "workerId", "modelRouteId", "providerAccountId"]
                    .iter()
                    .all(|key| binding.get(key) == context.get(key))
            })
            .context("The Council provider switch is waiting for its native settings binding.")?;
        self.handoffs
            .begin_and_wait(
                owner,
                &chat,
                &json!({
                    "operationId":recovery["handoffId"],"bindingId":binding["bindingId"],
                    "targetModelRouteId":route,"targetProviderAccountId":account,
                }),
            )
            .await
            .map_err(shared_failure::owned)?;
        Ok(())
    }
    /// Queue admission passes its captured input revision to the same transfer.
    pub fn queued_preparation(self: &Arc<Self>) -> super::recovery::PrepareAccount {
        let service = self.clone();
        Arc::new(move |owner, context, prompt| {
            service.prepare(
                &owner,
                &context,
                prompt,
                context.get("managedInputRevision"),
            )
        })
    }
    /// Admission is eager and owned; dropping a waiter never cancels a transfer.
    pub fn prepare(
        &self,
        owner: &str,
        original: &Value,
        prompt: Value,
        expected_revision: Option<&Value>,
    ) -> BoxFuture<'static, Result<Value>> {
        let key = format!(
            "{owner}:{}",
            original["chatId"].as_str().expect("Stored chat identity")
        );
        let mut active = self.active.lock().unwrap();
        let operation = if let Some((_, existing)) = active.get(&key) {
            existing.clone()
        } else {
            let (this, owner, original, expected, id, copied) = (
                self.clone(),
                owner.to_owned(),
                original.clone(),
                expected_revision.cloned(),
                uuid::Uuid::new_v4(),
                key.clone(),
            );
            let operation = self
                .operations
                .run(async move {
                    let result = this
                        .switch_account(&owner, original, prompt, expected.as_ref())
                        .await;
                    let mut active = this.active.lock().unwrap();
                    if active
                        .get(&copied)
                        .is_some_and(|(current, _)| *current == id)
                    {
                        active.remove(&copied);
                    }
                    Ok(result)
                })
                .map(|result| match result {
                    Ok(value) => value,
                    Err(error) => Err(Arc::new(error)),
                })
                .boxed()
                .shared();
            active.insert(key, (id, operation.clone()));
            operation
        };
        async move { operation.await.map_err(shared_failure::owned) }.boxed()
    }
    async fn switch_account(
        &self,
        owner: &str,
        original: Value,
        prompt: Value,
        expected_revision: Option<&Value>,
    ) -> Result<Value, Arc<anyhow::Error>> {
        let chats = Repository::new(self.database.clone());
        let chat = text(&original["chatId"])?;
        let context = chats
            .execution_context(owner, &chat)
            .await?
            .unwrap_or(original);
        if context["experience"] != "agent"
            || context.get("councilAgent").is_some()
            || !truthy(context.get("threadId"))
            || !truthy(context.get("modelRouteId"))
            || truthy(context.get("executionLaneId"))
            || context.get("managedInputRevision") != expected_revision
        {
            return Ok(context);
        }
        let runtime = self.routing.bound_managed_runtime(owner, &context).await?;
        let requested = prompt.get("modelId").filter(|value| !value.is_null());
        if let Some(model) = requested.filter(|model| *model != &runtime["model"]["id"]) {
            let configuration =
                turn_configuration::model_configuration(&context, &prompt, Some(model))?;
            let pairs = self
                .routing
                .route_pairs(
                    owner,
                    &context,
                    &configuration["turnModelConfiguration"],
                    None,
                )
                .await?;
            let pairs = self
                .routing
                .select_claude_accounts(owner, &context, pairs)
                .await?;
            let target = &pairs[0]["root"]["runtime"];
            if target["provider"]["id"] != runtime["provider"]["id"]
                || target["provider"]["accountId"] != runtime["provider"]["accountId"]
            {
                return self
                    .transfer(
                        owner,
                        context,
                        target,
                        configuration["turnModelConfiguration"].clone(),
                    )
                    .await;
            }
        }
        if runtime["provider"]["kind"] == "claude-code" {
            let pairs = self
                .routing
                .select_claude_accounts(
                    owner,
                    &context,
                    vec![json!({"root":json!({"runtime":runtime}),"subagent":Value::Null})],
                )
                .await?;
            let target = &pairs[0]["root"]["runtime"];
            if target["provider"]["accountId"] != context["providerAccountId"] {
                let configuration = turn_configuration::model_configuration(
                    &context,
                    &prompt,
                    Some(&target["model"]["id"]),
                )?;
                return self
                    .transfer(
                        owner,
                        context,
                        target,
                        configuration["turnModelConfiguration"].clone(),
                    )
                    .await;
            }
            return Ok(context);
        }
        if runtime["provider"]["kind"] != "chatgpt" {
            return Ok(context);
        }
        let settings = SettingsRepository::new(self.database.clone());
        let accounts = settings
            .list_provider_account_runtimes(
                owner,
                &text(&runtime["provider"]["id"])?,
                &text(&context["workerId"])?,
                runtime["model"]["providerModelId"].as_str(),
            )
            .await?;
        let accounts = accounts
            .iter()
            .map(Value::from_serialize)
            .collect::<Vec<_>>();
        let current = accounts
            .iter()
            .find(|a| a.get("accountId") == context.get("providerAccountId"));
        if current.is_none_or(|a| {
            a["weeklyUsageUsedPercent"].is_null()
                || a["weeklyUsageUsedPercent"]
                    .as_f64()
                    .is_some_and(|used| used < 100.0)
                || eligibility::use_chatgpt_credits(&a["credits"])
        }) {
            return Ok(context);
        }
        let (selected, diagnostic) =
            eligibility::account_routes_logged(&runtime, &accounts, None, &context["workerId"]);
        if let Some(diagnostic) = diagnostic {
            (self.logger)(diagnostic);
        }
        let target = selected["runtimes"]
            .as_array()
            .expect("Resolved account runtimes")
            .iter()
            .find(|r| {
                truthy(r["provider"].get("accountId"))
                    && r["provider"].get("accountId") != context.get("providerAccountId")
            });
        let Some(target) = target else {
            return Ok(context);
        };
        let configuration = turn_configuration::model_configuration(
            &context,
            &prompt,
            Some(&target["model"]["id"]),
        )?;
        self.transfer(
            owner,
            context,
            target,
            configuration["turnModelConfiguration"].clone(),
        )
        .await
    }
    async fn transfer(
        &self,
        owner: &str,
        context: Value,
        target: &Value,
        configuration: Value,
    ) -> Result<Value, Arc<anyhow::Error>> {
        let chats = Repository::new(self.database.clone());
        let chat = text(&context["chatId"])?;
        let state =
            settings_persistence::get(Executor::Database(&self.database), owner, &chat).await?;
        let binding = state
            .as_ref()
            .and_then(|state| state.get("binding"))
            .filter(|binding| {
                ["threadId", "workerId", "modelRouteId", "providerAccountId"]
                    .iter()
                    .all(|key| binding.get(key) == context.get(key))
            })
            .context("The chat model change is waiting for its native session binding.")?;
        self.handoffs.prepare_chat_model(
            owner,
            &chat,
            &json!({"operationId":uuid::Uuid::new_v4().to_string(),"bindingId":binding["bindingId"],"targetModelRouteId":target["routeId"],"targetProviderAccountId":target["provider"]["accountId"]}),
            configuration,
        ).await?;
        chats
            .execution_context(owner, &chat)
            .await?
            .context("The transferred chat is no longer available.")
            .map_err(Arc::new)
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
}
