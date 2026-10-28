//! Mutations expose the reference repository's query context on failure.
//! These wrappers run the real operation before attaching that context.
use crate::wire::{JsString, Value, coercion};
use anyhow::Result;

#[derive(Debug)]
pub(crate) struct SettingsQueryError {
    pub message: JsString,
    source: anyhow::Error,
}
impl std::fmt::Display for SettingsQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for SettingsQueryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}
pub(super) fn context<T>(result: Result<T>, query: &str, params: &[Value]) -> Result<T> {
    result.map_err(|source| {
        let mut units = format!("Failed query: {query}\nparams: ")
            .encode_utf16()
            .collect::<Vec<_>>();
        for (index, value) in params.iter().enumerate() {
            if index > 0 {
                units.push(u16::from(b','));
            }
            if !value.is_null() {
                units.extend_from_slice(
                    coercion::string(value)
                        .expect("scalar query parameter")
                        .units(),
                );
            }
        }
        SettingsQueryError {
            message: JsString::new(units),
            source,
        }
        .into()
    })
}
type QueryContext = (String, Vec<Value>);
const PROVIDER_COLUMNS: &str = "\"id\", \"owner_id\", \"name\", \"kind\", \"base_url\", \"protected_api_key\", \"weekly_usage_reserve_percent\", \"created_at\", \"updated_at\"";
pub(super) fn provider_insert(
    id: &str,
    owner: &str,
    input: &Value,
    base: &str,
    reserve: i64,
) -> QueryContext {
    let mut parameters = vec![
        Value::String(id.into()),
        Value::String(owner.into()),
        input["name"].clone(),
        input["kind"].clone(),
        Value::String(base.into()),
    ];
    let key = if let Some(key) = input.get("protectedApiKey") {
        parameters.push(if key.is_null() {
            Value::Null
        } else {
            Value::String(key.stringify().into())
        });
        "$6"
    } else {
        "default"
    };
    parameters.push(Value::Number(reserve as f64));
    let columns = PROVIDER_COLUMNS;
    (
        format!(
            "insert into \"model_providers\" ({columns}) values ($1, $2, $3, $4, $5, {key}, ${}, default, default) returning {columns}",
            parameters.len()
        ),
        parameters,
    )
}
pub(super) fn provider_update(
    owner: &str,
    provider: &str,
    input: &Value,
    base: &str,
    at: chrono::DateTime<chrono::Utc>,
) -> QueryContext {
    let mut fields = vec![
        ("name", input["name"].clone()),
        ("kind", input["kind"].clone()),
        ("base_url", Value::String(base.into())),
    ];
    if let Some(key) = input.get("protectedApiKey") {
        fields.push((
            "protected_api_key",
            if key.is_null() {
                Value::Null
            } else {
                Value::String(key.stringify().into())
            },
        ));
    }
    if let Some(reserve) = input.get("weeklyUsageReservePercent") {
        fields.push(("weekly_usage_reserve_percent", reserve.clone()));
    }
    fields.push(("updated_at", Value::String(crate::auth::iso(at).into())));
    let assignments = fields
        .iter()
        .enumerate()
        .map(|(i, (field, _))| format!("\"{field}\" = ${}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let mut parameters = fields
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    parameters.push(Value::String(provider.into()));
    parameters.push(Value::String(owner.into()));
    (
        format!(
            "update \"model_providers\" set {assignments} where (\"model_providers\".\"id\" = ${} and \"model_providers\".\"owner_id\" = ${}) returning {PROVIDER_COLUMNS}",
            parameters.len() - 1,
            parameters.len()
        ),
        parameters,
    )
}
pub(super) fn provider_detach(route: &str, at: chrono::DateTime<chrono::Utc>) -> QueryContext {
    ("update \"chat_runtime_sessions\" set \"codex_thread_id\" = $1, \"status\" = $2, \"updated_at\" = $3 where \"chat_runtime_sessions\".\"model_route_id\" = $4".into(), vec![Value::Null,Value::String("detached".into()),Value::String(crate::auth::iso(at).into()),Value::String(route.into())])
}
pub(super) fn provider_initial_account(provider: &str, input: &Value) -> QueryContext {
    let columns = [
        "id",
        "provider_id",
        "protected_label",
        "plan_type",
        "position",
        "enabled",
        "credential_home_key",
        "protected_credential",
        "credential_revision",
        "credential_state",
        "credential_subject_blind_index",
        "credential_expires_at",
        "credential_updated_at",
        "credential_refresh_lease_id",
        "credential_refresh_lease_expires_at",
        "credential_last_refresh_at",
        "weekly_usage_used_basis_points",
        "credits",
        "credits_observed_at",
        "weekly_usage_resets_at",
        "weekly_usage_observed_at",
        "auth_last_synced_at",
        "created_at",
        "updated_at",
    ];
    let mut values = vec!["default"; columns.len()];
    for (column, parameter) in [(0, "$1"), (1, "$2"), (2, "$3"), (4, "$4"), (6, "$5")] {
        values[column] = parameter;
    }
    let columns = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!(
            "insert into \"model_provider_accounts\" ({columns}) values ({}) returning {columns}",
            values.join(", ")
        ),
        vec![
            input["id"].clone(),
            Value::String(provider.into()),
            Value::String(input["protectedLabel"].stringify().into()),
            Value::Number(0.0),
            Value::String(provider.into()),
        ],
    )
}
pub(super) fn account_status(
    account: &str,
    worker: &str,
    state: &str,
    at: chrono::DateTime<chrono::Utc>,
    plan: Option<&str>,
    quota: Option<(f64, Option<&str>)>,
) -> (QueryContext, QueryContext) {
    let at = Value::String(crate::auth::iso(at).into());
    let used = quota.map_or(Value::Null, |(basis, _)| Value::Number(basis));
    let resets = quota
        .and_then(|(_, resets)| resets)
        .map_or(Value::Null, |v| Value::String(v.into()));
    let mut fields = Vec::new();
    if quota.is_some() {
        if let Some(plan) = plan {
            fields.push(("plan_type", Value::String(plan.into())));
        }
        fields.extend([
            ("weekly_usage_used_basis_points", used.clone()),
            ("weekly_usage_resets_at", resets.clone()),
            ("weekly_usage_observed_at", at.clone()),
        ]);
    }
    fields.extend([
        ("auth_last_synced_at", at.clone()),
        ("updated_at", at.clone()),
    ]);
    let assignments = fields
        .iter()
        .enumerate()
        .map(|(i, (column, _))| format!("\"{column}\" = ${}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let mut parameters = fields
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    parameters.push(Value::String(account.into()));
    let update = (
        format!(
            "update \"model_provider_accounts\" set {assignments} where \"model_provider_accounts\".\"id\" = ${}",
            parameters.len()
        ),
        parameters,
    );
    let state = Value::String(state.into());
    let mut parameters = vec![
        Value::String(account.into()),
        Value::String(worker.into()),
        state.clone(),
        used.clone(),
        resets.clone(),
        if quota.is_some() {
            at.clone()
        } else {
            Value::Null
        },
        at.clone(),
        at.clone(),
        state,
        used,
        resets,
    ];
    let mut fields = vec![
        "auth_state",
        "weekly_usage_used_basis_points",
        "weekly_usage_resets_at",
    ];
    if quota.is_some() {
        fields.push("weekly_usage_observed_at");
        parameters.push(at.clone());
    }
    fields.extend(["last_synced_at", "updated_at"]);
    parameters.extend([at.clone(), at]);
    let assignments = fields
        .iter()
        .enumerate()
        .map(|(i, column)| format!("\"{column}\" = ${}", i + 9))
        .collect::<Vec<_>>()
        .join(", ");
    let binding = (
        format!(
            "insert into \"model_provider_account_workers\" (\"account_id\", \"worker_id\", \"auth_state\", \"weekly_usage_used_basis_points\", \"weekly_usage_resets_at\", \"weekly_usage_observed_at\", \"last_synced_at\", \"created_at\", \"updated_at\") values ($1, $2, $3, $4, $5, $6, $7, default, $8) on conflict (\"account_id\",\"worker_id\") do update set {assignments}"
        ),
        parameters,
    );
    (update, binding)
}
pub(super) fn catalog_sync(
    id: &str,
    provider: &str,
    input: &serde_json::Value,
    at: chrono::DateTime<chrono::Utc>,
) -> (String, Vec<Value>) {
    let value = |key: &str| {
        let raw = Value::from_serialize(&input[key]);
        if matches!(key, "refreshStartedAt" | "lastSuccessAt")
            && let Some(text) = raw.as_js_string()
            && let Some(formatted) =
                crate::wire::date_milliseconds(text).and_then(crate::wire::date_iso_milliseconds)
        {
            return Value::String(formatted.into());
        }
        raw
    };
    let stamp = Value::String(crate::auth::iso(at).into());
    let mut params = vec![
        Value::String(id.into()),
        Value::String(provider.into()),
        value("scopeKey"),
        value("workerId"),
        value("providerAccountId"),
        value("status"),
        value("errorCode"),
        value("etag"),
        value("refreshStartedAt"),
        value("lastSuccessAt"),
        stamp.clone(),
    ];
    // Drizzle iterates the declaration order of the table's columns for both
    // insert values and the conflict update, rather than the set-object order.
    let mut updates = vec![];
    for (key, column) in [
        ("workerId", "worker_id"),
        ("providerAccountId", "provider_account_id"),
        ("status", "status"),
        ("errorCode", "error_code"),
        ("etag", "etag"),
        ("refreshStartedAt", "refresh_started_at"),
        ("lastSuccessAt", "last_success_at"),
        ("updatedAt", "updated_at"),
    ] {
        if key == "status" || key == "updatedAt" || input.get(key).is_some() {
            params.push(if key == "updatedAt" {
                stamp.clone()
            } else {
                value(key)
            });
            updates.push(format!("\"{column}\" = ${}", params.len()));
        }
    }
    (
        format!(
            "insert into \"provider_catalog_sync_states\" (\"id\", \"provider_id\", \"scope_key\", \"worker_id\", \"provider_account_id\", \"status\", \"error_code\", \"etag\", \"refresh_started_at\", \"last_success_at\", \"created_at\", \"updated_at\") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, default, $11) on conflict (\"provider_id\",\"scope_key\") do update set {}",
            updates.join(", ")
        ),
        params,
    )
}
pub(super) const ACCOUNT_SIGN_OUT: &str = "update \"model_provider_accounts\" set \"plan_type\" = $1, \"protected_credential\" = $2, \"credential_revision\" = $3, \"credential_state\" = $4, \"credential_subject_blind_index\" = $5, \"credential_expires_at\" = $6, \"credential_updated_at\" = $7, \"credential_refresh_lease_id\" = $8, \"credential_refresh_lease_expires_at\" = $9, \"weekly_usage_used_basis_points\" = $10, \"credits\" = $11, \"credits_observed_at\" = $12, \"weekly_usage_resets_at\" = $13, \"auth_last_synced_at\" = $14, \"updated_at\" = $15 where (\"model_provider_accounts\".\"id\" = $16 and \"model_provider_accounts\".\"provider_id\" = $17 and \"model_provider_accounts\".\"credential_revision\" = $18) returning \"id\"";
pub(super) fn account_sign_out_params(
    account: &str,
    provider: &str,
    revision: i64,
    at: chrono::DateTime<chrono::Utc>,
) -> Vec<Value> {
    let stamp = Value::String(crate::auth::iso(at).into());
    vec![
        Value::Null,
        Value::Null,
        Value::Number((revision + 1) as f64),
        Value::String("signed-out".into()),
        Value::Null,
        Value::Null,
        stamp.clone(),
        Value::Null,
        Value::Null,
        Value::Null,
        Value::Null,
        Value::Null,
        Value::Null,
        stamp.clone(),
        stamp,
        Value::String(account.into()),
        Value::String(provider.into()),
        Value::Number(revision as f64),
    ]
}
pub(super) const ACCOUNT_BINDINGS_SIGN_OUT: &str = "update \"model_provider_account_workers\" set \"auth_state\" = $1, \"weekly_usage_used_basis_points\" = $2, \"weekly_usage_resets_at\" = $3, \"last_synced_at\" = $4, \"updated_at\" = $5 where \"model_provider_account_workers\".\"account_id\" = $6";
pub(super) const PROFILE_INSERT: &str = "insert into \"model_profiles\" (\"id\", \"owner_id\", \"name\", \"canonical_model_id\", \"default_reasoning_effort\", \"discovery_managed\", \"routing_policy\", \"created_at\", \"updated_at\") values ($1, $2, $3, default, default, default, default, default, default)";
pub(super) fn routes_insert(
    rows: &[serde_json::Value],
    original: &[Value],
) -> (String, Vec<Value>) {
    let mut params = vec![];
    let values = rows
        .iter()
        .zip(original)
        .map(|(row, input)| {
            let first = params.len() + 1;
            params.extend([
                Value::from_serialize(&row["id"]),
                Value::from_serialize(&row["model_id"]),
                input["providerId"].clone(),
                input["modelName"].clone(),
                Value::from_serialize(&row["position"]),
                input["enabled"].clone(),
            ]);
            format!(
                "(${}, ${}, ${}, default, ${}, ${}, ${}, default, default, default)",
                first,
                first + 1,
                first + 2,
                first + 3,
                first + 4,
                first + 5
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!(
            "insert into \"model_routes\" (\"id\", \"model_id\", \"provider_id\", \"provider_model_id\", \"model_name\", \"position\", \"enabled\", \"discovery_managed\", \"created_at\", \"updated_at\") values {values}"
        ),
        params,
    )
}
