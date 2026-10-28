use super::{
    agent_time::{self, Interval, Summary},
    enrichment,
};
use crate::{
    auth::now,
    database::{Database, Parameters},
    wire::{self, JsString},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

pub const DEFAULT_OLLAMA_PROVIDER_ID: &str = "00000000-0000-0000-0000-000000000010";
pub const DEFAULT_MODEL_ID: &str = "00000000-0000-0000-0000-000000000020";
pub const DEFAULT_MODEL_ROUTE_ID: &str = "00000000-0000-0000-0000-000000000021";

const PREFERENCES: &[&str] = &[
    "computerUseEnabled",
    "computerUseEffects",
    "computerUseEffectsRevision",
    "protectedComputerUseCursor",
    "theme",
    "highContrast",
    "proMode",
    "proModeOpacity",
    "contentGutters",
    "eliteMode",
    "eliteRevealConfig",
    "sidebarWidth",
    "workspaceLayoutProfile",
    "showChatPromptOverlay",
    "randomAgentNames",
    "autoNameTasks",
    "autoNameChats",
    "labelingModelId",
    "desktopFrameRate",
    "desktopStreamQuality",
    "defaultModelId",
    "defaultReasoningEffort",
    "defaultCustomSubagentModel",
    "defaultSubagentModelId",
    "defaultSubagentReasoningEffort",
    "defaultPermissionProfileId",
    "defaultChatModelId",
    "defaultChatReasoningEffort",
    "defaultChatPermissionProfileId",
    "defaultWorkerId",
    "lastAppMode",
    "lastIdeProjectId",
    "lastIdeWorkspaceId",
    "lastStandaloneChatId",
    "destinationRevision",
    "automaticReplicaProvisioning",
    "automaticReplicaSynchronization",
    "mobileProjectTabConfigurations",
];
const DESTINATION: &[&str] = &[
    "lastAppMode",
    "lastIdeProjectId",
    "lastIdeWorkspaceId",
    "lastStandaloneChatId",
];

fn column(name: &str) -> String {
    let mut result = String::new();
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            result.push('_');
            result.push(ch.to_ascii_lowercase());
        } else {
            result.push(ch);
        }
    }
    result
}
fn project(row: &Value, names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .map(|name| ((*name).into(), row[column(name)].clone()))
            .collect(),
    )
}
pub(super) fn date(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    // PostgreSQL JSON uses T, while the driver's timestamp text uses a space.
    // Node's Date parser treats expanded unsigned years differently in the two
    // forms. Match the driver form before formatting the resulting instant.
    let text = value
        .as_str()
        .context("stored timestamp")?
        .replacen('T', " ", 1);
    let milliseconds = wire::date_milliseconds(&text.into()).context("Invalid time value")?;
    Ok(json!(
        wire::date_iso_milliseconds(milliseconds).context("Invalid time value")?
    ))
}
fn dates(output: &mut Value, row: &Value, names: &[&str]) -> Result<()> {
    for name in names {
        output[*name] = date(&row[column(name)])?;
    }
    Ok(())
}
fn percentage(value: &Value, scale: f64) -> Value {
    value.as_f64().map_or(Value::Null, |v| json!(v / scale))
}
// Invalid Date is distinct from a missing completion: it closes a running
// interval but contributes no duration, exactly as the Node repository does.
fn stored_date(value: Option<String>) -> Option<f64> {
    value.map(|value| {
        wire::date_milliseconds(&JsString::from(value)).map_or(f64::NAN, |ms| ms as f64)
    })
}
fn token_usage(input: f64, output: f64) -> Value {
    json!({"inputTokens":input,"outputTokens":output,"totalTokens":input+output})
}
pub(super) fn account_summary(account: &Value, bindings: &[Value]) -> Result<Value> {
    let mut output = project(
        account,
        &[
            "id",
            "providerId",
            "protectedLabel",
            "planType",
            "position",
            "enabled",
            "credits",
            "credentialState",
        ],
    );
    output["weeklyUsageUsedPercent"] =
        percentage(&account["weekly_usage_used_basis_points"], 100.0);
    dates(
        &mut output,
        account,
        &[
            "creditsObservedAt",
            "weeklyUsageResetsAt",
            "authLastSyncedAt",
            "createdAt",
            "updatedAt",
        ],
    )?;
    output["workerBindings"] = Value::Array(
        bindings
            .iter()
            .filter(|binding| binding["account_id"] == account["id"])
            .map(|binding| {
                let mut result = project(binding, &["workerId", "authState"]);
                result["weeklyUsageUsedPercent"] =
                    percentage(&binding["weekly_usage_used_basis_points"], 100.0);
                dates(
                    &mut result,
                    binding,
                    &["weeklyUsageResetsAt", "lastSyncedAt"],
                )?;
                Ok(result)
            })
            .collect::<Result<_>>()?,
    );
    Ok(output)
}
pub(super) fn provider_summary(
    provider: &Value,
    accounts: Vec<Value>,
    usage: Option<&Value>,
    time: Option<&Summary>,
) -> Result<Value> {
    let mut output = project(
        provider,
        &["id", "name", "kind", "baseUrl", "weeklyUsageReservePercent"],
    );
    output["hasApiKey"] = json!(!provider["protected_api_key"].is_null());
    output["accounts"] = json!(accounts);
    output["tokenUsage"] = usage.cloned().unwrap_or_else(|| token_usage(0.0, 0.0));
    output["agentTime"] = serde_json::to_value(time.copied().unwrap_or_default())?;
    dates(&mut output, provider, &["createdAt", "updatedAt"])?;
    Ok(output)
}
fn route_summary(route: &Value, provider_name: &Value) -> Value {
    let mut output = project(
        route,
        &[
            "id",
            "providerId",
            "providerModelId",
            "modelName",
            "position",
            "enabled",
            "discoveryManaged",
        ],
    );
    output["providerName"] = provider_name.clone();
    output
}
fn model_summary(
    model: &Value,
    routes: Vec<Value>,
    usage: Option<&Value>,
    time: Option<&Summary>,
) -> Result<Value> {
    let mut output = project(
        model,
        &[
            "id",
            "name",
            "canonicalModelId",
            "defaultReasoningEffort",
            "discoveryManaged",
        ],
    );
    output["routingPolicy"] = json!("priority");
    output["routes"] = json!(routes);
    output["tokenUsage"] = usage.cloned().unwrap_or_else(|| token_usage(0.0, 0.0));
    output["agentTime"] = serde_json::to_value(time.copied().unwrap_or_default())?;
    dates(&mut output, model, &["createdAt", "updatedAt"])?;
    Ok(output)
}
pub(super) fn catalog_entry(model: &Value) -> Result<Value> {
    if model.is_null() {
        return Ok(Value::Null);
    }
    let mut output = project(
        model,
        &[
            "id",
            "providerId",
            "nativeModelId",
            "canonicalModelId",
            "displayName",
            "description",
            "contextWindow",
            "maxOutputTokens",
            "inputModalities",
            "outputModalities",
            "supportsTools",
            "supportsParallelTools",
            "supportsStructuredOutput",
            "supportsVision",
            "supportsReasoning",
            "supportedReasoningEfforts",
            "defaultReasoningEffort",
            "reasoningMandatory",
            "family",
            "parameterSize",
            "quantization",
            "digest",
            "metadataSource",
            "hidden",
            "isDefault",
        ],
    );
    output["matchConfidence"] = percentage(&model["match_confidence_basis_points"], 10_000.0);
    dates(
        &mut output,
        model,
        &["lastSeenAt", "createdAt", "updatedAt"],
    )?;
    Ok(output)
}

