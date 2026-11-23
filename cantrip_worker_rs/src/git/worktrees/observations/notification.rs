use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};

pub fn touches_files(filename: Option<&JsString>) -> bool {
    let Some(filename) = filename else {
        return true;
    };
    let normalized: Vec<_> = filename
        .units()
        .iter()
        .map(|&u| if u == 92 { 47 } else { u })
        .collect();
    normalized != [46, 103, 105, 116] && !normalized.starts_with(&[46, 103, 105, 116, 47])
}
pub fn operation(target: &Value, state: &Value, conflicts: &Value, observed_at: &str) -> Value {
    let compact = json!({"state":state["state"],"currentHead":state["currentHead"],
        "currentStep":state["currentStep"],"totalSteps":state["totalSteps"],
        "pendingCommitCount":state["pendingCommits"].as_array().unwrap().len(),
        "conflictedPathCount":state["conflictedPaths"].as_array().unwrap().len(),
        "pausedAction":state.get("pausedAction").unwrap_or(&Value::Null)});
    let original = conflicts["files"].as_array().unwrap();
    let mut files = Vec::new();
    let mut bytes = 2;
    for file in original {
        let size = file.stringify().len() + 1;
        if files.len() >= 2_000 || bytes + size > 256 * 1_024 {
            break;
        }
        files.push(file.clone());
        bytes += size;
    }
    let truncated = conflicts["truncated"] == true || files.len() < original.len();
    let conflicts = json!({"files":files,"truncated":truncated});
    let fingerprint = Sha256::digest(
        json!({"operationId":target["operation"]["id"],"state":compact,"conflicts":conflicts})
            .stringify()
            .as_bytes(),
    )
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>();
    json!({"type":"git.operation.observed","projectId":target["projectId"],"worktreeId":target["worktreeId"],
        "operationId":target["operation"]["id"],"sourcePath":target["sourcePath"],"worktreePath":target["worktreePath"],
        "fingerprint":fingerprint,"observedAt":observed_at,"state":compact,"conflicts":conflicts})
}
pub fn filesystem(target: &Value, changes: Vec<Value>) -> Value {
    let mut fields = target.as_object().unwrap().clone();
    fields.shift_remove("operation");
    let mut result = Value::Object(fields);
    result["type"] = json!("worktree.filesystem.changed");
    result["changes"] = json!(changes);
    result
}
/// Individual filenames are delivered only through the encrypted observation
/// adapter. The authenticated server control socket receives an invalidation.
pub fn for_server(notification: &Value) -> Value {
    if notification["type"] != "worktree.filesystem.changed" {
        return notification.clone();
    }
    let mut fields = notification.as_object().unwrap().clone();
    fields.shift_remove("changes");
    Value::Object(fields)
}
