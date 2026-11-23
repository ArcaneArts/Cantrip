use super::activation;
use crate::chats::managed_console;
use crate::{
    database::{Executor, Transaction},
    native_commands::{
        admit::{optional, raw_one, reject, text},
        context, receipt, turns,
    },
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

pub(super) async fn run(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let session = &input["session"];
    let chat = text(&session["chatId"])?;
    let worker = text(&input["workerId"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let previous = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &text(&input["previousOperationId"])?,
        &text(&input["previousOperationGeneration"])?,
    )
    .await?;
    let root=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND owner_id=$2 AND worker_id=$3",&[&text(&input["rootOperationId"])?,&owner,&worker]).await?;
    let existing = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&input["operationId"])?],
    )
    .await?;
    let previous_chat = text(&previous["chat_id"])?;
    let mut current = context::execution(tx, owner, &previous_chat).await?;
    let active = activation(tx, &previous_chat).await?;
    if let Some(existing) = existing {
        if existing["owner_id"] != json!(owner)
            || existing.get("worker_id") != input.get("workerId")
            || existing.get("logical_operation_id") != input.get("rootOperationId")
            || existing.get("previous_operation_id") != input.get("previousOperationId")
            || existing.get("payload_digest") != input.get("payloadDigest")
            || existing.get("identity") != Some(session)
        {
            return reject("operation-id-conflict");
        }
        let live = context::same_placement(current.as_ref(), &input["workerId"], Some(session))?
            && context::same_runtime_route(current.as_ref(), Some(session))?
            && truthy(active.get("active"))
            && !truthy(active.get("logical_cancelled"))
            && active.get("generation") == existing.get("activation_generation");
        return Ok(
            json!({"receipt":receipt::from_row(&existing)?,"replayed":true,"execution":if live{current.unwrap()}else{Value::Null}}),
        );
    }
    let Some(root) = root.filter(|r| {
        r.get("logical_operation_id") == r.get("operation_id")
            && previous.get("logical_operation_id") == r.get("operation_id")
            && r["origin"] == "gui"
            && previous["origin"] == "gui"
            && previous["kind"] == "start"
            && previous.get("chat_id") == session.get("chatId")
            && truthy(previous.get("execution_lane_id"))
            && r.get("execution_lane_id") == previous.get("execution_lane_id")
    }) else {
        return reject("invalid-continuation-lineage");
    };
    if !context::same_placement(current.as_ref(), &input["workerId"], Some(session))?
        || !context::same_runtime_route(current.as_ref(), Some(session))?
    {
        return reject("stale-session");
    }
    let context = current.as_ref().unwrap();
    if !truthy(active.get("active"))
        || truthy(active.get("logical_cancelled"))
        || active.get("operation_id") != previous.get("operation_id")
        || active.get("generation") != previous.get("activation_generation")
        || active.get("execution_lane_id") != context.get("executionLaneId")
        || truthy(context.get("automationPaused"))
        || !matches!(
            context["status"].as_str(),
            Some("running" | "waiting-for-approval")
        )
    {
        return reject("stale-continuation");
    }
    let profile = wire::property(previous.get("intent"), "permissionProfileId")?;
    if truthy(profile) && profile != managed_console::permission_profile(context).get("effectiveId")
    {
        return reject("permission-profile-mismatch");
    }
    let prior = previous.get("identity");
    let failure = &input["failure"];
    for field in ["threadId", "runtimeGeneration", "connectionId"] {
        if !truthy(session.get(field)) {
            return reject("stale-session");
        }
    }
    for field in [
        "placementId",
        "projectId",
        "contextKind",
        "modelRouteId",
        "providerAccountId",
    ] {
        if wire::property(prior, field)? != session.get(field) {
            return reject("stale-session");
        }
    }
    for field in ["runtimeGeneration", "connectionId"] {
        let old = wire::property(prior, field)?;
        if old != Some(&Value::Null) && old != session.get(field) {
            return reject("stale-session");
        }
    }
    if failure.get("runtimeGeneration") != session.get("runtimeGeneration") {
        return reject("stale-session");
    }
    let handoff = input.get("handoff").filter(|h| truthy(Some(h)));
    if let Some(handoff) = handoff {
        if input["reason"] != "invalid-compaction"
            || wire::property(prior, "threadId")? != handoff.get("expectedThreadId")
            || context.get("threadId") != handoff.get("expectedThreadId")
            || session.get("threadId") != handoff.get("replacementThreadId")
            || handoff.get("expectedThreadId") == handoff.get("replacementThreadId")
        {
            return reject("thread-identity-mismatch");
        }
    } else if wire::property(prior, "threadId")? != session.get("threadId")
        || context.get("threadId") != session.get("threadId")
    {
        return reject("thread-identity-mismatch");
    }
    let terminal = failure["kind"] == "native-terminal";
    if terminal {
        if !matches!(
            previous["status"].as_str(),
            Some("dispatched" | "applied" | "uncertain")
        ) || (active.get("native_turn_id") != Some(&Value::Null)
            && active.get("native_turn_id") != failure.get("nativeTurnId"))
        {
            return reject("stale-native-evidence");
        }
    } else if (failure["method"] == "turn/start"
        && !matches!(
            previous["status"].as_str(),
            Some("dispatched" | "uncertain")
        ))
        || (failure["method"] == "thread/resume"
            && (input["reason"] != "invalid-compaction" || previous["status"] != "accepted"))
        || active.get("native_turn_id") != Some(&Value::Null)
    {
        return reject("stale-native-evidence");
    }
    let now = crate::auth::now();
    if terminal {
        turns::remember(tx, &previous, failure).await?;
    }
    let mut evidence = json!({"retryReason":input["reason"]});
    for (key, value) in failure.as_object().context("Native continuation failure")? {
        evidence[key.lossy().as_ref()] = value.clone();
    }
    tx.query("UPDATE native_commands SET status=$1,rejection_code=$2,execution_completed_at=$3,terminal_evidence=$4::text::jsonb,updated_at=$3 WHERE operation_id=$5",&[&if terminal{"applied"}else{"rejected"},&if terminal{None}else{Some("native-request-rejected")},&now,&evidence.stringify(),&text(&previous["operation_id"])?]).await?;
    if let Some(handoff) = handoff {
        let lane=raw_one(tx,"SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE id=$1 AND chat_id=$2 FOR UPDATE",&[&text(&previous["execution_lane_id"])?,&previous_chat]).await?;
        let Some(lane) = lane.filter(|l| truthy(l.get("runtime_session_id"))) else {
            return reject("thread-handoff-failed");
        };
        let replacement = text(&handoff["replacementThreadId"])?;
        let expected = text(&handoff["expectedThreadId"])?;
        let changed=tx.query("UPDATE chat_runtime_sessions SET codex_thread_id=$1,status='running',updated_at=$2 WHERE id=$3 AND codex_thread_id=$4 RETURNING id",&[&replacement,&now,&text(&lane["runtime_session_id"])?,&expected]).await?;
        let changed_lane=tx.query("UPDATE chat_execution_lanes SET codex_thread_id=$1,updated_at=$2 WHERE id=$3 AND codex_thread_id=$4 RETURNING id",&[&replacement,&now,&text(&lane["id"])?,&expected]).await?;
        if changed.len() != 1 || changed_lane.len() != 1 {
            return reject("thread-handoff-failed");
        }
        current = context::execution(tx, owner, &previous_chat).await?;
        if current.as_ref().and_then(|c| c.get("threadId")) != handoff.get("replacementThreadId") {
            return reject("thread-handoff-failed");
        }
    }
    let generation = uuid::Uuid::new_v4().to_string();
    let activation_generation = uuid::Uuid::new_v4().to_string();
    let mut intent =
        json!({"scope":"thread","settingKeys":Vec::<Value>::new(),"expectedTurnId":Value::Null});
    if let Some(profile) = profile.filter(|p| truthy(Some(p))) {
        intent["permissionProfileId"] = profile.clone();
    }
    intent["continuation"] = json!({"reason":input["reason"],"failure":failure,"handoff":handoff.cloned().unwrap_or(Value::Null)});
    let inserted=raw_one(tx,"INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,logical_operation_id,logical_client_message_id,previous_operation_id,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'gui','turn/start','start',$11,$12::text::jsonb,$13::text::jsonb,$14::text::jsonb,'accepted') RETURNING to_jsonb(native_commands)::text",&[&text(&input["operationId"])?,&owner,&worker,&previous_chat,&generation,&text(&root["operation_id"])?,&optional(&root["logical_client_message_id"])?,&text(&previous["operation_id"])?,&activation_generation,&text(&previous["execution_lane_id"])?,&text(&input["payloadDigest"])?,&input["protectedPayload"].stringify(),&session.stringify(),&intent.stringify()]).await?.context("Database returned no row after recording GUI continuation.")?;
    tx.query("UPDATE native_command_activations SET generation=$1,operation_id=$2,runtime_generation=$3,native_turn_id=NULL,logical_cancelled=false,active=true,created_at=$4 WHERE chat_id=$5",&[&activation_generation,&text(&input["operationId"])?,&text(&session["runtimeGeneration"])?,&now,&previous_chat]).await?;
    Ok(json!({"receipt":receipt::from_row(&inserted)?,"execution":current.unwrap_or(Value::Null)}))
}
