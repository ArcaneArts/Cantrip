//! Legacy auth routes do not schema-validate their identifier properties. Keep
//! the reference drivers' actual parameter typing and JS truthiness separately
//! from text conversion, so an empty array cannot select the default account.
use super::{
    query_error,
    repository::{SettingsRepository, provider_summary},
};
use crate::{
    database::Row,
    wire::{Value, coercion},
};
use anyhow::{Context, Result};
use postgres_types::{ToSql, Type};
use serde_json::Value as Json;

pub(super) fn text(value: &Value) -> Result<String> {
    Ok(coercion::string(value)
        .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?
        .lossy()
        .into_owned())
}
fn boolean_hint(value: &Value) -> Option<bool> {
    let scalar = matches!(value, Value::Bool(_));
    let mut current = value;
    while let Value::Array(values) = current {
        current = values.first()?;
    }
    // postgres-js infers an array's scalar type from its first element; its
    // boolean serializer emits true only for the primitive boolean true.
    if let Value::Bool(value) = current {
        Some(scalar && *value)
    } else {
        None
    }
}
const PROVIDER_SOURCE_QUERY: &str = "select \"id\", \"owner_id\", \"name\", \"kind\", \"base_url\", \"protected_api_key\", \"weekly_usage_reserve_percent\", \"created_at\", \"updated_at\" from \"model_providers\" where (\"model_providers\".\"id\" = $1 and \"model_providers\".\"owner_id\" = $2) limit $3";
const WORKER_SOURCE_QUERY: &str = "select \"id\", \"owner_id\", \"name\", \"display_name\", \"platform\", \"architecture\", \"codex_version\", \"codex_runtime\", \"remote_surface_capabilities\", \"direct_broker_advertisement\", \"codegraph_status\", \"web_runtime_capabilities\", \"encryption_status\", \"project_replica_capabilities\", \"managed_folder_capabilities\", \"standalone_chat_capabilities\", \"chat_relocation_capability\", \"external_codex_history_capability\", \"started_at\", \"last_seen_at\", \"unlinked_at\", \"created_at\", \"updated_at\" from \"workers\" where (\"workers\".\"id\" = $1 and \"workers\".\"owner_id\" = $2 and \"workers\".\"unlinked_at\" is null) limit $3";
fn json_row(rows: Vec<Row>) -> Result<Option<Json>> {
    rows.first().map(|row| row.get(0)).transpose()
}
impl SettingsRepository {
    pub(super) async fn provider_input(
        &self,
        owner: &str,
        provider: &Value,
    ) -> Result<Option<Json>> {
        let stored = text(provider)?;
        if let Some(boolean) = boolean_hint(provider) {
            let typed = self
                .database
                .query_postgres_typed(
                    "SELECT to_jsonb(p) FROM model_providers p WHERE id=$1 AND owner_id=$2 LIMIT 1",
                    &[(&boolean, Type::BOOL), (&owner, Type::TEXT)],
                )
                .await;
            if let Some(rows) = query_error::context(
                typed,
                PROVIDER_SOURCE_QUERY,
                &[
                    provider.clone(),
                    Value::String(owner.into()),
                    Value::Number(1.0),
                ],
            )? {
                return json_row(rows)?
                    .map(|row| provider_summary(&row, vec![], None, None))
                    .transpose();
            }
        }
        self.get_model_provider(owner, &stored).await
    }
    pub(super) async fn account_runtime_input(
        &self,
        owner: &str,
        provider: &Value,
        account: Option<&Value>,
    ) -> Result<Option<Json>> {
        let provider_text = text(provider)?;
        let selected = account.filter(|value| coercion::truthy(Some(value)));
        let account_text = selected.map(text).transpose()?;
        let provider_boolean = boolean_hint(provider);
        let account_boolean = selected.and_then(boolean_hint);
        let provider_parameter: &(dyn ToSql + Sync) = provider_boolean
            .as_ref()
            .map_or(&provider_text, |value| value);
        let account_parameter: Option<&(dyn ToSql + Sync)> = account_boolean
            .as_ref()
            .map(|value| value as _)
            .or_else(|| account_text.as_ref().map(|value| value as _));
        let mut typed = vec![
            (
                provider_parameter,
                if provider_boolean.is_some() {
                    Type::BOOL
                } else {
                    Type::TEXT
                },
            ),
            (&owner as &(dyn ToSql + Sync), Type::TEXT),
        ];
        let mut parameters: Vec<&(dyn ToSql + Sync)> = vec![&provider_text, &owner];
        let filter = if let Some(account_parameter) = account_parameter {
            typed.push((
                account_parameter,
                if account_boolean.is_some() {
                    Type::BOOL
                } else {
                    Type::TEXT
                },
            ));
            parameters.push(account_text.as_ref().context("selected account text")?);
            "a.id=$3"
        } else {
            "a.enabled=true"
        };
        let sql = format!(
            "SELECT jsonb_build_object('accountId',a.id,'credentialHomeKey',a.credential_home_key) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE a.provider_id=$1 AND p.owner_id=$2 AND p.kind IN ('chatgpt','grok') AND {filter} ORDER BY a.position ASC LIMIT 1"
        );
        if provider_boolean.is_some() || account_boolean.is_some() {
            let source_filter = if selected.is_some() {
                "\"model_provider_accounts\".\"id\" = $5"
            } else {
                "\"model_provider_accounts\".\"enabled\" = $5"
            };
            let source = format!(
                "select \"model_provider_accounts\".\"id\", \"model_provider_accounts\".\"credential_home_key\" from \"model_provider_accounts\" inner join \"model_providers\" on \"model_providers\".\"id\" = \"model_provider_accounts\".\"provider_id\" where (\"model_provider_accounts\".\"provider_id\" = $1 and \"model_providers\".\"owner_id\" = $2 and \"model_providers\".\"kind\" in ($3, $4) and {source_filter}) order by \"model_provider_accounts\".\"position\" asc limit $6"
            );
            let result = self.database.query_postgres_typed(&sql, &typed).await;
            if let Some(rows) = query_error::context(
                result,
                &source,
                &[
                    provider.clone(),
                    Value::String(owner.into()),
                    Value::String("chatgpt".into()),
                    Value::String("grok".into()),
                    selected.cloned().unwrap_or(Value::Bool(true)),
                    Value::Number(1.0),
                ],
            )? {
                return json_row(rows);
            }
        }
        json_row(self.database.query(&sql, &parameters).await?)
    }
}

