use super::super::{
    admit::{optional, text},
    context, settings_persistence,
};
use crate::{
    database::{Executor, Transaction},
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use num_bigint::BigInt;
fn increment(value: Option<&Value>) -> Result<Value> {
    let n = value
        .filter(|v| !v.is_null())
        .map(|v| v.as_str().context("Permission revision"))
        .transpose()?
        .unwrap_or("0")
        .parse::<BigInt>()?;
    Ok(json!((n + BigInt::from(1)).to_string()))
}
pub(super) async fn publish(
    tx: &Transaction<'_>,
    owner: &str,
    command: &Value,
    intent: &Value,
    input: &Value,
    claim: &Value,
) -> Result<bool> {
    let chat = text(&command["chat_id"])?;
    let context = context::execution(tx, owner, &chat).await?;
    let current = settings_persistence::get(Executor::Transaction(tx), owner, &chat)
        .await?
        .unwrap_or(Value::Null);
    let identity = &command["identity"];
    let transition = &intent["permissionTransition"];
    let previous = &current["permissionPolicy"];
    let binding = &current["binding"];
    let recovery = truthy(input.get("recoveryBindingId"));
    if recovery
        && (!truthy(Some(binding))
            || input.get("recoveryBindingId") != binding.get("bindingId")
            || binding.get("nativeEpoch") != claim["settingsVersion"].get("epoch")
            || binding.get("workerId") != command.get("worker_id")
            || [
                "threadId",
                "contextKind",
                "projectId",
                "placementId",
                "modelRouteId",
                "providerAccountId",
            ]
            .iter()
            .any(|field| binding.get(field) != identity.get(field)))
    {
        return super::reject(
            "native-permission-recovery-binding",
            "Permission recovery does not match the current native source.",
        );
    }
    let effective = if recovery {
        binding.get("runtimeGeneration")
    } else {
        wire::property(Some(identity), "runtimeGeneration")?
    };
    let current_source = if let Some(context) = &context {
        context.get("workerId") == command.get("worker_id")
            && [
                "threadId",
                "projectId",
                "contextKind",
                "modelRouteId",
                "providerAccountId",
            ]
            .iter()
            .all(|field| context.get(field) == identity.get(field))
            && context
                .get("worktreeId")
                .filter(|v| !v.is_null())
                .or(context.get("scratchRootId"))
                == identity.get("placementId")
            && truthy(Some(binding))
            && binding.get("threadId") == identity.get("threadId")
            && binding.get("runtimeGeneration") == effective
            && binding.get("nativeEpoch") == claim["settingsVersion"].get("epoch")
    } else {
        false
    };
    let policy_revision = previous
        .get("revision")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("0"));
    let current_policy = transition.get("expectedRevision") == Some(&policy_revision);
    let same_operation = previous.get("operationId") == command.get("operation_id")
        && previous.get("operationGeneration") == command.get("operation_generation");
    let newer = !truthy(Some(previous))
        || previous["settingsVersion"].get("epoch") != claim["settingsVersion"].get("epoch")
        || claim["settingsVersion"]["revision"]
            .as_str()
            .context("Native permission revision")?
            .parse::<BigInt>()?
            >= previous["settingsVersion"]["revision"]
                .as_str()
                .context("Confirmed permission revision")?
                .parse::<BigInt>()?;
    let permitted = !context.as_ref().is_some_and(|c| {
        truthy(c.get("isPrimary")) && c["worktreePolicy"] == "required-for-writes"
    }) || transition["effectiveId"] == ":read-only";
    let published = current_source
        && same_operation
        && truthy(Some(previous))
        && previous["source"].get("runtimeGeneration") == effective
        && previous.get("settingsVersion") == claim.get("settingsVersion");
    if current_source && (current_policy || same_operation) && !published && newer && permitted {
        let revision = if same_operation {
            previous["revision"].clone()
        } else {
            increment(previous.get("revision"))?
        };
        let mut source = json!({"workerId":command["worker_id"],"threadId":identity["threadId"]});
        if let Some(effective) = effective {
            source["runtimeGeneration"] = effective.clone();
        }
        for field in [
            "contextKind",
            "projectId",
            "placementId",
            "modelRouteId",
            "providerAccountId",
        ] {
            if let Some(value) = identity.get(field) {
                source[field] = value.clone();
            }
        }
        let policy = json!({"selectedId":transition["selectedId"],"resolvedSelectedId":transition["resolvedSelectedId"],"effectiveId":transition["effectiveId"],"revision":revision,"operationId":command["operation_id"],"operationGeneration":command["operation_generation"],"source":source,"settingsVersion":claim["settingsVersion"]});
        settings_persistence::change(tx, &chat, |state| {
            let mut next = state.clone();
            next["revision"] = increment(state.get("revision"))?;
            next["permissionPolicy"] = policy;
            Ok(next)
        })
        .await?;
        let selected = optional(&transition["selectedId"])?;
        let now = crate::auth::now();
        tx.query(
            "UPDATE chats SET permission_profile_id=$1,updated_at=$2 WHERE id=$3",
            &[&selected, &now, &chat],
        )
        .await?;
        return Ok(true);
    }
    Ok(published)
}
