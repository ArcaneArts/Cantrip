//! Canonical permission policy resolution and admission/dispatch fences.
use super::CommandError;
use super::{Repository, context, settings_persistence};
use crate::database::Executor;
use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::Result;
use futures::FutureExt;

impl Repository {
    pub async fn resolve_permission_transition(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let session=&input["session"];
            let chat=settings_persistence::text(&session["chatId"])?;
            context::lock_chat(tx,&owner,&chat).await?;
            let context=context::execution(tx,&owner,&chat).boxed().await?;
            if !context::same_placement(context.as_ref(),&input["workerId"],Some(session))? || !context::same_runtime_route(context.as_ref(),Some(session))? || !truthy(session.get("threadId")) || context.as_ref().unwrap()["threadId"]!=session["threadId"] || !truthy(session.get("runtimeGeneration")) {
                return Err(CommandError::new("stale-session",None,409).into());
            }
            let state=settings_persistence::get(Executor::Transaction(tx),&owner,&chat).await?.ok_or_else(||CommandError::new("chat-not-found",None,409))?;
            let binding=&state["binding"];
            if !truthy(Some(binding)) {return Err(CommandError::new("permission-binding-required",Some("Read and publish the current native settings source before changing permissions."),409).into());}
            if binding["threadId"]!=session["threadId"] || binding["runtimeGeneration"]!=session["runtimeGeneration"] {return Err(CommandError::new("settings-binding-replaced",None,409).into());}
            settings_persistence::assert_write_binding(tx,&owner,&chat,&binding["bindingId"],Some(&input)).boxed().await?;
            let activation=super::admit::raw_one(tx,"SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",&[&chat]).await?.unwrap_or(Value::Null);
            if truthy(activation.get("active")) && activation["runtime_generation"]!=session["runtimeGeneration"] {return Err(CommandError::new("stale-activation",None,409).into());}
            let revision=state["permissionPolicy"].get("revision").filter(|v|!v.is_null()).cloned().unwrap_or(json!("0"));
            Ok(json!({"permissionTransition":resolve(context.as_ref().unwrap(),&input["selectedId"],&revision),"bindingId":binding["bindingId"]}))
        })).await
    }
}

pub fn resolve(context: &Value, selected: &Value, revision: &Value) -> Value {
    let resolved = if !selected.is_null() {
        selected.clone()
    } else {
        context
            .get("defaultPermissionProfileId")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(":workspace"))
    };
    let effective =
        if truthy(context.get("isPrimary")) && context["worktreePolicy"] == "required-for-writes" {
            json!(":read-only")
        } else {
            resolved.clone()
        };
    json!({"selectedId":selected,"resolvedSelectedId":resolved,"effectiveId":effective,"expectedRevision":revision})
}

pub fn assert_transition(context: &Value, state: &Value, input: &Value) -> Result<()> {
    let intent = &input["intent"];
    let Some(transition) = intent
        .get("permissionTransition")
        .filter(|v| truthy(Some(v)))
    else {
        return Ok(());
    };
    let reject = |code, message| CommandError::new(code, message, 409);
    if !truthy(state.get("binding"))
        || intent.get("settingsBindingId") != state["binding"].get("bindingId")
    {
        return Err(reject(
            "permission-binding-required",
            Some(
                "Read and publish the current native settings source before changing permissions.",
            ),
        )
        .into());
    }
    if input["method"] != "thread/settings/update"
        || !truthy(intent.get("nativeSettingsOperationId"))
        || !intent["settingKeys"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|key| key == "permissions"))
    {
        return Err(reject("invalid-permission-transition", None).into());
    }
    if *transition
        != resolve(
            context,
            &transition["selectedId"],
            &transition["expectedRevision"],
        )
    {
        return Err(reject(
            "permission-policy-replaced",
            Some("The permission default or placement policy changed. Retry the choice."),
        )
        .into());
    }
    let revision = state["permissionPolicy"]
        .get("revision")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("0"));
    if transition["expectedRevision"] != revision {
        return Err(reject(
            "permission-revision-conflict",
            Some("The confirmed permission policy changed. Retry the choice."),
        )
        .into());
    }
    let other = |entry: &Value| {
        truthy(entry.get("permissionTransition"))
            && entry.get("operationId") != input.get("operationId")
    };
    let pending = state["pending"]
        .as_array()
        .is_some_and(|entries| entries.iter().any(|entry| other(&entry["intent"])));
    let uncertain = other(&state["desired"]) && state["desiredStatus"] == "uncertain";
    if pending || uncertain {
        return Err(reject(
            "permission-transition-pending",
            Some("Another permission change is still pending. Retry after it settles."),
        )
        .into());
    }
    Ok(())
}
