use super::{
    catalog_hash,
    repository::{SettingsRepository, catalog_entry, date},
};
use crate::{
    auth::now,
    wire::{JsString, Value as WireValue},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const BATCH: usize = 500;

pub fn metadata_snapshot(model: &WireValue) -> Result<String> {
    catalog_hash::snapshot(model)
}
const FIELDS: &[(&str, &str, bool)] = &[
    ("nativeModelId", "native_model_id", true),
    ("canonicalModelId", "canonical_model_id", true),
    ("displayName", "display_name", true),
    ("description", "description", true),
    ("contextWindow", "context_window", false),
    ("maxOutputTokens", "max_output_tokens", false),
    ("inputModalities", "input_modalities", false),
    ("outputModalities", "output_modalities", false),
    ("supportsTools", "supports_tools", false),
    ("supportsParallelTools", "supports_parallel_tools", false),
    (
        "supportsStructuredOutput",
        "supports_structured_output",
        false,
    ),
    ("supportsVision", "supports_vision", false),
    ("supportsReasoning", "supports_reasoning", false),
    (
        "supportedReasoningEfforts",
        "supported_reasoning_efforts",
        false,
    ),
    ("defaultReasoningEffort", "default_reasoning_effort", true),
    ("reasoningMandatory", "reasoning_mandatory", false),
    ("family", "family", true),
    ("parameterSize", "parameter_size", true),
    ("quantization", "quantization", true),
    ("digest", "digest", true),
    ("metadataSource", "metadata_source", true),
    (
        "matchConfidenceBasisPoints",
        "match_confidence_basis_points",
        false,
    ),
    ("hidden", "hidden", false),
    ("isDefault", "is_default", false),
    ("rawMetadata", "raw_metadata", false),
];
fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn default(field: &str) -> WireValue {
    match field {
        "hidden" | "isDefault" => WireValue::Bool(false),
        "inputModalities" | "outputModalities" => WireValue::from_serialize(&json!(["text"])),
        "supportedReasoningEfforts" => WireValue::Array(vec![]),
        "rawMetadata" => WireValue::object([] as [(&str, WireValue); 0]),
        _ => WireValue::Null,
    }
}
fn model_row(provider: &str, model: &WireValue) -> WireValue {
    let mut row = WireValue::object([
        ("id", WireValue::String(uuid().into())),
        ("provider_id", WireValue::String(provider.into())),
    ]);
    for (wire, field, text) in FIELDS {
        let mut value = model.get(wire).cloned().unwrap_or_else(|| default(wire));
        if *text && let Some(value_text) = value.as_js_string() {
            value = WireValue::String(value_text.lossy().into_owned().into());
        }
        row[field] = value;
    }
    row
}
fn availability(row: &Value) -> Result<Value> {
    Ok(
        json!({"id":row["id"],"providerModelId":row["provider_model_id"],"scopeKey":row["scope_key"],"workerId":row["worker_id"],"providerAccountId":row["provider_account_id"],"state":row["state"],"lastSeenAt":date(&row["last_seen_at"])?,"updatedAt":date(&row["updated_at"])?}),
    )
}
fn sync_state(row: &Value) -> Result<Value> {
    Ok(
        json!({"id":row["id"],"providerId":row["provider_id"],"scopeKey":row["scope_key"],"workerId":row["worker_id"],"providerAccountId":row["provider_account_id"],"status":row["status"],"error":row["error_code"],"etag":row["etag"],"refreshStartedAt":date(&row["refresh_started_at"])?,"lastSuccessAt":date(&row["last_success_at"])?,"updatedAt":date(&row["updated_at"])?}),
    )
}

#[derive(Clone)]
pub struct CatalogUpdate {
    pub models: Vec<WireValue>,
    pub availability_scope: String,
    pub available: HashSet<JsString>,
    pub auto_create: bool,
    pub auto_create_native_ids: Option<HashSet<JsString>>,
    pub worker_id: Option<String>,
    pub account_id: Option<String>,
    pub default_native_id: Option<String>,
}
impl SettingsRepository {
    pub async fn list_provider_catalog_targets(&self, owner: &str) -> Result<Vec<Value>> {
        self.json_rows("SELECT jsonb_build_object('id',id,'kind',kind,'baseUrl',base_url) FROM model_providers WHERE owner_id=$1 ORDER BY created_at ASC", &[&owner]).await
    }
    pub async fn list_provider_refresh_targets(&self, owner: &str) -> Result<Vec<Value>> {
        let rows=self.json_rows("SELECT jsonb_build_object('provider',to_jsonb(p),'account',to_jsonb(a)) FROM model_providers p LEFT JOIN model_provider_accounts a ON a.provider_id=p.id WHERE p.owner_id=$1 ORDER BY p.created_at ASC,a.position ASC", &[&owner]).await?;
        let mut targets: indexmap::IndexMap<String, Value> = indexmap::IndexMap::new();
        for row in rows {
            let p = &row["provider"];
            let id = p["id"].as_str().context("provider ID")?.to_owned();
            let target=targets.entry(id).or_insert_with(||json!({"accounts":[],"baseUrl":p["base_url"],"id":p["id"],"kind":p["kind"],"name":p["name"]}));
            let a = &row["account"];
            if a["id"].as_str().is_some_and(|id| !id.is_empty()) {
                target["accounts"]
                    .as_array_mut()
                    .expect("target accounts")
                    .push(json!({"enabled":a["enabled"],"id":a["id"],"planType":a["plan_type"]}));
            }
        }
        Ok(targets.into_values().collect())
    }
    pub async fn set_provider_catalog_sync_state(
        &self,
        provider: &str,
        input: &Value,
    ) -> Result<()> {
        let scope = input["scopeKey"].as_str().context("catalog scope")?;
        let status = input["status"].as_str().context("catalog state")?;
        let mut record = json!({"scope_key":scope,"status":status});
        let mut updates = vec!["status=excluded.status".to_owned(), "updated_at=$4".into()];
        for (wire, field) in [
            ("errorCode", "error_code"),
            ("etag", "etag"),
            ("refreshStartedAt", "refresh_started_at"),
            ("lastSuccessAt", "last_success_at"),
            ("workerId", "worker_id"),
            ("providerAccountId", "provider_account_id"),
        ] {
            if let Some(value) = input.get(wire) {
                record[field] = value.clone();
                updates.push(format!("{field}=excluded.{field}"));
            }
        }
        let id = uuid();
        let at = now();
        let result = self.database.query(&format!("INSERT INTO provider_catalog_sync_states(id,provider_id,scope_key,status,error_code,etag,refresh_started_at,last_success_at,worker_id,provider_account_id,updated_at) SELECT $1,$2,s.scope_key,s.status,s.error_code,s.etag,s.refresh_started_at,s.last_success_at,s.worker_id,s.provider_account_id,$4 FROM jsonb_populate_record(NULL::provider_catalog_sync_states,$3::jsonb) s ON CONFLICT(provider_id,scope_key) DO UPDATE SET {}",updates.join(",")), &[&id,&provider,&record,&at]).await;
        if result.is_err() {
            let (query, params) = super::query_error::catalog_sync(&id, provider, input, at);
            super::query_error::context(result, &query, &params)?;
        }
        Ok(())
    }
    pub async fn get_provider_model_catalog(
        &self,
        owner: &str,
        provider: &str,
        stale: bool,
    ) -> Result<Option<Value>> {
        if self
            .database
            .query(
                "SELECT id FROM model_providers WHERE id=$2 AND owner_id=$1 LIMIT 1",
                &[&owner, &provider],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let params: crate::database::Parameters<'_> = &[&provider];
        let (models,available,states)=tokio::try_join!(
            self.json_rows("SELECT to_jsonb(c) FROM provider_models c WHERE provider_id=$1 ORDER BY display_name ASC",params),
            self.json_rows("SELECT to_jsonb(a) FROM provider_model_availability a INNER JOIN provider_models c ON c.id=a.provider_model_id AND c.provider_id=$1",params),
            self.json_rows("SELECT to_jsonb(s) FROM provider_catalog_sync_states s WHERE provider_id=$1 ORDER BY scope_key ASC",params),
        )?;
        Ok(Some(
            json!({"providerId":provider,"models":models.iter().map(catalog_entry).collect::<Result<Vec<_>>>()?,"availability":available.iter().map(availability).collect::<Result<Vec<_>>>()?,"syncStates":states.iter().map(sync_state).collect::<Result<Vec<_>>>()?,"servedStale":stale}),
        ))
    }
    pub async fn list_provider_model_availability(
        &self,
        owner: &str,
        provider: &str,
        model: &str,
    ) -> Result<Vec<Value>> {
        self.json_rows("SELECT to_jsonb(a) FROM provider_model_availability a INNER JOIN provider_models c ON c.id=a.provider_model_id AND c.id=$3 AND c.provider_id=$2 INNER JOIN model_providers p ON p.id=c.provider_id AND p.owner_id=$1", &[&owner,&provider,&model]).await?.iter().map(availability).collect()
    }
    pub async fn reconcile_provider_model_catalog(
        &self,
        owner: &str,
        provider: &str,
        input: CatalogUpdate,
    ) -> Result<bool> {
        if self
            .database
            .query(
                "SELECT id FROM model_providers WHERE id=$2 AND owner_id=$1 LIMIT 1",
                &[&owner, &provider],
            )
            .await?
            .is_empty()
        {
            return Ok(false);
        }
        let (owner, provider) = (owner.to_owned(), provider.to_owned());
        let at = now();
        self.database.transaction(move |tx|Box::pin(async move {
            for batch in input.models.chunks(BATCH) {
                let rows=batch.iter().map(|model|Ok(json!({"id":uuid(),"source":model["metadataSource"].as_js_string().context("catalog metadata source")?.lossy(),"hash":catalog_hash::snapshot(model)?}))).collect::<Result<Vec<_>>>()?;
                tx.query("INSERT INTO provider_model_catalog_snapshots(id,owner_id,provider_id,provider_account_id,worker_id,availability_scope,metadata_source,metadata_hash,observed_at) SELECT s.id,$2,$3,$4,$5,$6,s.source,s.hash,$7 FROM jsonb_to_recordset($1::jsonb) AS s(id text,source text,hash text) ON CONFLICT DO NOTHING", &[&json!(rows),&owner,&provider,&input.account_id,&input.worker_id,&input.availability_scope,&at]).await?;
            }
            let columns=FIELDS.iter().map(|(_,field,_)|*field).collect::<Vec<_>>();
            let updates=columns.iter().map(|field|format!("{field}=excluded.{field}")).collect::<Vec<_>>().join(",");
            for batch in input.models.chunks(BATCH) {
                let rows=WireValue::Array(batch.iter().map(|model|model_row(&provider,model)).collect());
                tx.query(&format!("INSERT INTO provider_models(id,provider_id,{},last_seen_at,updated_at) SELECT m.id,m.provider_id,{},$2,$2 FROM jsonb_populate_recordset(NULL::provider_models,$1::text::jsonb) m ON CONFLICT(provider_id,native_model_id) DO UPDATE SET {updates},last_seen_at=$2,updated_at=$2",columns.join(","),columns.iter().map(|field|format!("m.{field}")).collect::<Vec<_>>().join(",")), &[&rows.stringify(),&at]).await?;
            }
            let rows=tx.query("SELECT id,native_model_id FROM provider_models WHERE provider_id=$1", &[&provider]).await?;
            let models=rows.iter().map(|row|Ok((row.get::<String>(0)?,row.get::<String>(1)?))).collect::<Result<Vec<_>>>()?;
            if models.is_empty(){return Ok(())}
            let available=models.iter().filter(|(_,name)|input.available.contains(&JsString::from(name.as_str()))).map(|(id,_)|id.clone()).collect::<Vec<_>>();
            for ids in available.chunks(BATCH) {
                tx.query("UPDATE model_routes r SET provider_model_id=m.id,updated_at=$3 FROM provider_models m WHERE r.provider_id=$1 AND m.provider_id=$1 AND m.id=ANY($2::text[]) AND r.model_name=m.native_model_id AND r.provider_model_id IS NULL", &[&provider,&ids,&at]).await?;
            }
            for batch in models.chunks(BATCH) {
                let entries=batch.iter().map(|(id,name)|json!({"id":uuid(),"model":id,"state":if input.available.contains(&JsString::from(name.as_str())){"available"}else{"unavailable"}})).collect::<Vec<_>>();
                tx.query("INSERT INTO provider_model_availability(id,provider_model_id,scope_key,worker_id,provider_account_id,state,last_seen_at,updated_at) SELECT a.id,a.model,$2,$3,$4,a.state,$5,$5 FROM jsonb_to_recordset($1::jsonb) AS a(id text,model text,state text) ON CONFLICT(provider_model_id,scope_key) DO UPDATE SET state=excluded.state,worker_id=excluded.worker_id,provider_account_id=excluded.provider_account_id,last_seen_at=$5,updated_at=$5", &[&json!(entries),&input.availability_scope,&input.worker_id,&input.account_id,&at]).await?;
            }
            if input.auto_create {
                let suppressions=tx.query("SELECT provider_model_id FROM provider_model_suppressions WHERE owner_id=$1", &[&owner]).await?;
                let suppressed=suppressions.iter().map(|row|row.get::<String>(0)).collect::<Result<HashSet<_>>>()?;
                let routes=tx.query("SELECT r.model_name FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 WHERE r.provider_id=$2", &[&owner,&provider]).await?;
                let routed=routes.iter().map(|row|row.get::<String>(0)).collect::<Result<HashSet<_>>>()?;
                let by_name=input.models.iter().map(|model|Ok((model["nativeModelId"].as_js_string().context("native model ID")?,&model["canonicalModelId"]))).collect::<Result<HashMap<_,_>>>()?;
                let selected=input.auto_create_native_ids.as_ref().unwrap_or(&input.available);
                let discovered=models.iter().filter(|(id,name)|selected.contains(&JsString::from(name.as_str())) && !suppressed.contains(id) && !routed.contains(name)).collect::<Vec<_>>();
                for batch in discovered.chunks(BATCH) {
                    let values=WireValue::Array(batch.iter().map(|(id,name)|{
                        let canonical=by_name.get(&JsString::from(name.as_str())).copied().cloned().unwrap_or(WireValue::Null);
                        let canonical=canonical.as_js_string().map(|value|WireValue::String(value.lossy().into_owned().into())).unwrap_or(canonical);
                        WireValue::object([("id",WireValue::String(format!("discovered:model:{id}").into())),("name",WireValue::String(name.as_str().into())),("canonical",canonical)])
                    }).collect());
                    tx.query("INSERT INTO model_profiles(id,owner_id,name,canonical_model_id,discovery_managed) SELECT m.id,$2,m.name,m.canonical,true FROM jsonb_to_recordset($1::text::jsonb) AS m(id text,name text,canonical text) ON CONFLICT(id) DO NOTHING", &[&values.stringify(),&owner]).await?;
                }
                for batch in discovered.chunks(BATCH) {
                    let values=batch.iter().map(|(id,name)|json!({"id":format!("discovered:route:{id}"),"profile":format!("discovered:model:{id}"),"model":id,"name":name})).collect::<Vec<_>>();
                    tx.query("INSERT INTO model_routes(id,model_id,provider_id,provider_model_id,model_name,position,enabled,discovery_managed) SELECT r.id,r.profile,$2,r.model,r.name,0,true,true FROM jsonb_to_recordset($1::jsonb) AS r(id text,profile text,model text,name text) ON CONFLICT(id) DO NOTHING", &[&json!(values),&provider]).await?;
                }
                if let Some(default)=input.default_native_id.filter(|name|!name.is_empty()) {
                    let routes=tx.query("SELECT r.model_id FROM model_routes r INNER JOIN provider_models m ON m.id=r.provider_model_id AND m.provider_id=$1 AND m.native_model_id=$2 LIMIT 1", &[&provider,&default]).await?;
                    if let Some(route)=routes.first(){tx.query("UPDATE user_settings SET default_model_id=$2,updated_at=$3 WHERE user_id=$1 AND default_model_id IS NULL", &[&owner,&route.get::<String>(0)?,&at]).await?;}
                }
            }
            Ok(())
        })).await?;
        Ok(true)
    }
}
