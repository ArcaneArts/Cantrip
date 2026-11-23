//! Model routing is resolved before the repository's native-runtime write fence.
use super::*;
use crate::chats;

pub(super) async fn update(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    input: Value,
) -> Result<Response> {
    let repository = chats::Repository::new(service.repository.database.clone());
    let Some(context) = repository.execution_context(&owner, &chat).await? else {
        return Ok(error(404, "Chat source not found."));
    };
    if matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    ) {
        return output(
            409,
            "modelConfigurationFailureSchema",
            &json!({"error":"Finish or interrupt the active turn before changing its model configuration.","code":"chat-runtime-active","field":Value::Null,"retryable":true}),
        );
    }
    if let Err(cause) = service
        .model_routing
        .route_pairs(&owner, &context, &input, None)
        .await
    {
        if let Some(failure) =
            downcast_ref::<crate::settings::reasoning::ConfigurationFailure>(&cause)
        {
            return output(
                if failure.0["code"] == "worker-offline" {
                    503
                } else {
                    409
                },
                "modelConfigurationFailureSchema",
                &failure.0,
            );
        }
        return Err(cause);
    }
    match repository
        .set_model_configuration(&owner, &chat, &input)
        .await?
    {
        Some(chat) => output(200, "contextualChatWireSummarySchema", &chat),
        None => Ok(error(404, "Chat or model not found.")),
    }
}
