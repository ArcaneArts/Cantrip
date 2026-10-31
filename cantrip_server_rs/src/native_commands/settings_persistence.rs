//! Canonical settings state and command journal collaborators share the caller's transaction.
use super::{CommandError, context, settings_state};
use crate::{
    database::{Database, Executor, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result, bail};
use std::sync::Arc;

#[derive(Clone)]
pub struct SettingsRepository {
    pub(super) database: Arc<Database>,
}
pub(super) fn parse(schema: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(schema, Some(value))
}
pub(super) fn text(value: &Value) -> Result<String> {
    value
        .as_js_string()
        .map(|v| v.lossy().into_owned())
        .context("Native settings identity")
}
fn parse_state(chat: &str, value: &Value) -> Result<Value> {
    let state = if truthy(Some(value)) {
        parse("nativeSettingsStateSchema", value)?
    } else {
        settings_state::empty(chat)?
    };
    if state["chatId"] != chat {
        bail!("Stored settings belong to another chat.");
    }
    Ok(state)
}
pub async fn get(executor: Executor<'_, '_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    let rows=executor.query("SELECT s.state::text FROM chats c LEFT JOIN native_settings_states s ON s.chat_id=c.id WHERE c.id=$1 AND c.owner_id=$2", &[&chat,&owner]).await?;
    rows.first()
        .map(|row| {
            let value = row
                .get::<Option<String>>(0)?
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(Value::Null);
            parse_state(chat, &value)
        })
        .transpose()
}
pub async fn change<F>(tx: &Transaction<'_>, chat: &str, change: F) -> Result<Value>
where
    F: FnOnce(&Value) -> Result<Value> + Send,
{
    let rows = tx
        .query(
            "SELECT state::text FROM native_settings_states WHERE chat_id=$1",
            &[&chat],
        )
        .await?;
    let value = rows
        .first()
        .map(|row| Ok::<Value, anyhow::Error>(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()?
        .unwrap_or(Value::Null);
    let current = parse_state(chat, &value)?;
    let next = parse_state(chat, &change(&current)?)?;
    if next["revision"] == current["revision"] {
        return Ok(current);
    }
    let encoded = next.stringify();
    let now = crate::auth::now();
    tx.query("INSERT INTO native_settings_states(chat_id,state) VALUES($1,$2::text::jsonb) ON CONFLICT(chat_id) DO UPDATE SET state=EXCLUDED.state,updated_at=$3", &[&chat,&encoded,&now]).await?;
    Ok(next)
}
pub async fn read_scope(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Value> {
    let context = context::execution(tx, owner, chat).await?;
    let Some(context) = context.filter(|c| truthy(c.get("threadId"))) else {
        return Err(CommandError::new(
            "settings-thread-unbound",
            Some("The chat has no bound native thread to read."),
            409,
        )
        .into());
    };
    let placement = context
        .get("worktreeId")
        .filter(|v| !v.is_null())
        .or_else(|| context.get("scratchRootId"))
        .cloned()
        .unwrap_or(Value::Null);
    parse(
        "nativeSettingsReadScopeSchema",
        &json!({"chatId":chat,"workerId":context["workerId"],"threadId":context["threadId"],"contextKind":context["contextKind"],"projectId":context["projectId"],"placementId":placement,"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"]}),
    )
}
pub(super) async fn activation(tx: &Transaction<'_>, chat: &str) -> Result<Value> {
    let rows = tx
        .query(
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?;
    Ok(rows
        .first()
        .map(|row| Ok::<Value, anyhow::Error>(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()?
        .unwrap_or(Value::Null))
}
pub(super) fn scope(binding: &Value) -> Value {
    let mut scope = binding.clone();
    if let Value::Object(fields) = &mut scope {
        fields.retain(|key, _| {
            !matches!(
                key.as_str(),
                Some("bindingId" | "runtimeGeneration" | "nativeEpoch")
            )
        });
    }
    scope
}
pub async fn assert_write_binding(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    expected: &Value,
    source: Option<&Value>,
) -> Result<Value> {
    let current_scope = read_scope(tx, owner, chat).await?;
    let state = get(Executor::Transaction(tx), owner, chat)
        .await?
        .unwrap_or(Value::Null);
    let binding = &state["binding"];
    if !truthy(Some(binding)) || binding.get("bindingId") != Some(expected) {
        return Err(CommandError::new(
            "settings-binding-replaced",
            Some("The selected native settings source is no longer current."),
            409,
        )
        .into());
    }
    let activation = activation(tx, chat).await?;
    let scope = scope(binding);
    let mut replaced = scope != current_scope
        || (truthy(activation.get("active"))
            && truthy(activation.get("runtime_generation"))
            && activation.get("runtime_generation") != binding.get("runtimeGeneration"));
    if !replaced && let Some(source) = source {
        let session = &source["session"];
        let mut supplied = json!({"workerId":source["workerId"]});
        for key in [
            "chatId",
            "threadId",
            "contextKind",
            "projectId",
            "placementId",
            "modelRouteId",
            "providerAccountId",
        ] {
            if let Some(value) = session.get(key) {
                supplied[key] = value.clone();
            }
        }
        replaced = scope != supplied
            || session.get("runtimeGeneration") != binding.get("runtimeGeneration");
    }
    if replaced {
        return Err(CommandError::new(
            "settings-binding-replaced",
            Some("The native settings source has changed."),
            409,
        )
        .into());
    }
    Ok(binding.clone())
}
fn thread_settings(command: &Value) -> Result<bool> {
    if command["method"] != "thread/settings/update" {
        return Ok(false);
    }
    let intent = parse("nativeCommandIntentSchema", &command["intent"])?;
    Ok(intent["scope"] == "thread" && truthy(intent.get("nativeSettingsOperationId")))
}
pub async fn admit_state(tx: &Transaction<'_>, command: &Value) -> Result<()> {
    if command["status"] != "accepted" || !thread_settings(command)? {
        return Ok(());
    }
    let source = parse("nativeCommandSessionSchema", &command["identity"])?;
    let intent = parse("nativeCommandIntentSchema", &command["intent"])?;
    let mut request = json!({"operationId":command["operation_id"],"operationGeneration":command["operation_generation"],"origin":command["origin"],"source":json!({"workerId":command["worker_id"],"threadId":source["threadId"],"runtimeGeneration":source["runtimeGeneration"]}),"payloadDigest":command["payload_digest"],"protectedContent":command["protected_payload"]});
    if truthy(intent.get("permissionTransition")) {
        request["permissionTransition"] = intent["permissionTransition"].clone();
    }
    let request = parse("nativeSettingsIntentSchema", &request)?;
    change(tx, &text(&command["chat_id"])?, |state| {
        settings_state::request(state, &request)
    })
    .await?;
    Ok(())
}
pub async fn settle_state(tx: &Transaction<'_>, command: &Value, outcome: &str) -> Result<()> {
    if !thread_settings(command)? {
        return Ok(());
    }
    let operation = json!({"operationId":command["operation_id"],"operationGeneration":command["operation_generation"]});
    change(tx, &text(&command["chat_id"])?, |state| {
        settings_state::settle(state, &operation, outcome)
    })
    .await?;
    Ok(())
}
pub async fn settle_transport(tx: &Transaction<'_>, command: &Value) -> Result<()> {
    if !thread_settings(command)? {
        return Ok(());
    }
    let application = command["settings_application"].get("status");
    let outcome = application
        .filter(|v| truthy(Some(v)) && **v != "pending")
        .or_else(|| {
            matches!(command["status"].as_str(), Some("rejected" | "uncertain"))
                .then_some(&command["status"])
        });
    if let Some(outcome) = outcome {
        settle_state(tx, command, &text(outcome)?).await?;
    }
    Ok(())
}
impl SettingsRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        get(Executor::Database(&self.database), owner, chat).await
    }
    pub async fn resolve_write_binding(
        &self,
        owner: &str,
        chat: &str,
        expected: &Value,
    ) -> Result<Value> {
        let (owner, chat, expected) = (owner.to_owned(), chat.to_owned(), expected.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &owner, &chat).await?;
                    assert_write_binding(tx, &owner, &chat, &expected, None).await
                })
            })
            .await
    }
}
