use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::{Context, Result};

pub(crate) fn native_command(control: &Value, queued: &Value, attachments: Value) -> Value {
    let context = &control["context"];
    json!({
        "type": "chat.native-control",
        "chatId": context["chatId"],
        "threadId": context["threadId"],
        "nativeActivationGeneration": control["activationGeneration"],
        "nativeRuntimeGeneration": control["runtimeGeneration"],
        "modelRouteId": context["modelRouteId"],
        "providerAccountId": context["providerAccountId"],
        "control": json!({
            "kind": "steer", "protectedPrompt": queued["pendingMessage"], "attachments": attachments,
        }),
    })
}

pub(crate) fn bind_claim(
    command: &mut Value,
    queued: &Value,
    claim: &Value,
    operation: &Value,
) -> Result<()> {
    let client = match queued
        .get("nativeClientUserMessageId")
        .filter(|v| !v.is_null())
    {
        Some(value) => value.clone(),
        None => {
            let id = queued["pendingMessage"]["id"]
                .as_str()
                .context("Queued message identity")?;
            json!(format!("cantrip:{id}"))
        }
    };
    command["operationId"] = operation.clone();
    command["queueClaim"] = json!({"id": claim["id"], "promptRevision": claim["promptRevision"]});
    command["nativeClientUserMessageId"] = client;
    if command["type"] == "chat.native-control" {
        if let Some(input) = queued.get("protectedNativeInput") {
            command["protectedNativeInput"] = input.clone();
        }
        command["queuedPromptId"] = queued["id"].clone();
    }
    Ok(())
}

pub(crate) fn attribution(context: &Value) -> Option<Value> {
    truthy(context.get("executionLaneId")).then(|| {
        let standalone = context["contextKind"] == "standalone";
        json!({
            "contextKind": if standalone { "standalone" } else { "project" },
            "executionLaneId": context["executionLaneId"],
            "worktreeId": if standalone { Value::Null } else { context["worktreeId"].clone() },
            "scratchRootId": if standalone { context["scratchRootId"].clone() } else { Value::Null },
        })
    })
}
