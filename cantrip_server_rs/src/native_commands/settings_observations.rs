//! Worker reads execute between transactions; publication rechecks the exact source.
use super::{
    CommandError, context, model_attribution,
    settings_persistence::{self as persistence, SettingsRepository, parse, text},
    settings_state,
};
use crate::{
    chats::guard::{self, Access},
    database::Executor,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use std::future::Future;

impl SettingsRepository {
    pub async fn refresh<F, Fut>(&self, owner: &str, chat: &str, read: F) -> Result<Value>
    where
        F: FnOnce(Value) -> Fut + Send,
        Fut: Future<Output = Result<Value>> + Send,
    {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        let (first_owner, first_chat) = (owner.clone(), chat.clone());
        let (scope, before_id) = self
            .database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &first_owner, &first_chat).await?;
                    let scope = persistence::read_scope(tx, &first_owner, &first_chat).await?;
                    let state =
                        persistence::get(Executor::Transaction(tx), &first_owner, &first_chat)
                            .await?
                            .unwrap_or(Value::Null);
                    Ok((
                        scope,
                        state["binding"]
                            .get("bindingId")
                            .cloned()
                            .unwrap_or(Value::Null),
                    ))
                })
            })
            .await?;
        let snapshot = parse(
            "protectedNativeSettingsSnapshotSchema",
            &read(scope.clone()).await?,
        )?;
        if snapshot["context"]["chatId"] != chat
            || snapshot["context"].get("workerId") != scope.get("workerId")
            || snapshot["context"].get("threadId") != scope.get("threadId")
        {
            return Err(CommandError::new(
                "settings-read-scope",
                Some("The settings read returned another native source."),
                409,
            )
            .into());
        }
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &owner, &chat).await?;
                    guard::assert_runtime_writable(
                        tx,
                        &chat,
                        Some(&text(&snapshot["context"]["runtimeGeneration"])?),
                        Some(&text(&snapshot["context"]["settingsVersion"]["epoch"])?),
                        Access::Write,
                    )
                    .await?;
                    if scope != persistence::read_scope(tx, &owner, &chat).await? {
                        return Err(CommandError::new(
                            "settings-read-replaced",
                            Some("The chat moved while its settings were being read."),
                            409,
                        )
                        .into());
                    }
                    let activation = persistence::activation(tx, &chat).await?;
                    if truthy(activation.get("active"))
                        && truthy(activation.get("runtime_generation"))
                        && activation.get("runtime_generation")
                            != snapshot["context"].get("runtimeGeneration")
                    {
                        return Err(CommandError::new(
                            "settings-read-replaced",
                            Some("A different native runtime owns the current turn."),
                            409,
                        )
                        .into());
                    }
                    let scoped = model_attribution::scoped(tx, &owner, &scope, &snapshot).await?;
                    persistence::change(tx, &chat, |state| {
                        if state["binding"]
                            .get("bindingId")
                            .cloned()
                            .unwrap_or(Value::Null)
                            != before_id
                        {
                            return Err(CommandError::new(
                                "settings-read-replaced",
                                Some("A newer settings read has already been published."),
                                409,
                            )
                            .into());
                        }
                        let mut source = scope.clone();
                        source["runtimeGeneration"] =
                            snapshot["context"]["runtimeGeneration"].clone();
                        source["nativeEpoch"] =
                            snapshot["context"]["settingsVersion"]["epoch"].clone();
                        let mut existing_source = state["binding"].clone();
                        if let Value::Object(fields) = &mut existing_source {
                            fields.retain(|key, _| key.as_str() != Some("bindingId"));
                        }
                        let existing_id = state["binding"].get("bindingId");
                        let id = if truthy(existing_id)
                            && existing_source == source
                            && state["effective"]["protectedContent"].get("keyRevision")
                                == snapshot["protectedContent"].get("keyRevision")
                        {
                            existing_id.unwrap().clone()
                        } else {
                            json!(uuid::Uuid::new_v4().to_string())
                        };
                        let mut binding = json!({"bindingId":id});
                        if let Value::Object(fields) = &source {
                            for (key, value) in fields {
                                binding[key.as_str().unwrap()] = value.clone();
                            }
                        }
                        settings_state::bind(state, &before_id, &binding, &scoped)
                    })
                    .await
                })
            })
            .await
    }
    pub async fn observe(&self, owner: &str, value: &Value) -> Result<Value> {
        let input = parse("nativeSettingsObservationRequestSchema", value)?;
        let owner = owner.to_owned();
        let chat = text(&input["snapshot"]["context"]["chatId"])?;
        self.database
            .transaction(|tx| {
                Box::pin(async move { publish_observation(tx, &owner, &chat, &input).await })
            })
            .await
    }
}

async fn publish_observation(
    tx: &crate::database::Transaction<'_>,
    owner: &str,
    chat: &str,
    input: &Value,
) -> Result<Value> {
    let snapshot = &input["snapshot"];
    context::lock_chat(tx, owner, chat).await?;
    guard::assert_runtime_writable(
        tx,
        chat,
        Some(&text(&snapshot["context"]["runtimeGeneration"])?),
        Some(&text(&snapshot["context"]["settingsVersion"]["epoch"])?),
        Access::Write,
    )
    .await?;
    let current_scope = persistence::read_scope(tx, owner, chat).await?;
    let activation = persistence::activation(tx, chat).await?;
    let scoped = model_attribution::scoped(tx, owner, &current_scope, snapshot).await?;
    let next = persistence::change(tx, chat, |state| {
        let binding = &state["binding"];
        if !truthy(Some(binding))
            || binding.get("bindingId") != input.get("bindingId")
            || binding.get("workerId") != input.get("workerId")
            || snapshot["context"].get("workerId") != input.get("workerId")
        {
            return Err(CommandError::new(
                "settings-binding-replaced",
                Some("The settings observation binding is no longer current."),
                409,
            )
            .into());
        }
        if persistence::scope(binding) != current_scope
            || (truthy(activation.get("active"))
                && truthy(activation.get("runtime_generation"))
                && activation.get("runtime_generation") != binding.get("runtimeGeneration"))
        {
            return Err(CommandError::new(
                "settings-binding-replaced",
                Some("The native settings source has changed."),
                409,
            )
            .into());
        }
        if snapshot["context"].get("threadId") != binding.get("threadId")
            || snapshot["context"].get("runtimeGeneration") != binding.get("runtimeGeneration")
            || snapshot["context"]["settingsVersion"].get("epoch") != binding.get("nativeEpoch")
        {
            return Err(CommandError::new(
                "settings-binding-replaced",
                Some("A fresh native read is required for this source."),
                409,
            )
            .into());
        }
        if truthy(state.get("effective"))
            && state["effective"]["context"]["settingsVersion"].get("revision")
                == snapshot["context"]["settingsVersion"].get("revision")
            && state["effective"]["protectedContent"].get("keyRevision")
                != snapshot["protectedContent"].get("keyRevision")
        {
            return Err(CommandError::new(
                "settings-binding-replaced",
                Some("Key rotation requires a fresh native settings read."),
                409,
            )
            .into());
        }
        settings_state::observe(state, &input["bindingId"], &scoped)
    })
    .await?;
    Ok(
        json!({"bindingId":input["bindingId"],"revision":next["revision"],"settingsVersion":next["effective"]["context"]["settingsVersion"]}),
    )
}
