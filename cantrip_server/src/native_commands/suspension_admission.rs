//! Replace a suspended physical observer while retaining native input provenance.
//! This transaction grants no native progress: explicit Resume remains separate.
use super::{
    Repository,
    admit::{optional, raw_one, reject, text},
    context, receipt, suspension, turns,
};
use crate::{
    chats::{
        guard::{self, Access},
        managed_console,
    },
    database::Transaction,
    settings::parse_response,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;

fn operation(row: &Value) -> Value {
    json!({"operationId":row["operation_id"],"operationGeneration":row["operation_generation"]})
}
fn response(
    row: &Value,
    context: &Value,
    state: &Value,
    source: &Value,
    logical: &Value,
    replayed: bool,
) -> Result<Value> {
    Ok(
        json!({"receipt":receipt::from_row(row)?,"execution":context,"suspension":state,
        "source":operation(source),"logicalRoot":if logical.is_null(){Value::Null}else{operation(logical)},"replayed":replayed}),
    )
}
async fn admit(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let action = input["action"].as_str().unwrap_or("resume");
    let phase = if action == "stop" {
        "stopping"
    } else {
        "resuming"
    };
    let id = text(&input["session"]["chatId"])?;
    let worker = text(&input["workerId"])?;
    let session = &input["session"];
    context::lock_chat(tx, owner, &id).await?;
    let chat = suspension::chat(tx, owner, &id).await?;
    let Some(mut state) = suspension::read(&chat)? else {
        return reject("suspension-control-stale");
    };
    if state["controlId"] != input["controlId"]
        || state["action"] != action
        || state["phase"] != phase
        || state["checkpoint"].is_null()
        || state["active"].is_null()
        || state["checkpoint"] != input["checkpoint"]
    {
        return reject("suspension-control-stale");
    }
    let context = context::execution(tx, owner, &id)
        .await?
        .unwrap_or(Value::Null);
    if !context::same_placement(Some(&context), &input["workerId"], Some(session))?
        || !context::same_runtime_route(Some(&context), Some(session))?
        || !suspension::same_source(&state, &chat, &context)
        || !truthy(session.get("runtimeGeneration"))
        || !truthy(session.get("connectionId"))
        || session["threadId"] != state["active"]["threadId"]
    {
        return reject("suspension-authority-changed");
    }
    let runtime = text(&session["runtimeGeneration"])?;
    guard::assert_runtime_writable(tx, &id, Some(&runtime), None, Access::Write).await?;
    let activation = raw_one(
        tx,
        "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
        &[&id],
    )
    .await?
    .unwrap_or(Value::Null);
    let expected_head = if state["executionOwner"].is_null() {
        &state["target"]["originalOperationId"]
    } else {
        &state["executionOwner"]["operationId"]
    };
    if !truthy(activation.get("active"))
        || (truthy(activation.get("logical_cancelled")) && action != "stop")
        || activation["worker_id"] != input["workerId"]
        || activation["operation_id"] != *expected_head
        || activation["execution_lane_id"] != context["executionLaneId"]
        || context["executionLaneId"] != state["target"]["executionLaneId"]
    {
        return reject("suspension-execution-replaced");
    }
    let source = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&state["target"]["originalOperationId"])?],
    )
    .await?
    .unwrap_or(Value::Null);
    let head = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&text(&activation["operation_id"])?],
    )
    .await?
    .unwrap_or(Value::Null);
    if source.is_null()
        || head.is_null()
        || source["owner_id"] != owner
        || head["owner_id"] != owner
        || source["worker_id"] != worker
        || head["worker_id"] != worker
        || source["chat_id"] != id
        || head["chat_id"] != id
        || source["kind"] != "start"
        || head["activation_generation"] != activation["generation"]
        || source["execution_lane_id"] != context["executionLaneId"]
        || head["execution_lane_id"] != context["executionLaneId"]
    {
        return reject("suspension-execution-replaced");
    }
    let original = parse_response("nativeCommandSessionSchema", Some(&source["identity"]))?;
    if suspension::retained_execution(tx, owner, &head)
        .await?
        .is_none()
    {
        return reject("suspension-not-held");
    }
    if original["threadId"] != state["active"]["threadId"]
        || !truthy(original.get("runtimeGeneration"))
    {
        return reject("suspension-source-mismatch");
    }
    let logical = if truthy(source.get("logical_operation_id")) {
        raw_one(
            tx,
            "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
            &[&text(&source["logical_operation_id"])?],
        )
        .await?
        .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if truthy(source.get("logical_operation_id"))
        && (logical.is_null()
            || logical["owner_id"] != owner
            || logical["worker_id"] != worker
            || logical["chat_id"] != id
            || logical["logical_operation_id"] != logical["operation_id"]
            || truthy(logical.get("logical_completed_at"))
            || head["logical_operation_id"] != logical["operation_id"])
    {
        return reject("suspension-logical-input-ended");
    }
    let operation_id = text(&input["operationId"])?;
    let existing = raw_one(
        tx,
        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
        &[&operation_id],
    )
    .await?;
    if existing
        .as_ref()
        .is_some_and(|row| row["operation_id"] != head["operation_id"])
    {
        return reject("operation-id-conflict");
    }
    let intent = parse_response("nativeCommandIntentSchema", Some(&head["intent"]))?;
    // An explicit retry has a new control and activation, even when the failed
    // observer's worker/runtime survives. In-flight duplicates keep one control.
    let replaces_control = intent["restoredSuspension"]["controlId"] != input["controlId"];
    if state["executionOwner"]["workerGeneration"] == input["workerGeneration"]
        && state["executionOwner"]["runtimeGeneration"] == session["runtimeGeneration"]
        && !replaces_control
    {
        if head["operation_generation"] != state["executionOwner"]["operationGeneration"]
            || head["identity"] != *session
            || head["payload_digest"] != input["payloadDigest"]
            || intent["restoredSuspension"]["controlId"] != input["controlId"]
            || intent["restoredSuspension"]["action"]
                .as_str()
                .unwrap_or("resume")
                != action
            || intent["restoredSuspension"]["checkpoint"] != input["checkpoint"]["suspension"]
            || truthy(head.get("execution_completed_at"))
        {
            return reject("suspension-observer-conflict");
        }
        return response(&head, &context, &state, &source, &logical, true);
    }
    if existing.is_some() {
        return reject("operation-id-conflict");
    }
    turns::remember(tx, &source, &json!({"nativeTurnId":state["active"]["turnId"],"runtimeGeneration":original["runtimeGeneration"]})).await?;
    let generation = uuid::Uuid::new_v4().to_string();
    let activation_generation = uuid::Uuid::new_v4().to_string();
    let origin = text(&source["origin"])?;
    let logical_id = optional(&logical["operation_id"])?;
    let previous_id = text(&head["operation_id"])?;
    let lane = text(&context["executionLaneId"])?;
    let digest = text(&input["payloadDigest"])?;
    let payload = input["protectedPayload"].stringify();
    let identity = session.stringify();
    let mut intent = json!({"scope":"thread","settingKeys":Vec::<String>::new(),"expectedTurnId":state["active"]["turnId"],
        "permissionProfileId":managed_console::permission_profile(&context)["effectiveId"],
        "restoredSuspension":json!({"controlId":input["controlId"],"checkpoint":input["checkpoint"]["suspension"],"source":operation(&source)})});
    if action == "stop" {
        intent["restoredSuspension"]["action"] = json!(action);
    }
    let intent = intent.stringify();
    let row = raw_one(tx, "INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,logical_operation_id,previous_operation_id,activation_generation,execution_lane_id,origin,method,kind,payload_digest,protected_payload,identity,intent,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'thread/resume','start',$11,$12::text::jsonb,$13::text::jsonb,$14::text::jsonb,'accepted') RETURNING to_jsonb(native_commands)::text", &[&operation_id,&owner,&worker,&id,&generation,&logical_id,&previous_id,&activation_generation,&lane,&origin,&digest,&payload,&identity,&intent]).await?.ok_or_else(|| anyhow::anyhow!("Database returned no suspended observer"))?;
    let now = crate::auth::now();
    tx.query("UPDATE native_commands SET execution_completed_at=COALESCE(execution_completed_at,$1),terminal_evidence=COALESCE(terminal_evidence,'{\"kind\":\"suspension-owner-replaced\"}'::jsonb),updated_at=$1 WHERE operation_id=$2", &[&now,&previous_id]).await?;
    let turn = text(&state["active"]["turnId"])?;
    tx.query("UPDATE native_command_activations SET operation_id=$1,generation=$2,runtime_generation=$3,native_turn_id=$4 WHERE chat_id=$5", &[&operation_id,&activation_generation,&runtime,&turn,&id]).await?;
    let actor = json!({"workerGeneration":input["workerGeneration"],"runtimeGeneration":runtime,"operationId":operation_id,"operationGeneration":generation});
    state["actor"] = actor.clone();
    state["executionOwner"] = actor;
    state["actorControlId"] = state["controlId"].clone();
    suspension::save(tx, owner, &id, state, true).await?;
    let state = suspension::read(&suspension::chat(tx, owner, &id).await?)?.unwrap();
    response(&row, &context, &state, &source, &logical, false)
}
pub(super) async fn assert_dispatch(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
    input: &Value,
) -> Result<()> {
    let restore = &row["intent"]["restoredSuspension"];
    if restore.is_null() {
        return Ok(());
    }
    let action = restore["action"].as_str().unwrap_or("resume");
    let phase = if action == "stop" {
        "stopping"
    } else {
        "resuming"
    };
    let state = suspension::read(&suspension::chat(tx, owner, &text(&row["chat_id"])?).await?)?
        .unwrap_or(Value::Null);
    if state["phase"] != phase
        || state["action"] != action
        || state["controlId"] != restore["controlId"]
        || state["checkpoint"]["suspension"] != restore["checkpoint"]
        || state["executionOwner"]["operationId"] != row["operation_id"]
        || state["executionOwner"]["operationGeneration"] != row["operation_generation"]
        || state["executionOwner"]["workerGeneration"] != input["workerGeneration"]
        || state["executionOwner"]["runtimeGeneration"] != input["session"]["runtimeGeneration"]
    {
        return reject("suspension-control-stale");
    }
    Ok(())
}
impl Repository {
    pub async fn admit_suspended_execution(&self, owner: &str, input: &Value) -> Result<Value> {
        let owner = owner.to_owned();
        let input = parse_response("nativeSuspensionExecutionAdmissionSchema", Some(input))?;
        self.database
            .transaction(|tx| Box::pin(async move { admit(tx, &owner, &input).await }))
            .await
    }
}
