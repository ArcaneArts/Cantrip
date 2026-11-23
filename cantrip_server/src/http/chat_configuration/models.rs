use super::*;
fn configuration_failure(cause: &anyhow::Error) -> Result<Response> {
    if let Some(failure) = downcast_ref::<reasoning::ConfigurationFailure>(cause) {
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
    Ok(error(409, message(cause)))
}
fn repository_failure(cause: anyhow::Error) -> Result<Response> {
    if let Some(error) = downcast_ref::<native_commands::CommandError>(&cause) {
        // These routes let the repository error reach Fastify's error handler.
        // Its Error serializer differs from the explicit permission response.
        let status = axum::http::StatusCode::from_u16(error.status)?;
        return Ok(super::super::json_response(
            status,
            json!({
                "statusCode":error.status,"code":error.code,
                "error":status.canonical_reason().unwrap_or("Error"),"message":error.message
            }),
        ));
    }
    Err(cause)
}
async fn state(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    model: Option<&Value>,
    effort: &Value,
    configuration: bool,
) -> Result<Value> {
    let model = match model {
        Some(model) => model.clone(),
        None => {
            service
                .model_routing
                .resolve_model_id(owner, context, None)
                .await?
        }
    };
    let runtimes = service
        .model_routing
        .available_runtimes(owner, context, &text(&model)?)
        .await?;
    Ok(reasoning::state(&model, effort, &runtimes, configuration)?)
}
async fn remembered(service: &AuthService, owner: &str, model: &Value) -> Result<Value> {
    Ok(SettingsRepository::new(service.repository.database.clone())
        .get_model_reasoning_default(owner, &text(model)?)
        .await?
        .flatten()
        .map_or(Value::Null, |effort| Value::String(effort.into())))
}
pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    model_update: bool,
    update: bool,
    query: &Value,
    body: Option<Value>,
) -> Result<Response> {
    let input = if update {
        match parse(
            if model_update {
                "chatModelUpdateSchema"
            } else {
                "chatReasoningUpdateSchema"
            },
            body.as_ref(),
        )? {
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
    if !update {
        let attempt: Result<Value> = async {
            let requested = query
                .get("modelId")
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_js_string()
                        .map(JsString::trim)
                        .context("request.query.modelId?.trim is not a function")
                })
                .transpose()?
                .filter(|v| !v.is_empty())
                .map(Value::String);
            let model = service
                .model_routing
                .resolve_model_id(owner, &context, requested.as_ref())
                .await?;
            let effort = if truthy(context.get("modelId")) && requested.is_none() {
                context["reasoningEffort"].clone()
            } else {
                remembered(service, owner, &model).await?
            };
            state(
                service,
                owner,
                &context,
                Some(&model),
                &effort,
                requested.is_some(),
            )
            .await
        }
        .await;
        return match attempt {
            Ok(value) => output(200, "chatReasoningStateSchema", &value),
            Err(cause) => Ok(error(409, message(&cause))),
        };
    }
    let input = input.unwrap();
    if model_update {
        let attempt: Result<Value> = async {
            state(
                service,
                owner,
                &context,
                Some(&input["modelId"]),
                &remembered(service, owner, &input["modelId"]).await?,
                false,
            )
            .await
        }
        .await;
        let reasoning = match attempt {
            Ok(value) => value,
            Err(cause) => return configuration_failure(&cause),
        };
        let mut configuration = context["modelConfiguration"].clone();
        configuration["modelId"] = input["modelId"].clone();
        configuration["reasoningEffort"] = reasoning["reasoningEffort"].clone();
        let configuration =
            crate::settings::parse_response("modelConfigurationSchema", Some(&configuration))?;
        if let Err(cause) = service
            .model_routing
            .route_pairs(owner, &context, &configuration, None)
            .await
        {
            return configuration_failure(&cause);
        }
        return match repository
            .set_model_configuration(owner, chat, &configuration)
            .await
        {
            Ok(Some(value)) => output(200, "contextualChatWireSummarySchema", &value),
            Ok(None) => Ok(error(404, "Chat or model not found.")),
            Err(cause) => repository_failure(cause),
        };
    }
    let current = match state(
        service,
        owner,
        &context,
        None,
        &context["reasoningEffort"],
        false,
    )
    .await
    {
        Ok(value) => value,
        Err(cause) => return Ok(error(409, message(&cause))),
    };
    if !input["reasoningEffort"].is_null()
        && !current["options"].as_array().is_some_and(|options| {
            options
                .iter()
                .any(|o| o["effort"] == input["reasoningEffort"])
        })
    {
        return Ok(error(
            409,
            "That reasoning effort is not supported by every eligible provider route.",
        ));
    }
    let mut configuration = context["modelConfiguration"].clone();
    configuration["modelId"] = current["modelId"].clone();
    configuration["reasoningEffort"] = input["reasoningEffort"].clone();
    let configuration =
        crate::settings::parse_response("modelConfigurationSchema", Some(&configuration))?;
    if let Err(cause) = service
        .model_routing
        .route_pairs(owner, &context, &configuration, None)
        .await
    {
        return configuration_failure(&cause);
    }
    match repository
        .set_model_configuration(owner, chat, &configuration)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return Ok(error(404, "Chat source not found.")),
        Err(cause) => return repository_failure(cause),
    }
    let mut result = current;
    result["reasoningEffort"] = input["reasoningEffort"].clone();
    output(200, "chatReasoningStateSchema", &result)
}
