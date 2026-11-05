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
    let mut authority = json!({
        "ownerId":owner,"serverId":server,"workerId":context["workerId"],
        "chatId":context["chatId"],"projectId":context["projectId"],
        "contextKind":context["contextKind"],
        "placementId":if context["contextKind"]=="project" {&context["worktreeId"]}else{&context["scratchRootId"]},
        "generation":context["computerUseAuthorityGeneration"],
        "cantripAppAllowed":context["computerUseCantripAppAllowed"]==true,
        "profile":json!({"selectedId":profile["selectedId"],"effectiveId":profile["effectiveId"],"forcedByWorktreePolicy":profile["forcedByWorktreePolicy"],"usesDefault":profile["usesDefault"]})
    });
    if context
        .get("osExecution")
        .is_some_and(|value| !value.is_null())
    {
        let scope = &context["osExecution"]["scope"];
        let mut placement = Value::object(std::iter::empty::<(&str, Value)>());
        for key in [
            "instanceId",
            "guestInstanceId",
            "attachmentGeneration",
            "runtimeGeneration",
            "bindingId",
            "bindingGeneration",
            "projectSourceId",
            "worktreeId",
            "workspaceId",
            "guestWorkspaceId",
        ] {
            placement[key] = scope[key].clone();
        }
        authority["osPlacement"] = placement;
    }
    crate::settings::parse_response("cuaPreviewAuthoritySchema", Some(&authority))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_owned_os_identity_without_transport_or_host_permission() -> Result<()> {
        let mut scope = json!({"guestWorkspaceId":"work","guestPath":"/PRIVATE/checkout","homeGuestPath":"/PRIVATE/home"});
        for key in [
            "instanceId",
            "guestInstanceId",
            "attachmentGeneration",
            "runtimeGeneration",
            "bindingId",
            "bindingGeneration",
            "projectSourceId",
            "worktreeId",
            "workspaceId",
        ] {
            scope[key] = Value::String(uuid::Uuid::new_v4().to_string().into());
        }
        let mut context = json!({"computerUseEnabled":true,"computerUseAuthorityGeneration":1,
            "workerId":"worker","chatId":"chat","projectId":"project","contextKind":"project",
            "worktreeId":scope["worktreeId"],"permissionProfileId":":yolo","defaultPermissionProfileId":":workspace",
            "osExecution":json!({"scope":scope,"transport":json!({"identityFile":"/PRIVATE/key"})})});
        let actual = preview("owner", "server", &context)?;
        assert_eq!(
            actual["osPlacement"]["runtimeGeneration"],
            scope["runtimeGeneration"]
        );
        assert_eq!(actual["cantripAppAllowed"], false);
        assert!(!actual.stringify().contains("PRIVATE"));
        context["osExecution"] = Value::Null;
        assert!(
            preview("owner", "server", &context)?
                .get("osPlacement")
                .is_none()
        );
        Ok(())
    }
}
