//! A Task private Goal has no managed input/command. Keep its immutable keeper
//! Source separate from current Task routing and the provider FIFO episode.
use super::*;
use sha2::{Digest, Sha256};

fn replaced<T>() -> Result<T> {
    Err(CommandError::new("handoff-task-goal-source-replaced",
        Some("The queued Goal cycle changed or has already started. Refresh the queued cycle and try again."),409).into())
}
pub(super) async fn read(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    allow_inactive: bool,
) -> Result<Option<Value>> {
    let Some(context) = context::execution(tx, owner, chat).await? else {
        return Ok(None);
    };
    if context["experience"] != "task" {
        return Ok(None);
    }
    tx.query(
        "SELECT chat_id FROM tasks WHERE chat_id=$1 FOR UPDATE",
        &[&chat],
    )
    .await?;
    let cycle = one(Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1 FOR UPDATE", &[&owner,&chat]).await?;
    let Some(cycle) = cycle else {
        return replaced();
    };
    let mut row = one(Executor::Transaction(tx),
        "SELECT jsonb_build_object('task',to_jsonb(t),'cycle',to_jsonb(c),'chat',to_jsonb(ch),'project',to_jsonb(p),'route',to_jsonb(r))::text FROM chats ch JOIN projects p ON p.id=ch.project_id AND p.owner_id=$1 JOIN tasks t ON t.chat_id=ch.id JOIN task_dispatch_cycles c ON c.id=$3 AND c.chat_id=ch.id AND c.owner_id=$1 LEFT JOIN model_routes r ON r.id=c.model_route_id WHERE ch.id=$2 AND ch.owner_id=$1 LIMIT 1 FOR UPDATE OF ch,p,t,c",
        &[&owner,&chat,&text(&cycle["id"])?]).await?.context("Task Goal handoff source not found")?;
    let (t, c, ch, p, r) = (
        &row["task"],
        &row["cycle"],
        &row["chat"],
        &row["project"],
        &row["route"],
    );
    let input = &c["goal_input"];
    if context["contextKind"] != "project"
        || !truthy(context.get("threadId"))
        || !truthy(context.get("worktreeId"))
        || r.is_null()
        || t["plan_goal_enabled"] != true
        || t["has_final_plan"] != true
        || t["has_goal_prompt"] != true
        || t["implementation_started_at"].is_null()
        || (!allow_inactive
            && (!t["active_operation_id"].is_null()
                || matches!(t["state"].as_str(), Some("complete" | "failed" | "paused"))
                || !ch["archived_at"].is_null()
                || ch["automation_paused"] == true
                || ch["managed_autonomy_stopped"] == true
                || p["task_scheduling_paused"] == true))
        || c["operation_kind"] != "finalize"
        || c["started_at"].is_null()
        || (!allow_inactive && matches!(c["state"].as_str(), Some("paused" | "cancelled")))
        || c.get("physical_worker_id") != context.get("workerId")
        || c.get("codex_thread_id") != context.get("threadId")
        || c.get("worktree_id") != context.get("worktreeId")
        || c.get("model_route_id") != context.get("modelRouteId")
        || c.get("provider_account_id") != context.get("providerAccountId")
        || (!allow_inactive
            && truthy(Some(input))
            && input["deferred"] != true
            && input["failedBeforeDispatch"] != true
            && input["firstDispatchedOperationId"].is_null())
    {
        return replaced();
    }
    row["scope"] = parse(
        "nativeSettingsReadScopeSchema",
        &json!({
        "chatId":chat,"workerId":context["workerId"],"threadId":context["threadId"],
        "contextKind":"project","projectId":context["projectId"],"placementId":context["worktreeId"],
        "modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"]}),
    )?;
    row["context"] = context;
    Ok(Some(row))
}
fn source_cycle(record: &Value) -> &Value {
    &record["identity"]["recovery"]["taskGoalCycle"]
}
pub(super) fn assert_record(
    row: &Value,
    scope: &Value,
    record: &Value,
    original: Option<&Value>,
) -> Result<()> {
    let record = parse("taskGoalCycleSourceRecordSchema", record)?;
    let cycle = source_cycle(&record);
    let recovery = &record["identity"]["recovery"];
    if cycle.is_null()
        || !truthy(recovery.get("threadId"))
        || !truthy(recovery.get("turnId"))
        || [
            "messageId",
            "commandId",
            "commandGeneration",
            "taskInput",
            "autonomousGoal",
        ]
        .iter()
        .any(|key| truthy(recovery.get(key)))
        || record["identity"]["operationId"]
            != format!(
                "native-inference:{}:{}:{}:{}",
                text(&recovery["threadId"])?,
                text(&recovery["turnId"])?,
                text(&cycle["scopeId"])?,
                text(&cycle["gateAttemptId"])?
            )
        || (truthy(record.get("nativeExecution"))
            && (record["nativeExecution"].get("threadId") != recovery.get("threadId")
                || record["nativeExecution"].get("turnId") != recovery.get("turnId")
                || record["nativeExecution"].get("scopeId") != cycle.get("scopeId")))
    {
        return replaced();
    }
    let key = format!(
        "{:x}",
        Sha256::digest(
            json!([
                record["workerGeneration"].clone(),
                record["identity"]["runtimeGeneration"].clone(),
                record["identity"]["operationId"].clone()
            ])
            .stringify()
            .as_bytes()
        )
    );
    let changed = original.is_some_and(|source| {
        row["route"].get("provider_id") != source["identity"].get("providerId")
    });
    let epoch = cycle["orderEpoch"]
        .as_i64()
        .context("Task Goal provider order")?
        + i64::from(changed);
    if record["key"] != key
        || !deep_equal(&row["scope"], scope)
        || record["identity"].get("chatId") != scope.get("chatId")
        || record["identity"].get("projectId") != scope.get("projectId")
        || record["identity"]["recovery"].get("threadId") != scope.get("threadId")
        || cycle.get("cycleId") != row["cycle"].get("id")
        || row["cycle"]["goal_order_epoch"].as_i64() != Some(epoch)
        || (original.is_none()
            && (record["identity"].get("providerId") != row["route"].get("provider_id")
                || cycle.get("modelRouteId") != scope.get("modelRouteId")
                || cycle.get("providerAccountId") != scope.get("providerAccountId")))
    {
        return replaced();
    }
    Ok(())
}
pub(super) fn reserve(row: &Value, record: &Value) -> Result<Value> {
    assert_record(row, &row["scope"], record, None)?;
    if !matches!(record["state"].as_str(), Some("waiting" | "granted"))
        || !record["outcome"].is_null()
    {
        return replaced();
    }
    parse(
        "nativeRuntimeHandoffQueuedSourceSchema",
        &json!({
        "operationId":record["identity"]["operationId"],"operationGeneration":record["identity"]["runtimeGeneration"],
        "withdrawn":false,"taskGoal":record,"taskGoalControl":json!({
            "taskConfiguration":row["task"]["model_configuration"],
            "cycleConfiguration":row["cycle"]["model_configuration"]})}),
    )
}
pub(super) async fn assert_current(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    queued: &Value,
    allow_inactive: bool,
) -> Result<Value> {
    if !truthy(queued.get("taskGoal"))
        || !truthy(queued.get("taskGoalControl"))
        || [
            "autonomousAttempt",
            "goalRecovery",
            "goalClaim",
            "goalWithdrawal",
            "retargetedPrompt",
        ]
        .iter()
        .any(|key| truthy(queued.get(key)))
    {
        return replaced();
    }
    let Some(row) = read(tx, owner, &text(&binding["chatId"])?, allow_inactive).await? else {
        return replaced();
    };
    let mut scope = binding.clone();
    if let Value::Object(fields) = &mut scope {
        fields.retain(|key, _| {
            !matches!(
                key.as_str(),
                Some("bindingId" | "runtimeGeneration" | "nativeEpoch")
            )
        });
    }
    let source = &queued["taskGoal"];
    assert_record(&row, &scope, source, Some(source))?;
    if queued.get("operationId") != source["identity"].get("operationId")
        || queued.get("operationGeneration") != source["identity"].get("runtimeGeneration")
        || !deep_equal(
            &row["task"]["model_configuration"],
            &queued["taskGoalControl"]["taskConfiguration"],
        )
        || !deep_equal(
            &row["cycle"]["model_configuration"],
            &queued["taskGoalControl"]["cycleConfiguration"],
        )
    {
        return replaced();
    }
    Ok(row)
}
pub(super) async fn confirm(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    queued: &Value,
    proof: &Value,
) -> Result<()> {
    let row = assert_current(tx, owner, binding, queued, false).await?;
    let source = &queued["taskGoal"];
    let cycle = source_cycle(source);
    if proof.is_null()
        || proof.get("key") != source.get("key")
        || proof.get("workerGeneration") != source.get("workerGeneration")
        || !deep_equal(&proof["identity"], &source["identity"])
        || proof.get("order") != source.get("order")
        || proof["state"] != "released"
        || proof["outcome"] != "never-started"
        || (truthy(proof.get("nativeExecution"))
            && (proof["nativeExecution"].get("threadId") != binding.get("threadId")
                || proof["nativeExecution"].get("turnId")
                    != source["identity"]["recovery"].get("turnId")
                || proof["nativeExecution"].get("scopeId") != cycle.get("scopeId")))
    {
        return replaced();
    }
    let previous = &row["cycle"]["goal_cycle_recovery"];
    let same = !previous.is_null()
        && ["cycleId", "goalEpoch", "orderEpoch"]
            .iter()
            .all(|key| previous["cycle"].get(key) == cycle.get(key))
        && previous.get("providerId") == source["identity"].get("providerId")
        && previous.get("threadId") == binding.get("threadId")
        && (!truthy(previous.get("settled"))
            || (previous["settled"]["reason"] == "dispatched"
                && previous["settled"].get("operationId")
                    == source["identity"].get("operationId")));
    let mut marker = if same {
        previous.clone()
    } else {
        json!({
        "sourceKey":source["key"],"operationId":source["identity"]["operationId"],
        "runtimeGeneration":source["identity"]["runtimeGeneration"],"workerGeneration":source["workerGeneration"],
        "workerId":binding["workerId"],"providerId":source["identity"]["providerId"],
        "threadId":binding["threadId"],"turnId":source["identity"]["recovery"]["turnId"],"cycle":cycle})
    };
    if same {
        if let Value::Object(fields) = &mut marker {
            fields.retain(|key, _| key.as_str() != Some("settled"));
        }
        marker["admission"] = Value::Null;
    }
    let marker = parse("taskGoalCycleRecoverySchema", &marker)?;
    tx.query(
        "UPDATE task_dispatch_cycles SET goal_cycle_recovery=$1::text::jsonb WHERE id=$2",
        &[&marker.stringify(), &text(&row["cycle"]["id"])?],
    )
    .await?;
    Ok(())
}
pub(super) async fn commit(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    queued: &Value,
    target: &Value,
    prepared: &Value,
) -> Result<Option<Value>> {
    if !truthy(queued.get("taskGoal")) {
        return Ok(None);
    }
    let row = assert_current(tx, owner, binding, queued, false).await?;
    let changed = row["route"].get("provider_id") != target.get("providerId");
    let epoch = row["cycle"]["goal_order_epoch"]
        .as_i64()
        .context("Task provider queue order")?
        + i64::from(changed);
    if epoch > 9_007_199_254_740_991 {
        return replaced();
    }
    let update_model = |configuration: &Value| -> Result<Value> {
        let mut configuration = configuration.clone();
        configuration["modelId"] = target["modelId"].clone();
        if let Some(reasoning) = prepared.get("reasoningEffort") {
            configuration["reasoningEffort"] = reasoning.clone();
        }
        parse("modelConfigurationSchema", &configuration)
    };
    let task_configuration = update_model(&row["task"]["model_configuration"])?;
    let cycle_configuration = update_model(if row["cycle"]["model_configuration"].is_null() {
        &row["task"]["model_configuration"]
    } else {
        &row["cycle"]["model_configuration"]
    })?;
    let mut marker = row["cycle"]["goal_cycle_recovery"].clone();
    if marker.is_null()
        || truthy(marker.get("settled"))
        || marker["cycle"].get("goalEpoch") != source_cycle(&queued["taskGoal"]).get("goalEpoch")
    {
        return replaced();
    }
    marker["admission"] = Value::Null;
    if changed {
        marker["settled"] = json!({"reason":"transferred","turnId":queued["taskGoal"]["identity"]["recovery"]["turnId"],"operationId":Value::Null});
    } else {
        marker["binding"] = json!({"modelRouteId":target["routeId"],"providerAccountId":target["accountId"],"orderEpoch":epoch});
    }
    let marker = parse("taskGoalCycleRecoverySchema", &marker)?;
    let now = crate::auth::now();
    tx.query("UPDATE tasks SET model_configuration=$1::text::jsonb,row_version=row_version+1,updated_at=$2 WHERE chat_id=$3",
        &[&task_configuration.stringify(),&now,&text(&binding["chatId"])?]).await?;
    tx.query("UPDATE task_dispatch_cycles SET model_configuration=$1::text::jsonb,model_route_id=$2,provider_account_id=$3,goal_order_epoch=$4,goal_cycle_recovery=$5::text::jsonb,updated_at=$6 WHERE id=$7",
        &[&cycle_configuration.stringify(),&text(&target["routeId"])?,&optional(&target["accountId"])?,&epoch,&marker.stringify(),&now,&text(&row["cycle"]["id"])?]).await?;
    let mut next = queued.clone();
    next["taskGoalControl"] =
        json!({"taskConfiguration":task_configuration,"cycleConfiguration":cycle_configuration});
    Ok(Some(next))
}
