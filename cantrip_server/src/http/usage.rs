use super::{
    account, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    usage::{live_traffic, response},
    wire::{self, ValidationError, Value},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::Response,
    routing::get,
};
use std::sync::Arc;

fn input(schema: &str, request: &Request) -> Result<Result<Value, Response>> {
    match wire::parse(schema, Some(&account::query(request.uri()))) {
        Ok(value) => Ok(Ok(value)),
        Err(ValidationError::Invalid(issues)) => Ok(Err(json_response(
            StatusCode::BAD_REQUEST,
            Value::object([
                ("error", Value::String("Invalid request body".into())),
                ("issues", Value::Array(issues)),
            ]),
        ))),
        Err(ValidationError::Operation) => anyhow::bail!("Usage query validation failed."),
    }
}
fn output(schema: &str, value: serde_json::Value) -> Result<Response> {
    let value = wire::parse(schema, Some(&Value::from_serialize(&value)))
        .map_err(|_| anyhow::anyhow!("Usage response violates its protocol contract."))?;
    let mut response = json_response(StatusCode::OK, value);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    Ok(response)
}
async fn execute(service: &AuthService, ctx: &Context, request: Request) -> Result<Response> {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("authenticated usage owner")?
        .id;
    let usage = &service.usage;
    let repository = &usage.repository;
    match request.uri().path() {
        "/api/account/live-traffic" => {
            let query = match input("accountLiveTrafficQuerySchema", &request)? {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            output(
                "accountLiveTrafficSchema",
                usage.traffic(
                    owner,
                    &live_traffic::Query {
                        after: query["after"].as_str().map(str::to_owned),
                        epoch: query["epoch"].as_str().map(str::to_owned),
                    },
                )?,
            )
        }
        "/api/account/resource-usage/history" => {
            let query = match input("accountResourceUsageHistoryQuerySchema", &request)? {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            let from = chrono::DateTime::from_timestamp_millis(
                wire::live::datetime_millis(&query["from"]).context("validated history start")?,
            )
            .context("history start date")?;
            let to = chrono::DateTime::from_timestamp_millis(
                wire::live::datetime_millis(&query["to"]).context("validated history end")?,
            )
            .context("history end date")?;
            let query: response::HistoryQuery = serde_json::from_str(&query.stringify())?;
            let hourly = query.resolution == "hour";
            let value = if query.metric == "storage" {
                response::storage_history(
                    &query,
                    &repository.storage_history(owner, from, to, hourly).await?,
                )
            } else {
                response::bandwidth_history(
                    &query,
                    &repository
                        .bandwidth_history(owner, from, to, hourly)
                        .await?,
                )
            };
            output("accountResourceUsageHistorySchema", value)
        }
        _ => {
            let now = crate::auth::now();
            let (start, end) = response::bandwidth_period(now)?;
            let (rows, bandwidth) = tokio::try_join!(
                repository.current_storage(owner),
                repository.bandwidth_history(owner, start, end, false)
            )?;
            output(
                "accountResourceUsageSchema",
                response::current(&rows, &bandwidth, now)?,
            )
        }
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    match execute(&service, &ctx, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/account/resource-usage", get(handle))
        .route("/api/account/resource-usage/history", get(handle))
        .route(live_traffic::ROUTE, get(handle))
}
