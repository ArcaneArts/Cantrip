use super::*;
use crate::settings::repository::SettingsRepository as Models;
async fn runtime(models: &Models, owner: &str, binding: &Value) -> Result<Option<Value>> {
    if binding["modelRouteId"].is_null() {
        return Ok(None);
    }
    Ok(models
        .get_model_runtimes(
            owner,
            None,
            Some(&text(&binding["modelRouteId"])?),
            true,
            None,
        )
        .boxed()
        .await?
        .into_iter()
        .next()
        .map(|v| Value::from_serialize(&v)))
}
async fn read(service: &AuthService, owner: &str, chat: &str, binding_id: &Value) -> Result<Value> {
    let repository = repository(service);
    let models = Models::new(service.repository.database.clone());
    let binding = repository
        .resolve_write_binding(owner, chat, binding_id)
        .boxed()
        .await?;
    let Some(first) = runtime(&models, owner, &binding).await? else {
        return Err(CommandError::new(
            "native-model-route-unavailable",
            Some("The bound model route is no longer available."),
            409,
        )
        .into());
    };
    let request = json!({"workerId":binding["workerId"],"providerId":first["provider"]["id"],"providerAccountId":binding["providerAccountId"]});
    let Some(mut inventory) = models
        .read_native_model_inventory(owner, &request)
        .boxed()
        .await?
    else {
        return Err(CommandError::new(
            "native-model-inventory-unavailable",
            Some("The bound provider/account inventory is unavailable."),
            409,
        )
        .into());
    };
    let current = repository
        .resolve_write_binding(owner, chat, &binding["bindingId"])
        .boxed()
        .await?;
    let current_runtime = runtime(&models, owner, &current).await?;
    if current != binding
        || current_runtime
            .as_ref()
            .and_then(|v| v["provider"].get("id"))
            != first["provider"].get("id")
        || current_runtime
            .as_ref()
            .and_then(|v| v["provider"].get("kind"))
            != first["provider"].get("kind")
    {
        return Err(CommandError::new(
            "settings-binding-replaced",
            Some("The native model inventory source changed while it was being read."),
            409,
        )
        .into());
    }
    inventory["bindingId"] = binding["bindingId"].clone();
    crate::settings::parse_response("nativeChatModelInventorySchema", Some(&inventory))
}
pub(super) async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let query = super::super::account::query(request.uri());
    let query = match wire::parse("nativeChatModelInventoryQuerySchema", Some(&query)) {
        Ok(query) => query,
        Err(_) => return code(400, "invalid-native-model-inventory"),
    };
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated model inventory owner")
        .id;
    match read(&service, owner, &chat, &query["bindingId"]).await {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(cause) => failure(&service, &ctx.id, cause),
    }
}
