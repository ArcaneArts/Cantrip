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
impl SettingsRepository {
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
        let profile_params = vec![
            WireValue::String(id.clone().into()),
            WireValue::String(owner.into()),
            input["name"].clone(),
        ];
        let original_routes = routes.clone();
        let routes = routes.iter().enumerate().map(|(position,route)| Ok(json!({
            "id":uuid::Uuid::new_v4().to_string(),"model_id":id,"provider_id":string(route,"providerId")?.lossy(),
            "model_name":string(route,"modelName")?.lossy(),"position":position,"enabled":route["enabled"].as_bool().context("route enabled")?,
        }))).collect::<Result<Vec<_>>>()?;
        let (route_query, route_params) = query_error::routes_insert(&routes, &original_routes);
        let owner = owner.to_owned();
        self.database.transaction({ let (owner,id)=(owner.clone(),id.clone()); move |tx| Box::pin(async move {
            query_error::context(tx.query("INSERT INTO model_profiles(id,owner_id,name) VALUES($1,$2,$3)", &[&id,&owner,&name]).await,query_error::PROFILE_INSERT,&profile_params)?;
            query_error::context(tx.query("INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) SELECT id,model_id,provider_id,model_name,position,enabled FROM jsonb_to_recordset($1::jsonb) AS r(id text,model_id text,provider_id text,model_name text,position integer,enabled boolean)", &[&json!(routes)]).await,&route_query,&route_params)?;
            Ok(())
        }) }).await?;
        self.model_from_settings(&owner, &id).await
    }

    pub async fn delete_model_profile(&self, owner: &str, model: &str) -> Result<bool> {
        let (owner, model) = (owner.to_owned(), model.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            let rows=tx.query("SELECT r.provider_model_id FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 AND m.discovery_managed=true WHERE r.model_id=$2", &[&owner,&model]).await?;
            let ids=rows.iter().map(|row| row.get::<Option<String>>(0)).collect::<Result<Vec<_>>>()?.into_iter().flatten().filter(|id| !id.is_empty()).collect::<Vec<_>>();
            if !ids.is_empty() {
                tx.query("INSERT INTO provider_model_suppressions(owner_id,provider_model_id) SELECT $1,id FROM unnest($2::text[]) AS id ON CONFLICT DO NOTHING", &[&owner,&ids]).await?;
            }
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
        if self
            .database
            .query(
                "SELECT id FROM model_profiles WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&model, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
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
            for ((id,provider,name,position,enabled),original) in routes.into_iter().zip(original_routes) {
                if let Some(id)=id {
                    let at=now();
                    query_error::context(tx.query("UPDATE model_routes SET provider_id=$2,model_name=$3,position=$4,enabled=$5,updated_at=$6 WHERE id=$1", &[&id,&provider,&name,&position,&enabled,&at]).await,"update \"model_routes\" set \"provider_id\" = $1, \"model_name\" = $2, \"position\" = $3, \"enabled\" = $4, \"updated_at\" = $5 where \"model_routes\".\"id\" = $6",&[original["providerId"].clone(),original["modelName"].clone(),WireValue::from_serialize(&position),WireValue::Bool(enabled),WireValue::String(crate::auth::iso(at).into()),original["id"].clone()])?;
                } else {
                    let id=uuid::Uuid::new_v4().to_string();
                    let (query,params)=query_error::routes_insert(&[json!({"id":id,"model_id":model,"position":position})],&[original]);
                    query_error::context(tx.query("INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES($1,$2,$3,$4,$5,$6)", &[&id,&model,&provider,&name,&position,&enabled]).await,&query,&params)?;
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
