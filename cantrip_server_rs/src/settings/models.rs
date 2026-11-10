use super::{query_error, repository::SettingsRepository};
use crate::{
    auth::now,
    wire::{JsString, Value as WireValue},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn string<'a>(value: &'a WireValue, name: &str) -> Result<&'a JsString> {
    value[name].as_js_string().context("validated model text")
}
fn route_id(value: &WireValue) -> Option<&JsString> {
    value["id"].as_js_string().filter(|id| !id.is_empty())
}
fn adapter_matches(adapter: Option<&str>, operation: &str) -> bool {
    match adapter {
        None => true,
        Some("responses" | "chat-completions") => operation == "language",
        Some(
            "openai-embeddings" | "ollama-embed" | "llama-embeddings" | "vllm-embeddings"
            | "vllm-pooling" | "vllm-bge-m3" | "cohere-embed",
        ) => operation == "embedding",
        Some("openai-decisions" | "system-one" | "openrouter-decisions") => operation == "decision",
        _ => false,
    }
}
fn options_json(value: &WireValue) -> Result<Value> {
    if value.is_null() {
        return Ok(json!({}));
    }
    serde_json::from_str(&value.stringify()).context("validated operation options")
}
impl SettingsRepository {
    pub async fn get_model_operation_route(
        &self,
        owner: &str,
        operation: &str,
        model: &str,
        worker: &str,
        route: Option<&str>,
    ) -> Result<Option<Value>> {
        let route = route.filter(|id| !id.is_empty());
        let rows = self.json_rows("SELECT jsonb_build_object('route',to_jsonb(r),'provider',to_jsonb(p),'catalog',to_jsonb(c)) FROM model_profiles m INNER JOIN model_routes r ON r.model_id=m.id INNER JOIN model_providers p ON p.id=r.provider_id AND p.owner_id=$1 LEFT JOIN provider_models c ON c.provider_id=r.provider_id AND (c.id=r.provider_model_id OR (r.provider_model_id IS NULL AND c.native_model_id=r.model_name)) WHERE m.owner_id=$1 AND m.operation=$2 AND m.id=$3 AND r.enabled=true AND ($4::text IS NULL OR r.id=$4) ORDER BY r.position ASC LIMIT 1", &[&owner,&operation,&model,&route]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let (route, provider, catalog) = (&row["route"], &row["provider"], &row["catalog"]);
        let observations = if let Some(id) = catalog["id"].as_str() {
            self.json_rows("SELECT to_jsonb(a) FROM provider_model_availability a WHERE provider_model_id=$1 ORDER BY (worker_id=$2) DESC NULLS LAST,updated_at DESC", &[&id,&worker]).await?
        } else {
            Vec::new()
        };
        let scoped = observations
            .iter()
            .find(|value| value["worker_id"].is_null() || value["worker_id"] == worker);
        let capabilities = scoped
            .map(|value| value["operation_capabilities"].clone())
            .filter(|value| !value.is_null())
            .unwrap_or_else(|| {
                if observations
                    .iter()
                    .any(|value| !value["worker_id"].is_null())
                {
                    json!({})
                } else {
                    catalog
                        .get("operation_capabilities")
                        .filter(|value| !value.is_null())
                        .cloned()
                        .unwrap_or(json!({}))
                }
            });
        Ok(Some(
            json!({"modelId":model,"routeId":route["id"],"modelName":route["model_name"],
            "adapter":route["operation_adapter"],"options":route["operation_options"],"capabilities":capabilities,"observedRevision":capabilities["embedding"]["modelRevision"],
            "provider":{"id":provider["id"],"name":provider["name"],"kind":provider["kind"],"baseUrl":provider["base_url"],
                "protectedApiKey":provider["protected_api_key"],"accountId":null,"credentialHomeKey":null,
                "maxConcurrentInference":provider["max_concurrent_inference"],"inferenceConfigRevision":provider["inference_config_revision"],
                "inferenceCatalogCreatedRevision":provider["inference_catalog_created_revision"]}}),
        ))
    }

    pub async fn get_model_reasoning_default(
        &self,
        owner: &str,
        model: &str,
    ) -> Result<Option<String>> {
        self.database.query("SELECT default_reasoning_effort FROM model_profiles WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&model, &owner]).await?.first().map(|row| row.get::<Option<String>>(0)).transpose().map(Option::flatten)
    }
    async fn owned_providers(&self, owner: &str, routes: &[WireValue]) -> Result<bool> {
        let providers: HashSet<JsString> = self
            .database
            .query(
                "SELECT id FROM model_providers WHERE owner_id=$1",
                &[&owner],
            )
            .await?
            .iter()
            .map(|row| row.get::<String>(0).map(JsString::from))
            .collect::<Result<_>>()?;
        Ok(routes.iter().all(|route| {
            route["providerId"]
                .as_js_string()
                .is_some_and(|id| providers.contains(id))
        }))
    }
    async fn model_from_settings(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        Ok(self.get_settings(owner).await?["models"]
            .as_array()
            .context("settings models")?
            .iter()
            .find(|model| model["id"] == id)
            .cloned())
    }

    pub async fn create_model_profile(
        &self,
        owner: &str,
        input: &WireValue,
    ) -> Result<Option<Value>> {
        let routes = input["routes"]
            .as_array()
            .context("validated model routes")?;
        if !self.owned_providers(owner, routes).await? {
            return Ok(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let name = string(input, "name")?.lossy().into_owned();
        let operation = input["operation"].as_str().unwrap_or("language").to_owned();
        if routes
            .iter()
            .any(|route| !adapter_matches(route["operationAdapter"].as_str(), &operation))
        {
            return Ok(None);
        }
        let profile_params = vec![
            WireValue::String(id.clone().into()),
            WireValue::String(owner.into()),
            input["name"].clone(),
            WireValue::String(operation.clone().into()),
        ];
        let original_routes = routes.clone();
        let routes = routes.iter().enumerate().map(|(position,route)| Ok(json!({
            "id":uuid::Uuid::new_v4().to_string(),"model_id":id,"provider_id":string(route,"providerId")?.lossy(),
            "model_name":string(route,"modelName")?.lossy(),"position":position,"enabled":route["enabled"].as_bool().context("route enabled")?,
            "operation_adapter":route["operationAdapter"].as_str(),"operation_options":options_json(&route["operationOptions"])? ,
        }))).collect::<Result<Vec<_>>>()?;
        let (route_query, route_params) = query_error::routes_insert(&routes, &original_routes);
        let owner = owner.to_owned();
        self.database.transaction({ let (owner,id)=(owner.clone(),id.clone()); move |tx| Box::pin(async move {
            query_error::context(tx.query("INSERT INTO model_profiles(id,owner_id,name,operation) VALUES($1,$2,$3,$4)", &[&id,&owner,&name,&operation]).await,"INSERT INTO model_profiles(id,owner_id,name,operation) VALUES($1,$2,$3,$4)",&profile_params)?;
            query_error::context(tx.query("INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled,operation_adapter,operation_options) SELECT id,model_id,provider_id,model_name,position,enabled,operation_adapter,operation_options FROM jsonb_to_recordset($1::jsonb) AS r(id text,model_id text,provider_id text,model_name text,position integer,enabled boolean,operation_adapter text,operation_options jsonb)", &[&json!(routes)]).await,&route_query,&route_params)?;
            Ok(())
        }) }).await?;
        self.model_from_settings(&owner, &id).await
    }

    pub async fn delete_model_profile(&self, owner: &str, model: &str) -> Result<bool> {
        let (owner, model) = (owner.to_owned(), model.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            let rows=tx.query("SELECT r.provider_model_id,m.operation FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 AND m.discovery_managed=true WHERE r.model_id=$2", &[&owner,&model]).await?;
            for row in rows {
                if let Some(id) = row.get::<Option<String>>(0)?.filter(|id| !id.is_empty()) {
                    let operation = row.get::<String>(1)?;
                    tx.query("INSERT INTO provider_model_suppressions(owner_id,provider_model_id,operation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", &[&owner,&id,&operation]).await?;
                }
            }
            tx.query("UPDATE user_settings SET default_custom_subagent_model=false,updated_at=$3 WHERE user_id=$1 AND default_subagent_model_id=$2 AND EXISTS (SELECT 1 FROM model_profiles m WHERE m.id=$2 AND m.owner_id=$1)", &[&owner,&model,&now()]).await?;
            Ok(!tx.query("DELETE FROM model_profiles WHERE id=$1 AND owner_id=$2 RETURNING id", &[&model,&owner]).await?.is_empty())
        })).await
    }

    pub async fn update_model_profile(
        &self,
        owner: &str,
        model: &str,
        input: &WireValue,
    ) -> Result<Option<Value>> {
        let routes = input["routes"]
            .as_array()
            .context("validated model routes")?;
        if !self.owned_providers(owner, routes).await? {
            return Ok(None);
        }
        let profiles = self
            .database
            .query(
                "SELECT operation FROM model_profiles WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&model, &owner],
            )
            .await?;
        let Some(profile) = profiles.first() else {
            return Ok(None);
        };
        let operation = profile.get::<String>(0)?;
        if input["operation"]
            .as_str()
            .is_some_and(|requested| requested != operation)
        {
            return Ok(None);
        };
        let existing = self
            .json_rows(
                "SELECT to_jsonb(r) FROM model_routes r WHERE model_id=$1",
                &[&model],
            )
            .await?;
        let existing: indexmap::IndexMap<JsString, Value> = existing
            .into_iter()
            .map(|row| Ok((JsString::from(row["id"].as_str().context("route ID")?), row)))
            .collect::<Result<_>>()?;
        if routes.iter().any(|route| {
            let adapter = route
                .get("operationAdapter")
                .map(|value| value.as_str())
                .unwrap_or_else(|| {
                    route_id(route)
                        .and_then(|id| existing.get(id))
                        .and_then(|old| old["operation_adapter"].as_str())
                });
            !adapter_matches(adapter, &operation)
        }) {
            return Ok(None);
        }
        let supplied: Vec<_> = routes.iter().filter_map(route_id).collect();
        let unique: HashSet<_> = supplied.iter().copied().collect();
        if unique.len() != supplied.len() || supplied.iter().any(|id| !existing.contains_key(*id)) {
            return Ok(None);
        }
        let invalidated: Vec<_> = existing
            .iter()
            .filter(|(id, old)| {
                routes
                    .iter()
                    .find(|r| r["id"].as_js_string() == Some(*id))
                    .is_none_or(|new| {
                        new["providerId"].as_js_string()
                            != old["provider_id"].as_str().map(JsString::from).as_ref()
                            || new["modelName"].as_js_string()
                                != old["model_name"].as_str().map(JsString::from).as_ref()
                            || new.get("operationAdapter").is_some_and(|value| {
                                value != &WireValue::from_serialize(&old["operation_adapter"])
                            })
                            || new.get("operationOptions").is_some_and(|value| {
                                let value = if value.is_null() {
                                    WireValue::from_serialize(&json!({}))
                                } else {
                                    value.clone()
                                };
                                value != WireValue::from_serialize(&old["operation_options"])
                            })
                    })
            })
            .map(|(id, _)| id.lossy().into_owned())
            .collect();
        let removed: Vec<_> = existing
            .keys()
            .filter(|id| !unique.contains(id))
            .map(|id| id.lossy().into_owned())
            .collect();
        let name = string(input, "name")?.lossy().into_owned();
        let original_name = input["name"].clone();
        let original_routes = routes.clone();
        let routes = routes
            .iter()
            .enumerate()
            .map(|(position, route)| {
                Ok((
                    route_id(route).map(|id| id.lossy().into_owned()),
                    string(route, "providerId")?.lossy().into_owned(),
                    string(route, "modelName")?.lossy().into_owned(),
                    i32::try_from(position)?,
                    route["enabled"].as_bool().context("route enabled")?,
                    route
                        .get("operationAdapter")
                        .map(|value| value.as_str().map(str::to_owned)),
                    route
                        .get("operationOptions")
                        .map(options_json)
                        .transpose()?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let model = model.to_owned();
        self.database.transaction({let model=model.clone();move |tx| Box::pin(async move {
            let at=now();
            query_error::context(tx.query("UPDATE model_profiles SET name=$2,updated_at=$3 WHERE id=$1", &[&model,&name,&at]).await,"update \"model_profiles\" set \"name\" = $1, \"updated_at\" = $2 where \"model_profiles\".\"id\" = $3",&[original_name,WireValue::String(crate::auth::iso(at).into()),WireValue::String(model.clone().into())])?;
            for route in invalidated { tx.query("UPDATE chat_runtime_sessions SET codex_thread_id=NULL,status='detached',updated_at=$2 WHERE model_route_id=$1", &[&route,&now()]).await?; }
            for route in removed { tx.query("DELETE FROM model_routes WHERE id=$1", &[&route]).await?; }
            tx.query("UPDATE model_routes SET position=position+1000 WHERE model_id=$1", &[&model]).await?;
            for ((id,provider,name,position,enabled,adapter,options),original) in routes.into_iter().zip(original_routes) {
                if let Some(id)=id {
                    let at=now();
                    query_error::context(tx.query("UPDATE model_routes SET provider_id=$2,model_name=$3,position=$4,enabled=$5,updated_at=$6 WHERE id=$1", &[&id,&provider,&name,&position,&enabled,&at]).await,"update \"model_routes\" set \"provider_id\" = $1, \"model_name\" = $2, \"position\" = $3, \"enabled\" = $4, \"updated_at\" = $5 where \"model_routes\".\"id\" = $6",&[original["providerId"].clone(),original["modelName"].clone(),WireValue::from_serialize(&position),WireValue::Bool(enabled),WireValue::String(crate::auth::iso(at).into()),original["id"].clone()])?;
                    if adapter.is_some() || options.is_some() {
                        tx.query("UPDATE model_routes SET operation_adapter=CASE WHEN $2 THEN $3 ELSE operation_adapter END,operation_options=CASE WHEN $4 THEN $5 ELSE operation_options END WHERE id=$1", &[&id,&adapter.is_some(),&adapter.flatten(),&options.is_some(),&options.unwrap_or_else(||json!({}))]).await?;
                    }
                } else {
                    let id=uuid::Uuid::new_v4().to_string();
                    let (query,params)=query_error::routes_insert(&[json!({"id":id,"model_id":model,"position":position})],&[original]);
                    query_error::context(tx.query("INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled,operation_adapter,operation_options) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", &[&id,&model,&provider,&name,&position,&enabled,&adapter.flatten(),&options.unwrap_or_else(||json!({}))]).await,&query,&params)?;
                }
            }
            Ok(())
        })}).await?;
        self.model_from_settings(owner, &model).await
    }

    pub async fn list_provider_account_runtimes(
        &self,
        owner: &str,
        provider: &str,
        worker: &str,
        model: Option<&str>,
    ) -> Result<Vec<Value>> {
        let accounts=self.json_rows("SELECT jsonb_build_object('account',to_jsonb(a),'binding',to_jsonb(b)) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id AND p.owner_id=$1 AND p.kind IN ('chatgpt','grok') LEFT JOIN model_provider_account_workers b ON b.account_id=a.id AND b.worker_id=$3 WHERE a.provider_id=$2 ORDER BY a.position ASC", &[&owner,&provider,&worker]).await?;
        let availability = if let Some(model) = model.filter(|id| !id.is_empty()) {
            self.json_rows("SELECT to_jsonb(a) FROM provider_model_availability a WHERE provider_model_id=$1 AND (worker_id IS NULL OR worker_id=$2)", &[&model,&worker]).await?
        } else {
            vec![]
        };
        let mut states = HashMap::new();
        for row in &availability {
            if let Some(account) = row["provider_account_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                && (!states.contains_key(account) || row["worker_id"].is_null())
            {
                states.insert(account, row["state"].clone());
            }
        }
        Ok(accounts.iter().map(|row| {
            let account=&row["account"];
            let percent=account["weekly_usage_used_basis_points"].as_f64().map(|value| value/100.0);
            json!({"credits":account["credits"],"accountId":account["id"],"credentialState":account["credential_state"],"credentialHomeKey":account["credential_home_key"],"enabled":account["enabled"],"legacyWorkerAuthenticated":row["binding"]["auth_state"]=="signed-in","modelAvailability":account["id"].as_str().and_then(|id| states.get(id)),"position":account["position"],"weeklyUsageUsedPercent":percent})
        }).collect())
    }
}
