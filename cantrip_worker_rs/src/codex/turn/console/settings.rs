//! Admit exact settings requests through Core. Native application evidence
//! remains owned by the worker after the viewing socket closes.
use super::{View, gateway::fault};
use crate::{
    chat_content::Scope,
    codex::{
        rpc_requests::Failure,
        turn::{RPC_TIMEOUT, autonomous::same_workspace, settings::UPDATE},
    },
    metadata::Signal,
};
use anyhow::{Context, Result, ensure};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use std::sync::Arc;

pub(super) fn request(
    view: Arc<View>,
    session: Value,
    frame: Value,
    open: Signal,
) -> Work<(String, Value)> {
    cantrip_transport::lifecycle::owned(async move {
        let id = frame["id"].clone();
        let response = match execute(&view, session, frame, &open).await {
            Ok(result) => json!({"id":id,"result":result}),
            Err(error) => error
                .downcast_ref::<Failure>()
                .and_then(|failure| failure.native_error.as_ref())
                .map_or_else(
                    || fault(&id, -32001, &error.to_string()),
                    |native| json!({"id":id,"error":native}),
                ),
        };
        Ok((id.stringify(), response))
    })
}

async fn execute(view: &View, session: Value, mut frame: Value, open: &Signal) -> Result<Value> {
    open.check()?;
    view.assert_current()?;
    let operation = uuid::Uuid::new_v4().to_string();
    let params = &mut frame["params"];
    validate(view, params).await?;
    // The bundled TUI serializes this optional native field as null.
    // Core has no managed plugin-settings command, and null preserves plugins.
    if let Value::Object(fields) = params
        && fields
            .get(&JsString::from("disabledPluginIds"))
            .is_some_and(Value::is_null)
    {
        fields.shift_remove(&JsString::from("disabledPluginIds"));
    }
    if params.get("operationId").is_none() {
        params["operationId"] = json!(operation);
    }
    let native_operation = params["operationId"]
        .as_js_string()
        .filter(|id| !id.is_empty() && id.len() <= 255)
        .context("Invalid native settings operation identity.")?
        .clone();

    let runtime = &view.prepared.runtime;
    let thread = view.prepared.thread.id();
    let gate = runtime.inference_router().goal_mutations(thread);
    let _mutation = match gate {
        Some(gate) => Some(gate.lock_owned().await),
        None => None,
    };
    let scope = Scope::new(view.turns.encryption.clone())?;
    ensure!(
        scope.owner == view.queue_key.0 && scope.server == view.queue_key.1,
        "The managed settings owner changed."
    );
    let activation = view
        .turns
        .active
        .lock()
        .unwrap()
        .active
        .get(&view.queue_key)
        .and_then(|active| active.root.as_ref())
        .map_or(Value::Null, |root| root.activation.clone());

    open.check()?;
    view.assert_current()?;
    let receipt = view
        .turns
        .receipts
        .admit_console_settings(
            scope,
            session,
            &operation,
            &frame,
            &view.permission,
            activation,
        )
        .await?;
    let observation = async {
        open.check()?;
        view.assert_current()?;
        receipt.dispatch().await?;
        open.check()?;
        view.assert_current()?;
        let scope = Scope::new(view.turns.encryption.clone())?;
        ensure!(
            scope.owner == view.queue_key.0 && scope.server == view.queue_key.1,
            "The managed settings owner changed."
        );
        view.turns
            .settings
            .observe(runtime, &receipt, scope, &native_operation)
    }
    .await;
    let observation = match observation {
        Ok(observation) => observation,
        Err(error) => {
            receipt
                .rejected(&json!({"code":-32000,"message":"Native settings were not dispatched."}))
                .await?;
            return Err(error);
        }
    };
    let reply = runtime
        .request(
            UPDATE.into(),
            Some(frame["params"].clone()),
            Some(RPC_TIMEOUT),
            None,
        )
        .await;
    observation.settle(&receipt, reply).await
}

async fn validate(view: &View, params: &Value) -> Result<()> {
    ensure!(
        params.is_object() && params["threadId"].as_js_string() == Some(view.prepared.thread.id()),
        "Managed settings require the bound thread ID."
    );
    for key in [
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
        "sandboxPolicy",
        "permissions",
        "permissionProfile",
        "permissionProfileId",
    ] {
        ensure!(
            params[key].is_null(),
            "Changing native permissions requires the managed permission transition."
        );
    }
    for key in [
        "config",
        "managedConfig",
        "baseInstructions",
        "developerInstructions",
        "environments",
    ] {
        ensure!(
            params[key].is_null(),
            "Managed settings cannot override {key}."
        );
    }
    if !params["cwd"].is_null() {
        same_workspace(&view.cwd, &params["cwd"]).await?;
    }
    Ok(())
}