#[derive(Default)]
pub struct AgentTimeAnalytics {
    pub models: HashMap<String, Summary>,
    pub providers: HashMap<String, Summary>,
    pub total: Summary,
}

#[derive(Clone)]
pub struct SettingsRepository {
    pub database: Arc<Database>,
}
impl SettingsRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub(super) async fn json_rows(
        &self,
        sql: &str,
        parameters: Parameters<'_>,
    ) -> Result<Vec<Value>> {
        self.database
            .query(sql, parameters)
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect()
    }

    pub async fn ensure_account_configuration(&self, owner: &str) -> Result<()> {
        self.database.query("INSERT INTO user_settings(user_id,theme,high_contrast,pro_mode,pro_mode_opacity,content_gutters,sidebar_width,show_chat_prompt_overlay,random_agent_names,desktop_frame_rate,desktop_stream_quality,default_model_id,default_permission_profile_id) VALUES($1,'system',false,false,80,false,288,true,false,30,'adaptive',NULL,':workspace') ON CONFLICT(user_id) DO NOTHING", &[&owner]).await?;
        Ok(())
    }

    pub async fn ensure_default_model_configuration(
        &self,
        owner: &str,
        model: &str,
        base_url: &str,
    ) -> Result<()> {
        // The legacy initializer deliberately uses fixed IDs and separate writes.
        self.database.query("INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES($1,$2,'Ollama','ollama',$3) ON CONFLICT(id) DO NOTHING", &[&DEFAULT_OLLAMA_PROVIDER_ID,&owner,&base_url]).await?;
        self.database.query("INSERT INTO model_profiles(id,owner_id,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", &[&DEFAULT_MODEL_ID,&owner,&model]).await?;
        self.database.query("INSERT INTO model_routes(id,model_id,provider_id,model_name,position) VALUES($1,$2,$3,$4,0) ON CONFLICT(id) DO NOTHING", &[&DEFAULT_MODEL_ROUTE_ID,&DEFAULT_MODEL_ID,&DEFAULT_OLLAMA_PROVIDER_ID,&model]).await?;
        self.database.query("INSERT INTO user_settings(user_id,theme,high_contrast,pro_mode,pro_mode_opacity,content_gutters,sidebar_width,show_chat_prompt_overlay,random_agent_names,desktop_frame_rate,desktop_stream_quality,default_model_id,default_permission_profile_id) VALUES($1,'system',false,false,80,false,288,true,false,30,'adaptive',$2,':workspace') ON CONFLICT(user_id) DO NOTHING", &[&owner,&DEFAULT_MODEL_ID]).await?;
        self.database.query("UPDATE chats SET model_id=$1 WHERE model_id IS NULL AND EXISTS(SELECT 1 FROM chat_messages WHERE chat_messages.chat_id=chats.id AND chat_messages.role='user')", &[&DEFAULT_MODEL_ID]).await?;
        Ok(())
    }

    pub async fn get_user_settings(&self, owner: &str) -> Result<Value> {
        let rows = self
            .json_rows(
                "SELECT to_jsonb(s) FROM user_settings s WHERE user_id=$1 LIMIT 1",
                &[&owner],
            )
            .await?;
        Ok(project(
            rows.first()
                .context("Database returned no row after loading user settings.")?,
            PREFERENCES,
        ))
    }

    pub async fn agent_time_analytics(
        &self,
        owner: &str,
        project: Option<&str>,
        at: DateTime<Utc>,
    ) -> Result<AgentTimeAnalytics> {
        let rows = self.database.query("SELECT attempt_status,completed_at::text,model_id,provider_id,started_at::text FROM token_usage_records WHERE owner_id=$1 AND ($2::text IS NULL OR project_id=$2)", &[&owner,&project.filter(|id| !id.is_empty())]).await?;
        let mut intervals = Vec::new();
        for row in rows {
            intervals.push((
                Interval {
                    attempt_status: row.get(0)?,
                    started_at: stored_date(row.get(4)?),
                    completed_at: stored_date(row.get(1)?),
                },
                row.get::<Option<String>>(2)?.map(JsString::from),
                row.get::<Option<String>>(3)?.map(JsString::from),
            ));
        }
        let at = at.timestamp_millis() as f64;
        Ok(AgentTimeAnalytics {
            total: agent_time::summarize(
                &intervals
                    .iter()
                    .map(|row| row.0.clone())
                    .collect::<Vec<_>>(),
                at,
            ),
            models: agent_time::group(intervals.iter().map(|row| (&row.0, row.1.as_ref())), at)
                .into_iter()
                .map(|(key, value)| (key.lossy().into_owned(), value))
                .collect(),
            providers: agent_time::group(intervals.iter().map(|row| (&row.0, row.2.as_ref())), at)
                .into_iter()
                .map(|(key, value)| (key.lossy().into_owned(), value))
                .collect(),
        })
    }

    async fn usage_totals(&self, owner: &str, providers: bool) -> Result<HashMap<String, Value>> {
        let key = if providers { "provider_id" } else { "model_id" };
        let rows = self.database.query(&format!("SELECT {key},coalesce(sum(input_tokens),0)::text,coalesce(sum(output_tokens),0)::text FROM token_usage_records WHERE owner_id=$1 GROUP BY {key}"), &[&owner]).await?;
        let mut totals = HashMap::new();
        for row in rows {
            if let Some(id) = row.get::<Option<String>>(0)?.filter(|id| !id.is_empty()) {
                totals.insert(
                    id,
                    token_usage(
                        row.get::<String>(1)?.parse()?,
                        row.get::<String>(2)?.parse()?,
                    ),
                );
            }
        }
        Ok(totals)
    }

    pub async fn get_settings(&self, owner: &str) -> Result<Value> {
        let at = now();
        let parameters: Parameters<'_> = &[&owner];
        let (preferences,providers,accounts,bindings,models,routes,provider_usage,model_usage,time) = tokio::try_join!(
            self.get_user_settings(owner),
            self.json_rows("SELECT to_jsonb(p) FROM model_providers p WHERE owner_id=$1 ORDER BY name ASC", parameters),
            self.json_rows("SELECT to_jsonb(a) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id AND p.owner_id=$1 ORDER BY a.position ASC", parameters),
            self.json_rows("SELECT to_jsonb(b) FROM model_provider_account_workers b INNER JOIN model_provider_accounts a ON a.id=b.account_id INNER JOIN model_providers p ON p.id=a.provider_id AND p.owner_id=$1", parameters),
            self.json_rows("SELECT to_jsonb(m) FROM model_profiles m WHERE owner_id=$1 ORDER BY name ASC", parameters),
            self.json_rows("SELECT jsonb_build_object('route',to_jsonb(r),'providerName',p.name) FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id INNER JOIN model_providers p ON p.id=r.provider_id WHERE m.owner_id=$1 ORDER BY r.position ASC", parameters),
            self.usage_totals(owner,true),self.usage_totals(owner,false),self.agent_time_analytics(owner,None,at),
        )?;
        let providers = providers
            .iter()
            .map(|provider| {
                let accounts = accounts
                    .iter()
                    .filter(|account| account["provider_id"] == provider["id"])
                    .map(|account| account_summary(account, &bindings))
                    .collect::<Result<_>>()?;
                let id = provider["id"].as_str().context("provider ID")?;
                provider_summary(
                    provider,
                    accounts,
                    provider_usage.get(id),
                    time.providers.get(id),
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let models = models
            .iter()
            .map(|model| {
                let routes = routes
                    .iter()
                    .filter(|row| row["route"]["model_id"] == model["id"])
                    .map(|row| route_summary(&row["route"], &row["providerName"]))
                    .collect();
                let id = model["id"].as_str().context("model ID")?;
                model_summary(model, routes, model_usage.get(id), time.models.get(id))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"preferences":preferences,"providers":providers,"models":models}))
    }

    pub async fn update_app_destination(
        &self,
        owner: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        for (field, table, extra) in [
            ("lastIdeProjectId", "projects", ""),
            ("lastIdeWorkspaceId", "project_workspaces", ""),
            (
                "lastStandaloneChatId",
                "chats",
                " AND context_kind='standalone' AND archived_at IS NULL",
            ),
        ] {
            if let Some(id) = input[field].as_str().filter(|id| !id.is_empty())
                && self
                    .database
                    .query(
                        &format!(
                            "SELECT id FROM {table} WHERE id=$1 AND owner_id=$2{extra} LIMIT 1"
                        ),
                        &[&id, &owner],
                    )
                    .await?
                    .is_empty()
            {
                return Ok(None);
            }
        }
        let mut values = serde_json::Map::new();
        let mut sets = Vec::new();
        for field in DESTINATION {
            if let Some(value) = input.get(*field) {
                let column = column(field);
                sets.push(format!("{column}=v.{column}"));
                values.insert(column, value.clone());
            }
        }
        sets.push("destination_revision=s.destination_revision+1".into());
        sets.push("updated_at=$4".into());
        let revision = input["expectedRevision"].to_string();
        let rows = self.json_rows(&format!("UPDATE user_settings s SET {} FROM jsonb_populate_record(NULL::user_settings,$2::jsonb) v WHERE s.user_id=$1 AND s.destination_revision=$3::text::integer RETURNING to_jsonb(s)",sets.join(",")), &[&owner,&Value::Object(values),&revision,&now()]).await?;
        Ok(rows.first().map(|row| {
            let mut output = project(row, DESTINATION);
            output["revision"] = row["destination_revision"].clone();
            output
        }))
    }

    pub async fn update_settings(&self, owner: &str, input: &Value) -> Result<Option<Value>> {
        for field in [
            "labelingModelId",
            "defaultModelId",
            "defaultChatModelId",
            "defaultSubagentModelId",
        ] {
            if let Some(model) = input[field].as_str().filter(|id| !id.is_empty())
                && self
                    .get_model_runtimes(owner, Some(model), None, false, None)
                    .await?
                    .is_empty()
            {
                return Ok(None);
            }
        }
        if input.get("defaultCustomSubagentModel").is_some()
            || input.get("defaultSubagentModelId").is_some()
        {
            let current = self.get_user_settings(owner).await?;
            let custom = input["defaultCustomSubagentModel"].as_bool().unwrap_or(
                current["defaultCustomSubagentModel"]
                    .as_bool()
                    .context("custom subagent preference")?,
            );
            let id = input
                .get("defaultSubagentModelId")
                .unwrap_or(&current["defaultSubagentModelId"]);
            if custom && id.as_str().is_none_or(str::is_empty) {
                return Ok(None);
            }
        }
        if let Some(worker) = input["defaultWorkerId"]
            .as_str()
            .filter(|id| !id.is_empty())
            && self.database.query("SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1", &[&worker,&owner]).await?.is_empty() { return Ok(None) }
        let mut values = serde_json::Map::new();
        let mut sets = Vec::new();
        for field in PREFERENCES {
            if DESTINATION.contains(field)
                || ["destinationRevision", "computerUseEffectsRevision"].contains(field)
            {
                continue;
            }
            if let Some(value) = input.get(*field) {
                let column = column(field);
                sets.push(if *field == "mobileProjectTabConfigurations" {
                    format!("{column}=s.{column} || v.{column}")
                } else {
                    format!("{column}=v.{column}")
                });
                values.insert(column, value.clone());
            }
        }
        sets.push("updated_at=$3".into());
        self.database.query(&format!("UPDATE user_settings s SET {} FROM jsonb_populate_record(NULL::user_settings,$2::jsonb) v WHERE s.user_id=$1",sets.join(",")), &[&owner,&Value::Object(values),&now()]).await?;
        Ok(Some(self.get_settings(owner).await?))
    }

    pub async fn get_model_runtimes(
        &self,
        owner: &str,
        model: Option<&str>,
        route: Option<&str>,
        include_disabled: bool,
        provider: Option<&str>,
    ) -> Result<Vec<Value>> {
        let rows = self.json_rows("SELECT jsonb_build_object('profile',to_jsonb(m),'route',to_jsonb(r),'provider',to_jsonb(p),'catalog',to_jsonb(c)) FROM model_profiles m INNER JOIN model_routes r ON r.model_id=m.id INNER JOIN model_providers p ON p.id=r.provider_id AND p.owner_id=$1 LEFT JOIN provider_models c ON c.provider_id=r.provider_id AND (c.id=r.provider_model_id OR (r.provider_model_id IS NULL AND c.native_model_id=r.model_name)) WHERE m.owner_id=$1 AND ($2::text IS NULL OR m.id=$2) AND ($3::text IS NULL OR r.id=$3) AND ($4 OR r.enabled=true) AND ($5::text IS NULL OR p.id=$5) ORDER BY r.position ASC", &[&owner,&model.filter(|id| !id.is_empty()),&route.filter(|id| !id.is_empty()),&include_disabled,&provider.filter(|id| !id.is_empty())]).await?;
        let catalogs = rows
            .iter()
            .map(|row| catalog_entry(&row["catalog"]))
            .collect::<Result<Vec<_>>>()?;
        let mut aliases = indexmap::IndexSet::new();
        for (row, catalog) in rows.iter().zip(&catalogs) {
            if !catalog.is_null() {
                aliases.extend(
                    enrichment::aliases(
                        &wire::Value::from_serialize(catalog),
                        row["provider"]["kind"].as_str().context("provider kind")?,
                    )
                    .into_iter()
                    .map(|key| key.lossy().into_owned()),
                );
            }
        }
        let candidates = if aliases.is_empty() {
            vec![]
        } else {
            let aliases: Vec<_> = aliases.into_iter().collect();
            self.json_rows("SELECT jsonb_build_object('catalog',to_jsonb(c),'baseUrl',p.base_url) FROM provider_models c INNER JOIN model_providers p ON p.id=c.provider_id AND p.owner_id=$1 AND p.kind='openai-compatible' WHERE c.native_model_id=ANY($2::text[]) OR c.canonical_model_id=ANY($2::text[])", &[&owner,&aliases]).await?.iter().filter(|row| row["baseUrl"].as_str().and_then(|base| url::Url::parse(base).ok()).and_then(|url| url.host_str().map(str::to_ascii_lowercase)).is_some_and(|host| host=="openrouter.ai" || host.ends_with(".openrouter.ai"))).map(|row| catalog_entry(&row["catalog"]).map(|value| wire::Value::from_serialize(&value))).collect::<Result<Vec<_>>>()?
        };
        rows.iter().zip(catalogs).map(|(row,catalog)| {
            let (profile,route,provider) = (&row["profile"],&row["route"],&row["provider"]);
            let kind = provider["kind"].as_str().context("provider kind")?;
            let catalog = enrichment::enrich(&wire::Value::from_serialize(&catalog),kind,&candidates);
            Ok(json!({"routeId":route["id"],"model":{"id":profile["id"],"profileName":profile["name"],"routeId":route["id"],"name":route["model_name"],"reasoningEffort":null,"providerModelId":if route["provider_model_id"].is_null() { &row["catalog"]["id"] } else { &route["provider_model_id"] },"catalog":serde_json::from_str::<Value>(&catalog.stringify())?},"provider":{"id":provider["id"],"name":provider["name"],"kind":provider["kind"],"baseUrl":provider["base_url"],"protectedApiKey":provider["protected_api_key"],"accountId":null,"credentialHomeKey":null,"weeklyUsageReservePercent":provider["weekly_usage_reserve_percent"]}}))
        }).collect()
    }
}
