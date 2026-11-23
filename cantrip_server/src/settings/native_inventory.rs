//! Public model metadata follows the same provider/account discovery scopes.
use super::{catalog_hash, repository::SettingsRepository};
use crate::{
    chats::eligibility,
    wire::{Value, coercion::truthy},
};
use anyhow::{Context, Result};
use futures::FutureExt;
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Native inventory identity")?
        .lossy()
        .into_owned())
}
impl SettingsRepository {
    pub async fn read_native_model_inventory(
        &self,
        owner: &str,
        request: &Value,
    ) -> Result<Option<Value>> {
        let id = text(&request["providerId"])?;
        let Some(provider) = self.get_model_provider(owner, &id).boxed().await? else {
            return Ok(None);
        };
        let provider = Value::from_serialize(&provider);
        let account = eligibility::account_provider(&provider["kind"]);
        if account {
            let accounts = self.list_provider_accounts(owner, &id).boxed().await?;
            if !truthy(request.get("providerAccountId"))
                || !accounts.is_some_and(|accounts| {
                    accounts.iter().any(|a| {
                        let a = Value::from_serialize(a);
                        a.get("id") == request.get("providerAccountId") && truthy(a.get("enabled"))
                    })
                })
            {
                return Ok(None);
            }
        } else if request.get("providerAccountId") != Some(&Value::Null) {
            return Ok(None);
        }
        let (runtimes, catalog) = tokio::try_join!(
            self.get_model_runtimes(owner, None, None, false, Some(&id))
                .boxed(),
            self.get_provider_model_catalog(owner, &id, false).boxed()
        )?;
        let availability = catalog
            .as_ref()
            .and_then(|c| c["availability"].as_array())
            .map(|a| a.iter().map(Value::from_serialize).collect::<Vec<_>>())
            .unwrap_or_default();
        let mut models = Vec::new();
        for runtime in runtimes {
            let runtime = Value::from_serialize(&runtime);
            if runtime["provider"].get("id") != request.get("providerId") {
                continue;
            }
            let model = &runtime["model"];
            let states = if truthy(model.get("providerModelId")) {
                availability
                    .iter()
                    .filter(|a| a.get("providerModelId") == model.get("providerModelId"))
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let available = if !account {
                eligibility::route_availability_for_worker(&runtime, &states, &request["workerId"])
                    ["available"]
                    == true
            } else {
                let scoped = states
                    .iter()
                    .filter(|a| {
                        a.get("providerAccountId") == request.get("providerAccountId")
                            && (a["workerId"].is_null()
                                || a.get("workerId") == request.get("workerId"))
                    })
                    .collect::<Vec<_>>();
                let observed = scoped
                    .iter()
                    .find(|a| a["workerId"].is_null())
                    .copied()
                    .or_else(|| scoped.first().copied());
                model.get("providerModelId") == Some(&Value::Null)
                    || observed.is_some_and(|a| a["state"] == "available")
            };
            if available {
                models.push(model.clone());
            }
        }
        let collator = catalog_hash::collator()?;
        models.sort_by(|a, b| {
            for key in ["name", "id", "routeId"] {
                let order = collator.compare_utf16_icu4c(
                    a[key]
                        .as_js_string()
                        .expect("Model descriptor name")
                        .units(),
                    b[key]
                        .as_js_string()
                        .expect("Model descriptor name")
                        .units(),
                );
                if !order.is_eq() {
                    return order;
                }
            }
            std::cmp::Ordering::Equal
        });
        let mut result = request.clone();
        result["providerKind"] = provider["kind"].clone();
        result["models"] = Value::Array(models);
        super::parse_response("nativeModelInventorySchema", Some(&result)).map(Some)
    }
}
