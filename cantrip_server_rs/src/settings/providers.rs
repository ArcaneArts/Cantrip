use super::repository::{SettingsRepository, account_summary, provider_summary};
use crate::{
    auth::now,
    wire::{JsString, Value as WireValue},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::sync::OnceLock;

fn account_kind(kind: &str) -> bool {
    kind == "chatgpt" || kind == "grok"
}
fn label(kind: &str) -> &'static str {
    if kind == "grok" { "Grok" } else { "ChatGPT" }
}
fn text<'a>(input: &'a WireValue, field: &str) -> Result<&'a JsString> {
    input[field]
        .as_js_string()
        .context("validated provider text")
}
fn json_value(input: &WireValue) -> Result<Value> {
    Ok(serde_json::from_str(&input.stringify())?)
}

pub fn normalize_responses_base_url(value: &str) -> Result<String> {
    static ENDPOINT: OnceLock<regex::Regex> = OnceLock::new();
    let mut url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("Invalid URL"))?;
    url.set_query(None);
    url.set_fragment(None);
    let path = ENDPOINT
        .get_or_init(|| regex::Regex::new(r"(?i)/(?:chat/completions|chat|responses)/?$").unwrap())
        .replace(url.path(), "");
    let path = path.trim_end_matches('/').to_owned();
    if !url.cannot_be_a_base() {
        url.set_path(&path);
    }
    if url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("openrouter.ai"))
        && url.path() == "/"
    {
        url.set_path("/api/v1");
    }
    Ok(url
        .to_string()
        .strip_suffix('/')
        .unwrap_or(url.as_str())
        .to_owned())
}

impl SettingsRepository {
    pub async fn create_model_provider(&self, owner: &str, input: &WireValue) -> Result<Value> {
        let id = input["id"]
            .as_js_string()
            .map(|id| id.lossy().into_owned())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let kind = text(input, "kind")?.lossy().into_owned();
        let name = text(input, "name")?.lossy().into_owned();
        let base = normalize_responses_base_url(&text(input, "baseUrl")?.lossy())?;
        let reserve = input["weeklyUsageReservePercent"].as_i64().unwrap_or(3);
        let protected_key = json_value(&input["protectedApiKey"])?;
        let initial = input["initialAccount"].clone();
        let insert_context = super::query_error::provider_insert(&id, owner, input, &base, reserve);
        let owner = owner.to_owned();
        self.database.transaction(move |tx| Box::pin(async move {
            if account_kind(&kind) && !tx.query("SELECT id FROM model_providers WHERE owner_id=$1 AND kind=$2 LIMIT 1", &[&owner,&kind]).await?.is_empty() {
                anyhow::bail!("A {} provider already exists. Add another sign-in to that provider instead.",label(&kind));
            }
            let rows=super::query_error::context(tx.query("INSERT INTO model_providers(id,owner_id,name,kind,base_url,weekly_usage_reserve_percent,protected_api_key) VALUES($1,$2,$3,$4,$5,$6::text::integer,$7) RETURNING to_jsonb(model_providers)", &[&id,&owner,&name,&kind,&base,&reserve.to_string(),&protected_key.as_object().map(|_| &protected_key)]).await, &insert_context.0, &insert_context.1)?;
            let provider=rows.first().context("Database returned no row after creating a model provider.")?.get::<Value>(0)?;
            if !account_kind(&kind) { return provider_summary(&provider,vec![],None,None) }
            if initial.is_null() { anyhow::bail!("The provider is missing its protected account label.") }
            let account_id=text(&initial,"id")?.lossy();
            let protected_label=json_value(&initial["protectedLabel"])?;
            let reference=super::query_error::provider_initial_account(&id,&initial);
            let rows=super::query_error::context(tx.query("INSERT INTO model_provider_accounts(id,provider_id,protected_label,position,credential_home_key) VALUES($1,$2,$3,0,$2) RETURNING to_jsonb(model_provider_accounts)", &[&account_id.as_ref(),&id,&protected_label]).await, &reference.0, &reference.1)?;
            let account=rows.first().with_context(|| format!("Database returned no row after creating a {} account.",label(&kind)))?.get::<Value>(0)?;
            provider_summary(&provider,vec![account_summary(&account,&[])?],None,None)
        })).await
    }

