//! Scope public model metadata to canonical owner, provider and physical account.
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy},
};
use anyhow::{Context, Result};

pub async fn scoped(
    tx: &Transaction<'_>,
    owner: &str,
    scope: &Value,
    snapshot: &Value,
) -> Result<Value> {
    let selected = &snapshot["modelAttribution"]["selection"];
    if selected["status"] != "resolved" {
        return Ok(snapshot.clone());
    }
    let discard = || {
        let mut native = snapshot.clone();
        if let Value::Object(fields) = &mut native {
            fields.retain(|key, _| key.as_str() != Some("modelAttribution"));
        }
        native
    };
    if !truthy(scope.get("modelRouteId"))
        || selected.get("workerId") != scope.get("workerId")
        || selected.get("providerAccountId") != scope.get("providerAccountId")
    {
        return Ok(discard());
    }
    let anchor = scope["modelRouteId"]
        .as_js_string()
        .context("Settings anchor route")?
        .lossy();
    let route = selected["routeId"]
        .as_js_string()
        .context("Settings model route")?
        .lossy();
    let rows = tx.query("SELECT jsonb_build_object('routeId',r.id,'modelId',r.model_id,'providerId',r.provider_id)::text FROM model_routes r INNER JOIN model_providers p ON p.id=r.provider_id WHERE p.owner_id=$1 AND r.id IN ($2,$3)", &[&owner,&anchor.as_ref(),&route.as_ref()]).await?;
    let routes = rows
        .iter()
        .map(|row| Ok::<Value, anyhow::Error>(serde_json::from_str(&row.get::<String>(0)?)?))
        .collect::<Result<Vec<_>>>()?;
    let anchor = routes
        .iter()
        .find(|route| route.get("routeId") == scope.get("modelRouteId"));
    let model = routes
        .iter()
        .find(|route| route.get("routeId") == selected.get("routeId"));
    Ok(
        if anchor.zip(model).is_some_and(|(anchor, model)| {
            anchor.get("providerId") == selected.get("providerId")
                && model.get("providerId") == selected.get("providerId")
                && model.get("modelId") == selected.get("modelId")
        }) {
            snapshot.clone()
        } else {
            discard()
        },
    )
}
