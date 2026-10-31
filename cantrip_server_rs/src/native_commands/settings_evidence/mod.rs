//! Immutable worker facts describe application; they never grant another mutation.
mod permission;
use super::{
    CommandError, Repository,
    admit::{optional, raw_one, text},
    context, settings_persistence,
};
use crate::{
    database::{Executor, Transaction},
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::Result;

fn reject<T>(code: &str, message: &str) -> Result<T> {
    Err(CommandError::new(code, Some(message), 409).into())
}
async fn record(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let operation = text(&input["operationId"])?;
    let generation = text(&input["operationGeneration"])?;
    let worker = text(&input["workerId"])?;
    let located = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &operation,
        &generation,
    )
    .await?;
    let chat = text(&located["chat_id"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let command=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND worker_id=$4 FOR UPDATE",&[&operation,&generation,&owner,&worker]).await?.ok_or_else(||CommandError::new("operation-not-found",Some("Operation not found."),404))?;
    let identity = &command["identity"];
    let intent = settings_persistence::parse("nativeCommandIntentSchema", &command["intent"])?;
    if (truthy(input.get("recoveryBindingId")) && !truthy(intent.get("permissionTransition")))
        || command["method"] != "thread/settings/update"
        || intent.get("nativeSettingsOperationId") != input.get("nativeOperationId")
        || wire::property(Some(identity), "threadId")? != input.get("threadId")
        || wire::property(Some(identity), "runtimeGeneration")? != input.get("runtimeGeneration")
        || command["settings_application"].get("nativeOperationId")
            != input.get("nativeOperationId")
    {
        return reject(
            "native-settings-evidence-scope",
            "Settings evidence does not match a dispatched command.",
        );
    }
    let saved = json!({"event_id":input["eventId"],"operation_id":input["operationId"],"operation_generation":input["operationGeneration"],"kind":input["kind"],"submission_id":input["submissionId"],"result_digest":input["resultDigest"],"protected_result":input["protectedResult"],"permission_policy":input.get("permissionPolicy").cloned().unwrap_or(Value::Null),"recovery_binding_id":input.get("recoveryBindingId").cloned().unwrap_or(Value::Null)});
    let event = text(&saved["event_id"])?;
    let kind = text(&saved["kind"])?;
    let submission = optional(&saved["submission_id"])?;
    let digest = text(&saved["result_digest"])?;
    let result = saved["protected_result"].stringify();
    let policy =
        (!saved["permission_policy"].is_null()).then(|| saved["permission_policy"].stringify());
    let recovery = optional(&saved["recovery_binding_id"])?;
    let inserted=tx.query("INSERT INTO native_settings_evidence(event_id,operation_id,operation_generation,kind,submission_id,result_digest,protected_result,permission_policy,recovery_binding_id) VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9) ON CONFLICT DO NOTHING RETURNING event_id",&[&event,&operation,&generation,&kind,&submission,&digest,&result,&policy,&recovery]).await?;
    if inserted.is_empty() {
        let existing = raw_one(
            tx,
            "SELECT to_jsonb(e)::text FROM native_settings_evidence e WHERE event_id=$1",
            &[&event],
        )
        .await?
        .map(|mut value| {
            if let Value::Object(fields) = &mut value {
                fields.retain(|key, _| key.as_str() != Some("created_at"));
            }
            value
        });
        if existing.as_ref() != Some(&saved) {
            return reject(
                "native-settings-evidence-conflict",
                "Settings evidence identity was reused with different content.",
            );
        }
    }
    let rows = tx
        .query(
            "SELECT to_jsonb(e)::text FROM native_settings_evidence e WHERE operation_id=$1",
            &[&operation],
        )
        .await?;
    let facts = rows
        .iter()
        .map(|row| Ok(serde_json::from_str::<Value>(&row.get::<String>(0)?)?))
        .collect::<Result<Vec<_>>>()?;
    let mut submissions = Vec::<Value>::new();
    for fact in &facts {
        if truthy(fact.get("submission_id")) && !submissions.contains(&fact["submission_id"]) {
            submissions.push(fact["submission_id"].clone());
        }
    }
    let applied = facts.iter().any(|f| f["kind"] == "applied");
    let rejected = facts.iter().any(|f| f["kind"] == "rejected");
    let claims = facts
        .iter()
        .filter_map(|f| f.get("permission_policy").filter(|v| truthy(Some(v))))
        .collect::<Vec<_>>();
    let original = facts
        .iter()
        .filter(|f| !truthy(f.get("recovery_binding_id")))
        .filter_map(|f| f.get("permission_policy").filter(|v| truthy(Some(v))))
        .collect::<Vec<_>>();
    let permission_conflict = truthy(intent.get("permissionTransition"))
        && applied
        && (claims.is_empty()
            || claims.iter().any(|c| {
                c.get("effectiveId") != intent["permissionTransition"].get("effectiveId")
            })
            || original
                .iter()
                .any(|c| Some(*c) != original.first().copied()));
    let conflict = permission_conflict
        || submissions.len() > 1
        || (applied && rejected)
        || facts.iter().any(|f| f["kind"] == "correlation-conflict");
    let status = if conflict {
        "uncertain"
    } else if applied {
        "applied"
    } else if rejected {
        "rejected"
    } else if facts.iter().any(|f| f["kind"] == "transport-lost") {
        "uncertain"
    } else {
        "pending"
    };
    let application = json!({"nativeOperationId":input["nativeOperationId"],"submissionId":if submissions.len()==1{submissions[0].clone()}else{Value::Null},"evidenceCount":facts.len(),"status":status});
    let encoded = application.stringify();
    let now = crate::auth::now();
    tx.query("UPDATE native_commands SET settings_application=$1::text::jsonb,updated_at=$2 WHERE operation_id=$3",&[&encoded,&now,&operation]).await?;
    settings_persistence::settle_state(
        tx,
        &command,
        if status == "pending" {
            "dispatched"
        } else {
            status
        },
    )
    .await?;
    let claim = if truthy(input.get("recoveryBindingId")) {
        input.get("permissionPolicy")
    } else {
        original.first().copied()
    };
    let published = if status == "applied"
        && truthy(intent.get("permissionTransition"))
        && claim.is_some_and(|c| truthy(Some(c)))
    {
        permission::publish(tx, owner, &command, &intent, input, claim.unwrap()).await?
    } else {
        false
    };
    Ok(
        json!({"operationId":input["operationId"],"operationGeneration":input["operationGeneration"],"eventId":input["eventId"],"application":application,"permissionPolicyPublished":published}),
    )
}
impl Repository {
    pub async fn record_settings_evidence(&self, owner: &str, value: &Value) -> Result<Value> {
        let input = settings_persistence::parse("nativeSettingsEvidenceSchema", value)?;
        let owner = owner.to_owned();
        self.database
            .transaction(|tx| Box::pin(async move { record(tx, &owner, &input).await }))
            .await
    }
}
