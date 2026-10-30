//! The existing policy mutation routes expose Drizzle's query-error context.
//! Preserve that response contract when an actual native database query fails;
//! this does not predict or suppress database operations.
use crate::wire::JsString;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

pub(super) const COLUMNS: &str = "\"id\", \"owner_id\", \"key_blind_index\", \"protected_summary\", \"protected_body\", \"enabled\", \"mandatory\", \"audience\", \"position\", \"template_key\", \"row_version\", \"created_at\", \"updated_at\"";
pub(super) fn select(
    table: &str,
    fields: &str,
    filters: &[(&str, Value)],
    order: &str,
    limit: bool,
) -> (String, Vec<Value>) {
    let mut conditions = filters
        .iter()
        .enumerate()
        .map(|(i, (column, _))| format!("\"{table}\".\"{column}\" = ${}", i + 1))
        .collect::<Vec<_>>()
        .join(" and ");
    if filters.len() > 1 {
        conditions = format!("({conditions})");
    }
    let mut sql = format!("select {fields} from \"{table}\" where {conditions}{order}");
    let mut params = filters
        .iter()
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    if limit {
        params.push(json!(1));
        sql.push_str(&format!(" limit ${}", params.len()));
    }
    (sql, params)
}
pub(super) async fn transaction(
    tx: &crate::database::Transaction<'_>,
    sql: &str,
    params: crate::database::Parameters<'_>,
    reference: (String, Vec<Value>),
) -> anyhow::Result<Vec<crate::database::Row>> {
    context(tx.query(sql, params).await, &reference.0, &reference.1)
}
pub(super) fn owned_ids(owner: &str, ids: &[JsString]) -> (String, Vec<JsString>) {
    let placeholders = (2..=ids.len() + 1)
        .map(|n| format!("${n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut params = vec![owner.into()];
    params.extend(ids.iter().cloned());
    (
        format!(
            "select \"id\" from \"policies\" where (\"policies\".\"owner_id\" = $1 and \"policies\".\"id\" in ({placeholders}))"
        ),
        params,
    )
}
pub(super) fn delete_assignments(table: &str, column: &str, scope: &str) -> (String, Vec<Value>) {
    (
        format!("delete from \"{table}\" where \"{table}\".\"{column}\" = $1"),
        vec![json!(scope)],
    )
}
pub(super) fn reorder(
    owner: &str,
    id: &str,
    position: i32,
    at: DateTime<Utc>,
) -> (String, Vec<Value>) {
    ("update \"policies\" set \"position\" = $1, \"updated_at\" = $2 where (\"policies\".\"id\" = $3 and \"policies\".\"owner_id\" = $4)".into(),vec![json!(position),json!(crate::auth::iso(at)),json!(id),json!(owner)])
}
pub(super) fn assignment_ids(workspace: bool, owner: &str, scope: &str) -> (String, Vec<Value>) {
    let table = if workspace {
        "workspace_policy_assignments"
    } else {
        "project_policy_assignments"
    };
    let column = if workspace {
        "workspace_id"
    } else {
        "project_id"
    };
    (
        format!(
            "select \"{table}\".\"policy_id\" from \"{table}\" inner join \"policies\" on (\"policies\".\"id\" = \"{table}\".\"policy_id\" and \"policies\".\"owner_id\" = $1) where \"{table}\".\"{column}\" = $2"
        ),
        vec![json!(owner), json!(scope)],
    )
}
pub(super) fn ensure(owner: &str) -> (String, Vec<Value>) {
    ("insert into \"policy_owner_states\" (\"owner_id\", \"bootstrap_version\", \"collection_version\", \"created_at\", \"updated_at\") values ($1, default, default, default, default) on conflict do nothing".into(),vec![json!(owner)])
}
pub(super) fn increment(owner: &str, at: DateTime<Utc>) -> (String, Vec<Value>) {
    ("update \"policy_owner_states\" set \"collection_version\" = \"policy_owner_states\".\"collection_version\" + 1, \"updated_at\" = $1 where \"policy_owner_states\".\"owner_id\" = $2 returning \"collection_version\"".into(),vec![json!(crate::auth::iso(at)),json!(owner)])
}
pub(super) fn counts(workspace: bool, owner: &str) -> (String, Vec<Value>) {
    let table = if workspace {
        "workspace_policy_assignments"
    } else {
        "project_policy_assignments"
    };
    (
        format!(
            "select \"{table}\".\"policy_id\", count(*) from \"{table}\" inner join \"policies\" on (\"policies\".\"id\" = \"{table}\".\"policy_id\" and \"policies\".\"owner_id\" = $1) group by \"{table}\".\"policy_id\""
        ),
        vec![json!(owner)],
    )
}
pub(super) fn context<T>(
    result: anyhow::Result<T>,
    query: &str,
    parameters: &[Value],
) -> anyhow::Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(source) => {
            let parameters = parameters
                .iter()
                .map(|value| match value {
                    Value::Null => String::new(),
                    Value::String(value) => value.clone(),
                    value => value.to_string(),
                })
                .map(JsString::from)
                .collect::<Vec<_>>();
            context_wire(Err(source), query, &parameters)
        }
    }
}
#[derive(Debug)]
pub struct PolicyQueryError {
    pub message: JsString,
    source: anyhow::Error,
}
impl std::fmt::Display for PolicyQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for PolicyQueryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}
pub(super) fn context_wire<T>(
    result: anyhow::Result<T>,
    query: &str,
    parameters: &[JsString],
) -> anyhow::Result<T> {
    result.map_err(|source| {
        let mut units = format!("Failed query: {query}\nparams: ")
            .encode_utf16()
            .collect::<Vec<_>>();
        for (index, value) in parameters.iter().enumerate() {
            if index > 0 {
                units.push(u16::from(b','));
            }
            units.extend_from_slice(value.units());
        }
        PolicyQueryError {
            message: JsString::new(units),
            source,
        }
        .into()
    })
}
pub(super) async fn transaction_wire(
    tx: &crate::database::Transaction<'_>,
    sql: &str,
    params: crate::database::Parameters<'_>,
    reference: (String, Vec<JsString>),
) -> anyhow::Result<Vec<crate::database::Row>> {
    context_wire(tx.query(sql, params).await, &reference.0, &reference.1)
}
pub(super) fn insert(
    owner: &str,
    input: &Value,
    position: i64,
    at: DateTime<Utc>,
) -> (String, Vec<Value>) {
    let slots = (1..=13)
        .map(|index| format!("${index}"))
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!("insert into \"policies\" ({COLUMNS}) values ({slots}) returning {COLUMNS}"),
        vec![
            input["id"].clone(),
            json!(owner),
            input["content"]["keyBlindIndex"].clone(),
            json!(input["content"]["protectedSummary"].to_string()),
            json!(input["content"]["protectedBody"].to_string()),
            input["enabled"].clone(),
            input["mandatory"].clone(),
            input["audience"].clone(),
            json!(position),
            input["templateKey"].clone(),
            json!(1),
            json!(crate::auth::iso(at)),
            json!(crate::auth::iso(at)),
        ],
    )
}
pub(super) fn assignments(
    workspace: bool,
    scope: &str,
    ids: &[JsString],
) -> (String, Vec<JsString>) {
    let table = if workspace {
        "workspace_policy_assignments"
    } else {
        "project_policy_assignments"
    };
    let column = if workspace {
        "workspace_id"
    } else {
        "project_id"
    };
    let values = (0..ids.len())
        .map(|index| format!("(${}, ${}, default)", index * 2 + 1, index * 2 + 2))
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!(
            "insert into \"{table}\" (\"policy_id\", \"{column}\", \"created_at\") values {values}"
        ),
        ids.iter()
            .flat_map(|id| [id.clone(), JsString::from(scope)])
            .collect(),
    )
}
pub(super) fn claim(owner: &str, version: i64, at: DateTime<Utc>) -> (String, Vec<Value>) {
    ("update \"policy_owner_states\" set \"collection_version\" = $1, \"updated_at\" = $2 where (\"policy_owner_states\".\"owner_id\" = $3 and \"policy_owner_states\".\"collection_version\" = $4) returning \"collection_version\"".into(),
     vec![json!(version+1),json!(crate::auth::iso(at)),json!(owner),json!(version)])
}
pub(super) fn bootstrap(
    owner: &str,
    expected: i64,
    version: i32,
    at: DateTime<Utc>,
) -> (String, Vec<Value>) {
    ("update \"policy_owner_states\" set \"bootstrap_version\" = $1, \"collection_version\" = \"policy_owner_states\".\"collection_version\" + 1, \"updated_at\" = $2 where (\"policy_owner_states\".\"owner_id\" = $3 and \"policy_owner_states\".\"bootstrap_version\" = $4) returning \"owner_id\"".into(),
     vec![json!(version),json!(crate::auth::iso(at)),json!(owner),json!(expected)])
}
pub(super) fn delete(owner: &str, id: &str, version: i64) -> (String, Vec<Value>) {
    ("delete from \"policies\" where (\"policies\".\"id\" = $1 and \"policies\".\"owner_id\" = $2 and \"policies\".\"row_version\" = $3) returning \"id\"".into(),vec![json!(id),json!(owner),json!(version)])
}
pub(super) fn update(
    owner: &str,
    id: &str,
    input: &Value,
    version: i64,
    at: DateTime<Utc>,
) -> (String, Vec<Value>) {
    let mut fields = Vec::new();
    let mut parameters = Vec::new();
    for (column, key) in [
        ("protected_summary", "protectedSummary"),
        ("protected_body", "protectedBody"),
    ] {
        if let Some(value) = input.get("content").and_then(|value| value.get(key)) {
            parameters.push(json!(value.to_string()));
            fields.push(format!("\"{column}\" = ${}", parameters.len()));
        }
    }
    for (column, key) in [
        ("enabled", "enabled"),
        ("mandatory", "mandatory"),
        ("audience", "audience"),
    ] {
        if let Some(value) = input.get(key) {
            parameters.push(value.clone());
            fields.push(format!("\"{column}\" = ${}", parameters.len()));
        }
    }
    parameters.push(json!(version + 1));
    fields.push(format!("\"row_version\" = ${}", parameters.len()));
    parameters.push(json!(crate::auth::iso(at)));
    fields.push(format!("\"updated_at\" = ${}", parameters.len()));
    let position = parameters.len();
    parameters.extend([json!(id), json!(owner), json!(version)]);
    (
        format!(
            "update \"policies\" set {} where (\"policies\".\"id\" = ${} and \"policies\".\"owner_id\" = ${} and \"policies\".\"row_version\" = ${}) returning {COLUMNS}",
            fields.join(", "),
            position + 1,
            position + 2,
            position + 3
        ),
        parameters,
    )
}
