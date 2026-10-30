use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    settings::{reasoning, repository::SettingsRepository},
    wire::{self, JsString, ValidationError, Value},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::Response,
    routing::{get, patch, post},
};
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};

pub(super) fn error(status: u16, message: impl Into<JsString>) -> Response {
    json_response(
        StatusCode::from_u16(status).unwrap(),
        Value::object([("error", Value::String(message.into()))]),
    )
}
pub(super) fn output(status: u16, schema: &str, value: &Value) -> Result<Response> {
    output_optional(status, schema, Some(value))
}
fn output_optional(status: u16, schema: &str, value: Option<&Value>) -> Result<Response> {
    let value = crate::settings::parse_response(schema, value)?;
    Ok(json_response(StatusCode::from_u16(status).unwrap(), value))
}
pub(super) fn parse(schema: &str, value: Option<&Value>) -> Result<Result<Value, Response>> {
    match wire::parse(schema, value) {
        Ok(value) => Ok(Ok(value)),
        Err(ValidationError::Invalid(issues)) => Ok(Err(json_response(
            StatusCode::BAD_REQUEST,
            Value::object([
                ("error", Value::String("Invalid request body".into())),
                ("issues", Value::Array(issues)),
            ]),
        ))),
        Err(ValidationError::Operation) => anyhow::bail!("Settings request validation failed."),
    }
}
fn effects(preferences: &serde_json::Value) -> Value {
    Value::from_serialize(&json!({
        "revision": preferences.get("computerUseEffectsRevision").filter(|v| !v.is_null()).cloned().unwrap_or(json!(1)),
        "configuration": if preferences["computerUseEnabled"] == true {
            preferences.get("computerUseEffects").filter(|v| !v.is_null()).cloned().unwrap_or(json!({"effect":"off","parameters":{}}))
        } else { json!({"effect":"off","parameters":{}}) },
    }))
}
// PostgreSQL text fields cross the UTF-8 boundary only after JS validation and
// model-route decisions. JSON settings keep their original escaped contents.
fn storage_preferences(mut value: Value) -> Result<serde_json::Value> {
    for field in [
        "labelingModelId",
        "defaultModelId",
        "defaultChatModelId",
        "defaultSubagentModelId",
        "defaultWorkerId",
        "lastIdeProjectId",
        "lastIdeWorkspaceId",
        "lastStandaloneChatId",
    ] {
        if let Some(text) = value.get(field).and_then(Value::as_js_string) {
            value[field] = Value::String(text.lossy().into_owned().into());
        }
    }
    Ok(serde_json::from_str(&value.stringify())?)
}
async fn validate_defaults(
    repository: &SettingsRepository,
    owner: &str,
    input: &Value,
    chat: bool,
) -> Result<Option<Response>> {
    let fields = if chat {
        &["defaultChatModelId", "defaultChatReasoningEffort"][..]
    } else {
        &[
            "defaultModelId",
            "defaultReasoningEffort",
            "defaultCustomSubagentModel",
            "defaultSubagentModelId",
            "defaultSubagentReasoningEffort",
        ][..]
    };
    if fields.iter().all(|field| input.get(field).is_none()) {
        return Ok(None);
    }
    let current = Value::from_serialize(&repository.get_user_settings(owner).await?);
    let saved = |field: &str| input.get(field).unwrap_or(&current[field]).clone();
    let configuration = if chat {
        Value::object([
            ("modelId", saved(fields[0])),
            ("reasoningEffort", saved(fields[1])),
            ("customSubagentModel", Value::Bool(false)),
            ("subagentModelId", Value::Null),
            ("subagentReasoningEffort", Value::Null),
        ])
    } else {
        Value::object([
            ("modelId", saved(fields[0])),
            ("reasoningEffort", saved(fields[1])),
            ("customSubagentModel", saved(fields[2])),
            ("subagentModelId", saved(fields[3])),
            ("subagentReasoningEffort", saved(fields[4])),
        ])
    };
    let configuration = match parse("modelConfigurationSchema", Some(&configuration))? {
        Ok(value) => value,
        Err(response) => return Ok(Some(response)),
    };
    let custom = configuration["customSubagentModel"] == Value::Bool(true);
    let model = configuration["modelId"]
        .as_js_string()
        .map(|id| id.lossy().into_owned());
    if model.as_ref().is_none_or(String::is_empty) && !custom {
        return Ok(None);
    }
    let subagent = configuration["subagentModelId"]
        .as_js_string()
        .filter(|_| custom)
        .map(|id| id.lossy().into_owned());
    let (roots, subagents) = if model.as_ref().is_none_or(String::is_empty) {
        (vec![], vec![])
    } else {
        tokio::try_join!(
            repository.get_model_runtimes(owner, model.as_deref(), None, false, None),
            async {
                if subagent.is_some() {
                    repository
                        .get_model_runtimes(owner, subagent.as_deref(), None, false, None)
                        .await
                } else {
                    Ok(vec![])
                }
            },
        )?
    };
    let roots = roots.iter().map(Value::from_serialize).collect::<Vec<_>>();
    let subagents = subagents
        .iter()
        .map(Value::from_serialize)
        .collect::<Vec<_>>();
    match reasoning::resolve_pairs(&configuration, &roots, &subagents, None) {
        Ok(_) => Ok(None),
        Err(error) => {
            if let Some(failure) = error.downcast_ref::<reasoning::ConfigurationFailure>() {
                Ok(Some(output(
                    if failure.0["code"] == "worker-offline" {
                        503
                    } else {
                        409
                    },
                    "modelConfigurationFailureSchema",
                    &failure.0,
                )?))
            } else {
                Err(error)
            }
        }
    }
}
async fn execute(
    service: &AuthService,
    ctx: &Context,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("authenticated settings owner")?
        .id;
    let repository = SettingsRepository::new(service.repository.database.clone());
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if method == Method::GET || method == Method::HEAD {
        if path == "/api/settings" {
            return output(
                200,
                "settingsBundleWireSchema",
                &Value::from_serialize(&service.provider_accounts.settings_bundle(owner).await?),
            );
        }
        if let Some(worker) = params.get("workerId") {
            if service
                .workers
                .repository
                .get_worker(owner, worker)
                .await?
                .is_none()
            {
                return Ok(error(404, "Worker not found."));
            }
            let result: Result<Response> = async {
                let preferences = repository.get_user_settings(owner).await?;
                match service
                    .workers
                    .commands
                    .request(
                        worker,
                        Value::object([
                            ("type", Value::String("computer-use.effects.sync".into())),
                            ("preferences", effects(&preferences)),
                        ]),
                        None,
                        None,
                    )
                    .await
                {
                    Ok(value) => {
                        output_optional(200, "cuaEffectWorkerStatusSchema", value.as_ref())
                    }
                    Err(failure) => Ok(error(failure.status(502), failure.message())),
                }
            }
            .await;
            let mut response = result.unwrap_or_else(|failure| error(502, failure.to_string()));
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            return Ok(response);
        }
        let model = JsString::from(params["modelId"].as_str()).trim();
        let id = model.lossy();
        let runtimes = repository
            .get_model_runtimes(owner, Some(&id), None, false, None)
            .await?;
        if runtimes.is_empty() {
            return Ok(error(404, "Model not found."));
        }
        let effort = repository
            .get_model_reasoning_default(owner, &id)
            .await?
            .map_or(Value::Null, |effort| Value::String(effort.into()));
        let runtimes = runtimes
            .iter()
            .map(Value::from_serialize)
            .collect::<Vec<_>>();
        return output(
            200,
            "chatReasoningStateSchema",
            &reasoning::state(&Value::String(model), &effort, &runtimes, true)?,
        );
    }
    if method == Method::DELETE {
        // Fastify parses DELETE payloads even when the handler ignores them.
        // A parser failure must complete before any model mutation.
        if let Err(response) = body::parse_js(request, service.config.api_body_limit_bytes).await {
            return Ok(response);
        }
        return Ok(
            match repository
                .delete_model_profile(owner, &params["modelId"])
                .await
            {
                Ok(true) => {
                    let mut response = Response::new(Body::empty());
                    *response.status_mut() = StatusCode::NO_CONTENT;
                    response
                }
                Ok(false) => error(404, "Model not found."),
                Err(_) => error(
                    409,
                    "This model is the default or selected by an existing chat.",
                ),
            },
        );
    }
    let schema = if path == "/api/settings" {
        "userSettingsUpdateSchema"
    } else if path.ends_with("/destination") {
        "appDestinationUpdateSchema"
    } else if method == Method::POST {
        "modelProfileCreateSchema"
    } else {
        "modelProfileUpdateSchema"
    };
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let input = match parse(schema, body.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if path == "/api/settings" {
        for chat in [false, true] {
            if let Some(response) = validate_defaults(&repository, owner, &input, chat).await? {
                return Ok(response);
            }
        }
        let Some(settings) = repository
            .update_settings(owner, &storage_preferences(input.clone())?)
            .await?
        else {
            return Ok(error(400, "Default model or worker was not found."));
        };
        if input.get("computerUseEffects").is_some() || input.get("computerUseEnabled").is_some() {
            let workers = service.workers.repository.list_workers(owner).await?;
            let preferences = effects(&settings["preferences"]);
            // A failed rendering command cannot roll back the committed settings.
            let pending = workers
                .iter()
                .filter_map(|worker| worker["workerId"].as_str())
                .map(|worker| {
                    service.workers.commands.request(
                        worker,
                        Value::object([
                            ("type", Value::String("computer-use.effects.sync".into())),
                            ("preferences", preferences.clone()),
                        ]),
                        Some(Duration::from_secs(5)),
                        None,
                    )
                });
            futures::future::join_all(pending).await;
        }
        return output(
            200,
            "settingsBundleWireSchema",
            &Value::from_serialize(&settings),
        );
    }
    if path.ends_with("/destination") {
        return match repository
            .update_app_destination(owner, &storage_preferences(input)?)
            .await?
        {
            Some(destination) => output(
                200,
                "appDestinationSchema",
                &Value::from_serialize(&destination),
            ),
            None => Ok(error(
                409,
                "The saved destination changed or the requested destination is unavailable.",
            )),
        };
    }
    // These routes catch persistence and response projection errors together,
    // matching the existing post-commit behavior of model CRUD.
    let result: Result<Response> = async {
        let (status, model) = if method == Method::POST {
            (201, repository.create_model_profile(owner, &input).await?)
        } else {
            (
                200,
                repository
                    .update_model_profile(owner, &params["modelId"], &input)
                    .await?,
            )
        };
        match model {
            Some(model) => output(
                status,
                "modelProfileSummarySchema",
                &Value::from_serialize(&model),
            ),
            None => Ok(error(
                404,
                if method == Method::POST {
                    "Provider not found."
                } else {
                    "Model or provider not found."
                },
            )),
        }
    }
    .await;
    Ok(result.unwrap_or_else(|failure| {
        error(
            409,
            failure
                .downcast_ref::<crate::settings::SettingsQueryError>()
                .map_or_else(
                    || failure.to_string().into(),
                    |failure| failure.message.clone(),
                ),
        )
    }))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(&service, &ctx, &params, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/settings", get(handle).patch(handle))
        .route("/api/settings/destination", patch(handle))
        .route("/api/settings/models", post(handle))
        .route(
            "/api/settings/models/{modelId}",
            patch(handle).delete(handle),
        )
        .route("/api/settings/models/{modelId}/reasoning", get(handle))
        .route(
            "/api/settings/computer-use/workers/{workerId}/effects",
            get(handle),
        )
}