    pub async fn get_model_provider(&self, owner: &str, provider: &str) -> Result<Option<Value>> {
        self.json_rows(
            "SELECT to_jsonb(p) FROM model_providers p WHERE id=$1 AND owner_id=$2 LIMIT 1",
            &[&provider, &owner],
        )
        .await?
        .first()
        .map(|row| provider_summary(row, vec![], None, None))
        .transpose()
    }
    pub async fn get_provider_catalog_runtime(
        &self,
        owner: &str,
        provider: &str,
    ) -> Result<Option<Value>> {
        Ok(self.json_rows("SELECT to_jsonb(p) FROM model_providers p WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&provider,&owner]).await?.first().map(|row| json!({"id":row["id"],"ownerId":row["owner_id"],"kind":row["kind"],"baseUrl":row["base_url"],"protectedApiKey":row["protected_api_key"]})))
    }
    pub async fn has_model_routes_for_provider(&self, owner: &str, provider: &str) -> Result<bool> {
        Ok(!self.database.query("SELECT r.id FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 WHERE r.provider_id=$2 LIMIT 1", &[&owner,&provider]).await?.is_empty())
    }
    pub async fn delete_model_provider(&self, owner: &str, provider: &str) -> Result<bool> {
        Ok(!self
            .database
            .query(
                "DELETE FROM model_providers WHERE id=$1 AND owner_id=$2 RETURNING id",
                &[&provider, &owner],
            )
            .await?
            .is_empty())
    }
    pub async fn update_model_provider(
        &self,
        owner: &str,
        provider: &str,
        input: &WireValue,
    ) -> Result<Option<Value>> {
        let Some(current) = self.get_model_provider(owner, provider).await? else {
            return Ok(None);
        };
        let kind = text(input, "kind")?.lossy();
        if current["kind"] != kind.as_ref() {
            anyhow::bail!("Provider type cannot be changed. Create a new provider instead.")
        }
        let name = text(input, "name")?.lossy();
        let base = normalize_responses_base_url(&text(input, "baseUrl")?.lossy())?;
        let mut values = json!({"name":name,"kind":kind,"base_url":base});
        let mut sets = vec![
            "name=v.name",
            "kind=v.kind",
            "base_url=v.base_url",
            "updated_at=$3",
        ];
        if let Some(reserve) = input.get("weeklyUsageReservePercent") {
            values["weekly_usage_reserve_percent"] = json_value(reserve)?;
            sets.push("weekly_usage_reserve_percent=v.weekly_usage_reserve_percent");
        }
        if let Some(key) = input.get("protectedApiKey") {
            values["protected_api_key"] = json_value(key)?;
            sets.push("protected_api_key=v.protected_api_key");
        }
        let at = now();
        let reference = super::query_error::provider_update(owner, provider, input, &base, at);
        let rows=super::query_error::context(self.json_rows(&format!("UPDATE model_providers p SET {} FROM jsonb_populate_record(NULL::model_providers,$2::jsonb) v WHERE p.id=$1 AND p.owner_id=$4 RETURNING to_jsonb(p)",sets.join(",")), &[&provider,&values,&at,&owner]).await, &reference.0, &reference.1)?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let routes = self
            .database
            .query(
                "SELECT id FROM model_routes WHERE provider_id=$1",
                &[&provider],
            )
            .await?;
        for route in routes {
            let route = route.get::<String>(0)?;
            let at = now();
            let reference = super::query_error::provider_detach(&route, at);
            super::query_error::context(self.database.query("UPDATE chat_runtime_sessions SET codex_thread_id=NULL,status='detached',updated_at=$2 WHERE model_route_id=$1", &[&route,&at]).await, &reference.0, &reference.1)?;
        }
        Ok(Some(provider_summary(row, vec![], None, None)?))
    }
}
