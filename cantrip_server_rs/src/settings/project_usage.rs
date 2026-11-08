//! Project-scoped lifetime usage, UTC daily series and provider/model breakdowns.
use super::{agent_time::Summary, repository::SettingsRepository};
use crate::database::Row;
use anyhow::Result;
use chrono::{Duration, Utc};
use futures::FutureExt;
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::collections::HashMap;

const COLUMNS: &[&str] = &[
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
];
const FIELDS: &[&str] = &[
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
];

fn counts(row: &Row, offset: usize) -> Result<[f64; 5]> {
    let mut values = [0.0; 5];
    for (i, value) in values.iter_mut().enumerate() {
        // The reference maps each PostgreSQL aggregate through Number before
        // adding totals or merging breakdowns, including beyond safe integers.
        *value = row.get::<String>(offset + i)?.parse()?;
    }
    Ok(values)
}
fn totals(values: [f64; 5]) -> Value {
    let mut result = json!({"totalTokens":values[0] + values[1]});
    for (field, value) in FIELDS.iter().zip(values) {
        result[*field] = json!(value);
    }
    result
}
fn breakdowns(rows: Vec<Row>, times: &HashMap<String, Summary>) -> Result<Value> {
    let mut merged: IndexMap<String, (Option<String>, String, [f64; 5])> = IndexMap::new();
    for row in rows {
        let id = row.get::<Option<String>>(0)?;
        let name = row.get::<String>(1)?;
        let key = id.clone().unwrap_or_else(|| format!("deleted:{name}"));
        let values = counts(&row, 2)?;
        let entry = merged.entry(key).or_insert((None, String::new(), [0.0; 5]));
        entry.0 = id;
        entry.1 = name;
        for (total, value) in entry.2.iter_mut().zip(values) {
            *total += value;
        }
    }
    let mut values: Vec<_> = merged.into_values().collect();
    // Stable ties retain the database/group insertion order, as Array.sort does.
    values.sort_by(|left, right| (right.2[0] + right.2[1]).total_cmp(&(left.2[0] + left.2[1])));
    Ok(Value::Array(
        values
            .into_iter()
            .map(|(id, name, counts)| {
                let time = id
                    .as_ref()
                    .filter(|id| !id.is_empty())
                    .and_then(|id| times.get(id))
                    .copied()
                    .unwrap_or_default();
                let mut value = totals(counts);
                value["id"] = json!(id);
                value["name"] = json!(name);
                value["agentTime"] = json!(time);
                value
            })
            .collect(),
    ))
}

impl SettingsRepository {
    pub async fn project_token_usage(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        // This endpoint only checks ownership. Unrelated project presentation
        // metadata must not be parsed or allowed to prevent reading usage.
        if self
            .database
            .query(
                "SELECT id FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&project, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let now = Utc::now();
        let end = now.date_naive();
        let start = end - Duration::days(364);
        let start_at = start.and_hms_opt(0, 0, 0).unwrap().and_utc();
        let sums = COLUMNS
            .iter()
            .map(|name| format!("coalesce(sum(u.{name}),0)::text"))
            .collect::<Vec<_>>()
            .join(",");
        let filter = "u.owner_id=$1 AND u.project_id=$2";
        let total_sql = format!("SELECT {sums} FROM token_usage_records u WHERE {filter}");
        // Source has a lower time bound only: future UTC days remain observable.
        let day = "to_char(u.started_at AT TIME ZONE 'UTC','YYYY-MM-DD')";
        let daily_sql = format!(
            "SELECT {day},{sums} FROM token_usage_records u WHERE {filter} AND u.started_at>=$3 GROUP BY {day} ORDER BY {day}"
        );
        let provider_sql = format!(
            "SELECT u.provider_id,coalesce(p.name,'Deleted provider'),{sums} FROM token_usage_records u LEFT JOIN model_providers p ON p.id=u.provider_id WHERE {filter} GROUP BY u.provider_id,p.name"
        );
        let model_sql = format!(
            "SELECT u.model_id,coalesce(m.name,'Deleted model'),{sums} FROM token_usage_records u LEFT JOIN model_profiles m ON m.id=u.model_id WHERE {filter} GROUP BY u.model_id,m.name"
        );
        let params: crate::database::Parameters<'_> = &[&owner, &project];
        let day_params: crate::database::Parameters<'_> = &[&owner, &project, &start_at];
        let (total, daily, providers, models, time) = tokio::try_join!(
            self.database.query(&total_sql, params).boxed(),
            self.database.query(&daily_sql, day_params).boxed(),
            self.database.query(&provider_sql, params).boxed(),
            self.database.query(&model_sql, params).boxed(),
            self.agent_time_analytics(owner, Some(project), now).boxed(),
        )?;
        let total = total
            .first()
            .map(|row| counts(row, 0))
            .transpose()?
            .unwrap_or([0.0; 5]);
        let daily = daily
            .iter()
            .map(|row| {
                let mut value = totals(counts(row, 1)?);
                value["date"] = json!(row.get::<String>(0)?);
                Ok(value)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(json!({
            "total":totals(total),"agentTime":time.total,"daily":daily,
            "providers":breakdowns(providers,&time.providers)?,
            "models":breakdowns(models,&time.models)?,
            "range":{"start":start.format("%Y-%m-%d").to_string(),"end":end.format("%Y-%m-%d").to_string()}
        })))
    }
}