impl crate::workers::repository::WorkerRepository {
    pub(crate) async fn owner_input(&self, worker: &Value) -> Result<Option<String>> {
        const QUERY: &str =
            "select \"owner_id\" from \"workers\" where \"workers\".\"id\" = $1 limit $2";
        let stored = text(worker)?;
        let params = [worker.clone(), Value::Number(1.0)];
        if let Some(boolean) = boolean_hint(worker)
            && let Some(rows) = query_error::context(
                self.database
                    .query_postgres_typed(
                        "SELECT owner_id FROM workers WHERE id=$1 LIMIT 1",
                        &[(&boolean, Type::BOOL)],
                    )
                    .await,
                QUERY,
                &params,
            )?
        {
            return rows.first().map(|row| row.get(0)).transpose();
        }
        query_error::context(self.owner(&stored).await, QUERY, &params)
    }
    pub(crate) async fn get_worker_input(
        &self,
        owner: &str,
        worker: &Value,
    ) -> Result<Option<Json>> {
        let stored = text(worker)?;
        if let Some(boolean) = boolean_hint(worker) {
            // Run the actual typed query. PostgreSQL rejects text = boolean;
            // PGlite infers its text parameter instead, as the old driver does.
            let result = self.database.query_postgres_typed(
                "SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1",
                &[(&boolean, Type::BOOL), (&owner, Type::TEXT)],
            ).await;
            query_error::context(
                result,
                WORKER_SOURCE_QUERY,
                &[
                    worker.clone(),
                    Value::String(owner.into()),
                    Value::Number(1.0),
                ],
            )?;
        }
        query_error::context(
            self.get_worker(owner, &stored).await,
            WORKER_SOURCE_QUERY,
            &[
                worker.clone(),
                Value::String(owner.into()),
                Value::Number(1.0),
            ],
        )
    }
}
