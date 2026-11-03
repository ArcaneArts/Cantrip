//! Shared Source authority projection for native turns and public approvals.
use super::managed_console;
use crate::wire::{Value, value::json};
use anyhow::Result;

pub(crate) fn preview(owner: &str, server: &str, context: &Value) -> Result<Value> {
    anyhow::ensure!(
        context["computerUseEnabled"] == true,
        "Computer use is not enabled."
    );
    let profile = managed_console::permission_profile(context);
    crate::settings::parse_response(
        "cuaPreviewAuthoritySchema",
        Some(&json!({
            "ownerId":owner,"serverId":server,"workerId":context["workerId"],
            "chatId":context["chatId"],"projectId":context["projectId"],
            "contextKind":context["contextKind"],
            "placementId":if context["contextKind"]=="project" {&context["worktreeId"]}else{&context["scratchRootId"]},
            "generation":context["computerUseAuthorityGeneration"],
            "cantripAppAllowed":context["computerUseCantripAppAllowed"]==true,
            "profile":json!({"selectedId":profile["selectedId"],"effectiveId":profile["effectiveId"],"forcedByWorktreePolicy":profile["forcedByWorktreePolicy"],"usesDefault":profile["usesDefault"]})
        })),
    )
}
