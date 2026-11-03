//! Remaining public settings operations: updater state and a native provider probe.
use super::{
    account, body,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    settings::{self, desktop_update, provider_connection, repository::SettingsRepository},
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::RequestTimeout,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc, time::Duration};

fn reply(
    start: i64,
    ok: bool,
    stage: &str,
    message: crate::wire::JsString,
    worker: Value,
    model: Value,
) -> Result<Response> {
    output(
        200,
        "providerConnectionTestResultSchema",
        &json!({"ok":ok,"stage":stage,"message":message,
        "workerId":worker,"modelName":model,"durationMs":(crate::auth::now().timestamp_millis()-start) as f64}),
    )
}
async fn probe(service: &AuthService, owner: &str, id: &str, query: &Value) -> Result<Response> {
    let start = crate::auth::now().timestamp_millis();
    let repository = SettingsRepository::new(service.repository.database.clone());
    let Some(provider) = repository.get_model_provider(owner, id).await? else {
        return Ok(error(404, "Provider not found."));
    };
    if !settings::zai::is_coding_plan_provider(&provider) {
        return Ok(error(
            409,
            "Connection testing is currently available for Z.ai Coding Plan providers.",
        ));
    }
    let runtimes = repository
        .get_model_runtimes(owner, None, None, false, None)
        .await?
        .into_iter()
        .filter(|r| r["provider"]["id"] == provider["id"])
        .collect::<Vec<_>>();
    let Some(runtime) = runtimes
        .iter()
        .find(|r| r["model"]["name"] == "glm-5.3")
        .or_else(|| runtimes.first())
    else {
        return reply(
            start,
            false,
            "model-availability",
            "No enabled Z.ai model route is available. Refresh the bundled catalog and try again."
                .into(),
            Value::Null,
            Value::Null,
        );
    };
    let (preferences, workers) = tokio::try_join!(
        repository.get_user_settings(owner),
        service.workers.repository.list_workers(owner)
    )?;
    let requested = query.get("workerId");
    let selected = if truthy(requested) {
        workers
            .iter()
            .find(|w| {
                requested
                    .and_then(Value::as_str)
                    .is_some_and(|id| w["workerId"].as_str() == Some(id))
            })
            .and_then(|w| w["workerId"].as_str())
    } else {
        preferences["defaultWorkerId"]
            .as_str()
            .filter(|id| !id.is_empty() && service.workers.commands.is_connected(id))
            .or_else(|| {
                workers
                    .iter()
                    .filter_map(|w| w["workerId"].as_str())
                    .find(|id| service.workers.commands.is_connected(id))
            })
    };
    let model = Value::from_serialize(&runtime["model"]["name"]);
    let Some(worker) =
        selected.filter(|id| !id.is_empty() && service.workers.commands.is_connected(id))
    else {
        return reply(
            start,
            false,
            "worker-placement",
            if truthy(requested) {
                "The selected worker is offline or unavailable."
            } else {
                "No compatible online worker could run the test."
            }
            .into(),
            selected
                .map(|s| json!(s))
                .or_else(|| requested.cloned())
                .unwrap_or(Value::Null),
            model,
        );
    };
    let attempt: Result<Response> = async {
        let response = service.workers.commands.request_with_timeout(worker,
            json!({"type":"model.provider.test","model":Value::from_serialize(&runtime["model"]),"provider":Value::from_serialize(&runtime["provider"])}),
            RequestTimeout::After(Duration::from_secs(120)), None).await?;
        settings::parse_response("workerProviderConnectionTestResultSchema", response.as_ref())?;
        reply(start, true, "completed", format!("Connected to Z.ai through bundled Codex using {}.", runtime["model"]["name"].as_str().unwrap_or("")).into(), json!(worker), model.clone())
    }.await;
    match attempt {
        Ok(response) => Ok(response),
        Err(cause) => {
            let detail = settings::operation_error_message(&cause);
            let stage = provider_connection::failure_stage(&detail);
            reply(
                start,
                false,
                stage.name(),
                stage.message(&detail),
                json!(worker),
                model,
            )
        }
    }
}
async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    params: &HashMap<String, String>,
    query: &Value,
) -> Result<Response> {
    if let Some(provider) = params.get("providerId") {
        return probe(service, owner, provider, query).await;
    }
    let counts = futures::future::try_join_all(desktop_update::COUNTS.iter().map(|name| {
        let database = service.repository.database.clone();
        let owner = owner.to_owned();
        // Each admitted read survives an earlier failure or a disconnected HTTP
        // caller and participates in the existing owned-operation shutdown drain.
        service
            .scratch_roots
            .owned(desktop_update::count(database, owner, name))
    }))
    .await?;
    output(
        200,
        "desktopUpdateActiveWorkSummarySchema",
        &desktop_update::summary(std::array::from_fn(|i| counts[i])),
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let query = account::query(request.uri());
    if params.contains_key("providerId") {
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        if let Err(response) =
            body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await
        {
            return response;
        }
    }
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let work = {
        let service = service.clone();
        async move { execute(&service, &owner, &params, &query).await }
    };
    match service.scratch_roots.owned(work).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/desktop-update/active-work", get(handle))
        .route("/api/settings/providers/{providerId}/test", post(handle))
}
