//! Select another account before admission and await its real native transfer.
use super::{Repository, eligibility, turn_runtime::stages::Operations};
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
    pub fn new(database: Arc<Database>, handoffs: Arc<Handoffs>) -> Arc<Self> {
        Arc::new(Self {
            database,
            handoffs,
            active: Arc::default(),
            operations: Arc::default(),
            logger: logging::server_logger(),
        })
    }
    /// Queue admission passes its captured input revision to the same transfer.
    pub fn queued_preparation(self: &Arc<Self>) -> super::recovery::PrepareAccount {
        let service = self.clone();
        Arc::new(move |owner, context| {
            service.prepare(&owner, &context, context.get("managedInputRevision"))
        })
    }
    /// Admission is eager and owned; dropping a waiter never cancels a transfer.
    pub fn prepare(
        &self,
        owner: &str,
        original: &Value,
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
                        .switch_account(&owner, original, expected.as_ref())
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
        expected_revision: Option<&Value>,
    ) -> Result<Value, Arc<anyhow::Error>> {
        let chats = Repository::new(self.database.clone());
        let chat = text(&original["chatId"])?;
        let context = chats
            .execution_context(owner, &chat)
            .await?
            .unwrap_or(original);
        if context["contextKind"] != "project"
            || context["experience"] != "agent"
            || !truthy(context.get("threadId"))
            || !truthy(context.get("modelRouteId"))
            || !truthy(context.get("providerAccountId"))
            || truthy(context.get("executionLaneId"))
            || context.get("managedInputRevision") != expected_revision
        {
            return Ok(context);
        }
        let settings = SettingsRepository::new(self.database.clone());
        let runtime = settings
            .get_model_runtimes(
                owner,
                None,
                Some(&text(&context["modelRouteId"])?),
                true,
                None,
            )
            .await?
            .into_iter()
            .next();
        let Some(runtime) = runtime
            .as_ref()
            .map(Value::from_serialize)
            .filter(|r| r["provider"]["kind"] == "chatgpt")
        else {
            return Ok(context);
        };
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
        let state =
            settings_persistence::get(Executor::Database(&self.database), owner, &chat).await?;
        let Some(binding) = state
            .as_ref()
            .and_then(|state| state.get("binding"))
            .filter(|binding| truthy(Some(binding)))
        else {
            return Ok(context);
        };
        if ["threadId", "workerId", "modelRouteId", "providerAccountId"]
            .iter()
            .any(|key| binding.get(key) != context.get(key))
        {
            return Ok(chats
                .execution_context(owner, &chat)
                .await?
                .unwrap_or(context));
        }
        self.handoffs.begin_and_wait(owner, &chat, &json!({"operationId":uuid::Uuid::new_v4().to_string(),"bindingId":binding["bindingId"],"targetModelRouteId":context["modelRouteId"],"targetProviderAccountId":target["provider"]["accountId"]})).await?;
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
