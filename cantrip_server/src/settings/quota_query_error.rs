//! Drizzle query diagnostics attached only after the native operation fails.
use crate::wire::Value;
type Query = (String, Vec<Value>);

pub(super) fn credits(
    owner: &str,
    provider: &str,
    account: &str,
    credits: &Value,
    observed: &str,
    at: chrono::DateTime<chrono::Utc>,
) -> Query {
    (
        "update \"model_provider_accounts\" set \"credits\" = $1, \"credits_observed_at\" = $2, \"updated_at\" = $3 where (\"model_provider_accounts\".\"id\" = $4 and \"model_provider_accounts\".\"provider_id\" = $5 and (\"model_provider_accounts\".\"credits_observed_at\" is null or \"model_provider_accounts\".\"credits_observed_at\" <= $6) and exists (select \"id\" from \"model_providers\" where (\"model_providers\".\"id\" = $7 and \"model_providers\".\"owner_id\" = $8 and \"model_providers\".\"kind\" = $9))) returning \"id\"".into(),
        vec![Value::String(credits.stringify().into()), Value::String(observed.into()), Value::String(crate::auth::iso(at).into()), Value::String(account.into()), Value::String(provider.into()), Value::String(observed.into()), Value::String(provider.into()), Value::String(owner.into()), Value::String("chatgpt".into())],
    )
}
pub(super) fn insert(record: &Value, original: &Value) -> Query {
    let columns = [
        "id",
        "owner_id",
        "event_key",
        "observation_batch_key",
        "provider_id",
        "provider_kind",
        "provider_account_id",
        "worker_id",
        "observed_at",
        "received_at",
        "used_percent_micros",
        "resets_at",
        "window_duration_minutes",
        "limit_id",
        "window_kind",
        "reached_type",
        "observation_trigger",
        "is_weekly_projection",
        "chat_id",
        "turn_id",
        "execution_attempt_id",
        "worker_version",
        "server_version",
        "codex_version",
    ];
    let mut values = Vec::new();
    let placeholders = columns
        .iter()
        .map(|column| {
            if *column == "received_at" {
                return "default".to_owned();
            }
            let field = match *column {
                "event_key" => Some("eventKey"),
                "observation_batch_key" => Some("observationBatchKey"),
                "limit_id" => Some("limitId"),
                "reached_type" => Some("reachedType"),
                "worker_version" => Some("workerVersion"),
                "codex_version" => Some("codexVersion"),
                _ => None,
            };
            values.push(
                field
                    .and_then(|key| original.get(key))
                    .unwrap_or(&record[*column])
                    .clone(),
            );
            format!("${}", values.len())
        })
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!(
            "insert into \"provider_quota_observations\" ({}) values ({placeholders}) on conflict (\"owner_id\",\"event_key\") do nothing returning \"id\"",
            columns.map(|column| format!("\"{column}\"")).join(", ")
        ),
        values,
    )
}
pub(super) fn projection(
    record: &Value,
    original: &Value,
    basis: f64,
    at: chrono::DateTime<chrono::Utc>,
    worker: bool,
) -> Query {
    let mut fields = vec![];
    if !worker && crate::wire::coercion::truthy(original.get("planType")) {
        fields.push(("plan_type", original["planType"].clone()));
    }
    fields.extend([
        ("weekly_usage_used_basis_points", Value::Number(basis)),
        ("weekly_usage_resets_at", record["resets_at"].clone()),
        ("weekly_usage_observed_at", record["observed_at"].clone()),
        ("updated_at", Value::String(crate::auth::iso(at).into())),
    ]);
    let assignments = fields
        .iter()
        .enumerate()
        .map(|(index, (column, _))| format!("\"{column}\" = ${}", index + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let mut values = fields
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    values.push(record["provider_account_id"].clone());
    let index = values.len();
    let table = if worker {
        "model_provider_account_workers"
    } else {
        "model_provider_accounts"
    };
    let condition = if worker {
        values.push(record["worker_id"].clone());
        format!(
            "\"{table}\".\"account_id\" = ${index} and \"{table}\".\"worker_id\" = ${}",
            index + 1
        )
    } else {
        format!("\"{table}\".\"id\" = ${index}")
    };
    values.push(record["observed_at"].clone());
    (
        format!(
            "update \"{table}\" set {assignments} where ({condition} and (\"{table}\".\"weekly_usage_observed_at\" is null or \"{table}\".\"weekly_usage_observed_at\" <= ${}))",
            values.len()
        ),
        values,
    )
}
