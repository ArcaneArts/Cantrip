use super::{
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    project_alerts::Repository,
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Query, State},
    response::Response,
    routing::get,
};
use std::{collections::HashMap, sync::Arc};

async fn counts(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
) -> Response {
    let result: Result<Response> = async {
        let counts = Repository::new(service.repository.database.clone())
            .counts(&ctx.principal.user.as_ref().unwrap().id)
            .await?;
        output(200, "projectAlertCountsSchema", &counts)
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
async fn list(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(project): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let result: Result<Response> = async {
        let query = Value::from_serialize(&json!(query));
        let query = match parse("projectAlertQuerySchema", Some(&query))? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        match Repository::new(service.repository.database.clone())
            .list(&ctx.principal.user.as_ref().unwrap().id, &project, &query)
            .await?
        {
            Some(page) => output(200, "projectAlertPageSchema", &page),
            None => Ok(error(404, "Alert Inbox or page not found.")),
        }
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
async fn goal(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path((project, alert)): Path<(String, String)>,
) -> Response {
    let result: Result<Response> = async {
        match Repository::new(service.repository.database.clone())
            .goal_source(&ctx.principal.user.as_ref().unwrap().id, &project, &alert)
            .await?
        {
            Some(value) => output(200, "projectGoalSnapshotSchema", &value),
            None => Ok(error(404, "Alert source is no longer available.")),
        }
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/alerts/{alertId}/goal", get(goal))
        .route("/api/project-alerts/counts", get(counts))
        .route("/api/projects/{projectId}/alerts", get(list))
}
