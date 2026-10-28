use super::{
    account,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::{now, service::AuthService},
    settings::telemetry::TelemetryQuery,
    wire::{Value, coercion},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{delete, get},
};
use std::{collections::HashMap, sync::Arc};

fn days(value: Option<&Value>) -> Result<f64> {
    let default = Value::String("90".into());
    let value = coercion::string(value.filter(|v| !v.is_null()).unwrap_or(&default))
        .map_err(|()| anyhow::anyhow!("Cannot convert object to primitive value"))?
        .trim();
    let units = value.units();
    let signed = units.first().is_some_and(|unit| matches!(unit, 43 | 45));
    let end = units
        .iter()
        .skip(usize::from(signed))
        .take_while(|u| (48..=57).contains(*u))
        .count()
        + usize::from(signed);
    let digits = String::from_utf16(&units[..end]).unwrap();
    let parsed = digits.parse::<f64>().unwrap_or(f64::NAN);
    Ok(if parsed.is_finite() {
        parsed.clamp(1.0, 365.0)
    } else {
        90.0
    })
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
        .context("authenticated telemetry owner")?
        .id;
    if request.uri().path() == "/api/analytics/provider-telemetry" {
        let filters = account::query(request.uri());
        let days = days(filters.get("days"))?;
        let to = now().timestamp_millis();
        let query = TelemetryQuery {
            filters,
            from: Some(to - (days * 86_400_000.0) as i64),
            to: Some(to),
        };
        return output(
            200,
            "providerTelemetryWireAnalyticsSchema",
            &service
                .provider_accounts
                .telemetry_analytics(owner, query)
                .await?,
        );
    }
    let delete = request.method() == Method::DELETE;
    let value = if delete {
        service
            .provider_accounts
            .telemetry_delete(owner, &params["providerId"])
            .await?
    } else {
        service
            .provider_accounts
            .telemetry_export(owner, &params["providerId"])
            .await?
    };
    match value {
        Some(value) => output(
            200,
            if delete {
                "providerTelemetryDeleteResultSchema"
            } else {
                "providerTelemetryExportSchema"
            },
            &value,
        ),
        None => Ok(error(404, "Model provider not found.")),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(&service, &ctx, &params, request).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/analytics/provider-telemetry", get(handle))
        .route(
            "/api/analytics/provider-telemetry/{providerId}/export",
            get(handle),
        )
        .route(
            "/api/analytics/provider-telemetry/{providerId}",
            delete(handle),
        )
}
