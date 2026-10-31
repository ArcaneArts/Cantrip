use super::{
    CommandError, Repository,
    admit::{optional, raw_one, reject, text},
    context, permissions, policy, queue, receipt, settings_persistence,
};
use crate::{
    chats::{
        execution_lanes,
        guard::{self, Access},
        managed_console,
    },
    database::{Executor, Transaction},
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use futures::FutureExt;

async fn dispatch(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let session = &input["session"];
    let chat = text(&session["chatId"])?;
    let worker = text(&input["workerId"])?;
    let operation = text(&input["operationId"])?;
    let generation = text(&input["operationGeneration"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let row = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &operation,
        &generation,
    )
    .await?;
    let runtime = optional(&session["runtimeGeneration"])?;
    guard::assert_runtime_writable(
        tx,
        &chat,
        runtime.as_deref(),
        None,
        if row["kind"] == "attach" {
            Access::Attach
        } else {
            Access::Write
        },
    )
    .await?;
    if row.get("payload_digest") != input.get("payloadDigest")
        || row.get("chat_id") != session.get("chatId")
    {
        return reject("operation-id-conflict");
    }
    if row["status"] == "rejected" {
        let code = row
            .get("rejection_code")
            .filter(|v| !v.is_null())
            .map(text)
            .transpose()?
            .unwrap_or_else(|| "operation-rejected".into());
        return Err(CommandError::new(code, None, 409).into());
    }
    if row["status"] != "accepted" {
        return reject("operation-already-dispatched");
    }
    let prior = &row["identity"];
    let current = context::execution(tx, owner, &chat).await?;
    if !context::same_placement(current.as_ref(), &input["workerId"], Some(session))? {
        return reject("stale-session");
    }
    for field in ["placementId", "projectId", "contextKind"] {
        if wire::property(Some(prior), field)? != session.get(field) {
            return reject("stale-session");
        }
    }
    for field in ["threadId", "runtimeGeneration", "connectionId"] {
        let previous = wire::property(Some(prior), field)?;
        if (previous != Some(&Value::Null) && previous != session.get(field))
            || !truthy(session.get(field))
        {
            return reject("stale-session");
        }
    }
    let mut current = current.unwrap();
    if !context::same_runtime_route(Some(&current), Some(session))?
        || (wire::property(Some(prior), "threadId")? != Some(&Value::Null)
            && !context::same_runtime_route(Some(prior), Some(session))?)
    {
        return reject("runtime-route-mismatch");
    }
    if truthy(current.get("threadId")) && current.get("threadId") != session.get("threadId") {
        return reject("thread-identity-mismatch");
    }
    let intent = &row["intent"];
    if let Some(binding) =
        wire::property(Some(intent), "settingsBindingId")?.filter(|v| truthy(Some(v)))
    {
        settings_persistence::assert_write_binding(tx, owner, &chat, binding, Some(input)).await?;
    }
    if !truthy(intent.get("permissionTransition"))
        && truthy(intent.get("permissionProfileId"))
        && intent.get("permissionProfileId")
            != managed_console::permission_profile(&current).get("effectiveId")
    {
        return reject("permission-profile-mismatch");
    }
    if truthy(intent.get("permissionTransition")) {
        let state = settings_persistence::get(Executor::Transaction(tx), owner, &chat).await?;
        let Some(state) = state else {
            return reject("chat-not-found");
        };
        permissions::assert_transition(
            &current,
            &state,
            &json!({"method":row["method"],"operationId":row["operation_id"],"intent":intent}),
        )?;
    }
    if truthy(row.get("activation_generation")) {
        let active = raw_one(
            tx,
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&chat],
        )
        .await?
        .unwrap_or(Value::Null);
        if !truthy(active.get("active"))
            || active.get("generation") != row.get("activation_generation")
            || active.get("execution_lane_id") != current.get("executionLaneId")
            || !matches!(
                current["status"].as_str(),
                Some("running" | "waiting-for-approval")
            )
            || (active["runtime_generation"] != Value::Null
                && active.get("runtime_generation") != session.get("runtimeGeneration"))
        {
            return reject("stale-activation");
        }
        tx.query(
            "UPDATE native_command_activations SET runtime_generation=$1 WHERE chat_id=$2",
            &[&runtime, &chat],
        )
        .await?;
    } else if !policy::contains("sessionDiscoveryMethods", &text(&row["method"])?)
        && matches!(
            current["status"].as_str(),
            Some("running" | "waiting-for-approval")
        )
    {
        return reject("stale-activation");
    }
    if !truthy(current.get("threadId")) {
        if row["kind"] != "start" || row["origin"] != "gui" || !truthy(row.get("execution_lane_id"))
        {
            return reject("thread-identity-mismatch");
        }
        execution_lanes::update_runtime_in_transaction(
            tx,
            &chat,
            &text(&row["execution_lane_id"])?,
            Some(&text(&session["threadId"])?),
            "running",
        )
        .boxed()
        .await?;
        current = context::execution(tx, owner, &chat)
            .await?
            .unwrap_or(Value::Null);
    }
    if row["method"] == "thread/goal/clear"
        || (row["method"] == "thread/goal/set" && intent["goalStatus"] == "paused")
    {
        queue::cancel_goal_handoffs(tx, &chat).await?;
    }
    if row["method"] == "turn/interrupt" {
        queue::stop_autonomy(tx, &chat).await?;
    } else if truthy(intent.get("resumeAutonomy")) {
        tx.query(
            "UPDATE chats SET managed_autonomy_stopped=false WHERE id=$1",
            &[&chat],
        )
        .await?;
    }
    if row["method"] == "turn/pause" {
        let paused = intent["paused"].as_bool().context("Native pause intent")?;
        tx.query(
            "UPDATE chats SET automation_paused=$1 WHERE id=$2",
            &[&paused, &chat],
        )
        .await?;
        current = context::execution(tx, owner, &chat)
            .await?
            .unwrap_or(Value::Null);
    }
    if truthy(intent.get("resumeAutonomy")) || row["method"] == "turn/pause" {
        queue::changed(tx, &chat).await?;
    }
    let settings = row["method"] == "thread/settings/update"
        && truthy(intent.get("nativeSettingsOperationId"));
    let application=json!({"nativeOperationId":intent["nativeSettingsOperationId"],"submissionId":Value::Null,"status":"pending","evidenceCount":0}).stringify();
    let identity = session.stringify();
    let now = crate::auth::now();
    let updated=raw_one(tx,"UPDATE native_commands SET identity=$1::text::jsonb,status='dispatched',settings_application=CASE WHEN $2::boolean THEN $3::text::jsonb ELSE settings_application END,updated_at=$4 WHERE operation_id=$5 RETURNING to_jsonb(native_commands)::text",&[&identity,&settings,&application,&now,&operation]).await?.context("Database returned no row after dispatching native command.")?;
    settings_persistence::settle_state(tx, &updated, "dispatched").await?;
    tx.query("UPDATE managed_queue_claims SET status='dispatched' WHERE operation_id=$1 AND operation_generation=$2 AND status='accepted'",&[&operation,&generation]).await?;
    Ok(json!({"receipt":receipt::from_row(&updated)?,"execution":current}))
}
impl Repository {
    pub async fn dispatch(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { dispatch(tx, &owner, &input).await }))
            .await
    }
}
