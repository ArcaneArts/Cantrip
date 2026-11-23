use super::*;
use native_commands::settings_persistence::SettingsRepository as NativeSettings;

fn configured_profiles() -> Value {
    Value::Array(
        [
            (":read-only", "Inspection only"),
            (":workspace", "Workspace writes"),
            (
                ":danger-full-access",
                "Unrestricted access with approval prompts",
            ),
            (":yolo", "Unrestricted access without approval prompts"),
        ]
        .into_iter()
        .map(|(id, description)| json!({"id":id,"description":description,"allowed":true}))
        .collect(),
    )
}
fn unavailable(mut selection: Value, reason: JsString) -> Result<Value> {
    selection["available"] = json!(false);
    selection["profiles"] = configured_profiles();
    selection["reason"] = Value::String(reason);
    crate::settings::parse_response("chatPermissionProfileStateSchema", Some(&selection))
}
async fn state(service: &Arc<AuthService>, owner: &str, context: &Value) -> Result<Value> {
    let native = NativeSettings::new(service.repository.database.clone())
        .get(owner, &text(&context["chatId"])?)
        .await?
        .unwrap_or(Value::Null);
    let pending = native["pending"].as_array().and_then(|entries| {
        entries
            .iter()
            .rev()
            .find(|entry| truthy(entry["intent"].get("permissionTransition")))
    });
    // Source chooses between object references. Select the status by that
    // same branch, even if the two intent objects happen to compare equal.
    let desired = if truthy(native["desired"].get("permissionTransition")) {
        Some((&native["desired"], native.get("desiredStatus")))
    } else {
        pending.map(|p| (&p["intent"], p.get("status")))
    };
    let mut selection = chats::managed_console::permission_profile(context);
    selection["policyRevision"] = native["permissionPolicy"]
        .get("revision")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("0"));
    selection["confirmed"] = json!(context["nativePermissionPolicyConfirmed"] == true);
    selection["transition"] = if let Some((desired, Some(status))) = desired
        && truthy(Some(status))
        && truthy(desired.get("permissionTransition"))
    {
        let mut transition = desired["permissionTransition"].clone();
        transition["operationId"] = desired["operationId"].clone();
        transition["status"] = status.clone();
        transition
    } else {
        Value::Null
    };
    let worker = text(&context["workerId"])?;
    if !service.workers.commands.is_connected(&worker) {
        return unavailable(
            selection,
            "Project worker is offline; the legacy sandbox policy remains active.".into(),
        );
    }
    let attempt: Result<Value> = async {
        let runtime = service.model_routing.runtime_for_context(owner, context).await?
            .context("Choose a model before listing permission profiles.")?;
        let raw = service.workers.commands.request(&worker, json!({"type":"permission-profiles.list",
            "cwd":context["cwd"],"model":runtime["model"],"provider":runtime["provider"]}), None, None).await?;
        let capability = crate::settings::parse_response("permissionProfileCapabilitySchema", raw.as_ref())?;
        let profiles = capability["profiles"].as_array().context("Permission profiles")?;
        let full = profiles.iter().find(|p| p["id"] == ":danger-full-access");
        let mut offered = profiles.clone();
        if let Some(full) = full && !profiles.iter().any(|p| p["id"] == ":yolo") {
            offered.push(json!({"id":":yolo","description":"Unrestricted access without approval prompts","allowed":full["allowed"]}));
        }
        let mut result = selection.clone();
        result["available"] = capability["available"].clone();
        result["reason"] = capability["reason"].clone();
        result["profiles"] = Value::Array(offered);
        crate::settings::parse_response("chatPermissionProfileStateSchema", Some(&result))
    }.await;
    match attempt {
        Ok(state) => Ok(state),
        Err(cause) => {
            let mut prefix = JsString::from("Permission profiles are unavailable: ")
                .units()
                .to_vec();
            prefix.extend(message(&cause).units());
            unavailable(selection, JsString::new(prefix))
        }
    }
}
async fn update_bound(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    input: &Value,
) -> Result<Response> {
    if !truthy(input.get("bindingId"))
        || !truthy(input.get("operationId"))
        || input.get("expectedRevision").is_none()
    {
        return Ok(super::super::json_response(
            axum::http::StatusCode::BAD_REQUEST,
            json!({"code":"permission-source-required","error":"A bound permission change requires its source, operation identity and policy revision."}),
        ));
    }
    let chat = text(&context["chatId"])?;
    let attempt: Result<Response> = async {
        let binding = NativeSettings::new(service.repository.database.clone())
            .resolve_write_binding(owner, &chat, &input["bindingId"]).await?;
        let raw = service.workers.commands.request(&text(&binding["workerId"])?,
            json!({"type":"chat.permissions.update","operationId":input["operationId"],"binding":binding,
                "permissionTransition":native_commands::permissions::resolve(context, &input["id"], &input["expectedRevision"])}), None, None).await?;
        let receipt = crate::settings::parse_response("nativeSettingsUpdateReceiptSchema", raw.as_ref())?;
        anyhow::ensure!(receipt["operationId"] == input["operationId"], "Permission response belongs to another operation.");
        output(200, "nativeSettingsUpdateReceiptSchema", &receipt)
    }.await;
    match attempt {
        Ok(response) => Ok(response),
        Err(cause) => {
            if let Some(response) = native_failure(&cause) {
                return Ok(response);
            }
            let rejected = native_commands::Repository::new(service.repository.database.clone())
                .lookup(
                    owner,
                    &text(&context["workerId"])?,
                    &text(&input["operationId"])?,
                )
                .await?;
            if let Some(rejected) = rejected
                && rejected["chatId"] == context["chatId"]
                && rejected["method"] == "thread/settings/update"
                && rejected["status"] == "rejected"
                && truthy(rejected.get("rejectionCode"))
            {
                let code = text(&rejected["rejectionCode"])?;
                let message = match code.as_str() {
                    "permission-transition-pending" => {
                        "A permission change is already pending. Check the permission menu for its status."
                    }
                    "permission-revision-conflict" => {
                        "Permissions changed while saving. Select the permission mode again."
                    }
                    "permission-policy-replaced" => {
                        "The permission default or project policy changed. Select the permission mode again."
                    }
                    "settings-binding-replaced" => {
                        "The chat session changed. Select the permission mode again."
                    }
                    _ => "The permission change was rejected. Select the permission mode again.",
                };
                return Ok(super::super::json_response(
                    axum::http::StatusCode::CONFLICT,
                    json!({"code":code,"error":message}),
                ));
            }
            Err(cause)
        }
    }
}
pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    update: bool,
    body: Option<Value>,
) -> Result<Response> {
    let input = if update {
        match parse("chatPermissionProfileUpdateSchema", body.as_ref())? {
            Ok(value) => Some(value),
            Err(response) => return Ok(response),
        }
    } else {
        None
    };
    let repository = chats::Repository::new(service.repository.database.clone());
    let Some(context) = repository.execution_context(owner, chat).await? else {
        return Ok(error(404, "Chat source not found."));
    };
    let Some(input) = input else {
        return output(
            200,
            "chatPermissionProfileStateSchema",
            &state(service, owner, &context).await?,
        );
    };
    if truthy(context.get("threadId")) {
        return update_bound(service, owner, &context, &input).await;
    }
    if truthy(input.get("bindingId"))
        || truthy(input.get("operationId"))
        || input.get("expectedRevision").is_some()
    {
        return Ok(super::super::json_response(
            axum::http::StatusCode::CONFLICT,
            json!({"code":"settings-binding-replaced","error":"The selected native thread is no longer bound."}),
        ));
    }
    let capability = state(service, owner, &context).await?;
    let requested = input
        .get("id")
        .filter(|v| !v.is_null())
        .or_else(|| {
            context
                .get("defaultPermissionProfileId")
                .filter(|v| !v.is_null())
        })
        .cloned()
        .unwrap_or(json!(":workspace"));
    let profile = capability["profiles"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["id"] == requested));
    if profile.is_none()
        || (capability["available"] == false
            && wire::parse("configurablePermissionProfileIdSchema", Some(&requested)).is_err())
    {
        return Ok(error(
            400,
            "Codex did not advertise that permission profile.",
        ));
    }
    if profile.unwrap()["allowed"] == false {
        return Ok(error(409, "That permission profile is not allowed here."));
    }
    let updated = match repository
        .set_permission_profile(owner, chat, &input["id"])
        .await
    {
        Ok(value) => value,
        Err(cause) => {
            if let Some(response) = native_failure(&cause) {
                return Ok(response);
            }
            return Err(cause);
        }
    };
    if updated.is_none() {
        return Ok(error(404, "Chat source not found."));
    }
    let Some(refreshed) = repository.execution_context(owner, chat).await? else {
        return Ok(error(404, "Chat source not found."));
    };
    let mut result = chats::managed_console::permission_profile(&refreshed);
    for key in ["available", "profiles", "reason"] {
        result[key] = capability[key].clone();
    }
    output(200, "chatPermissionProfileStateSchema", &result)
}
