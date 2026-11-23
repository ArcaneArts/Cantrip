use super::Repository;
use crate::wire::Value;
use anyhow::{Context, Result};
use indexmap::IndexMap;

impl Repository {
    pub async fn effective_mcp_servers(
        &self,
        owner: &str,
        project: Option<&str>,
        worker: &str,
        audience: &str,
    ) -> Result<Vec<Value>> {
        let project = project.filter(|id| !id.is_empty());
        let rows = self.database.query("SELECT to_jsonb(m)::text FROM mcp_servers m WHERE m.owner_id=$1 AND m.enabled=true AND m.audience IN ($4,'both') AND (m.project_id IS NULL OR m.project_id=$2) AND (m.worker_id IS NULL OR m.worker_id=$3) ORDER BY m.name_blind_index ASC,m.created_at ASC", &[&owner,&project,&worker,&audience]).await?;
        let mut selected = IndexMap::new();
        for row in rows {
            let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
            let key = row["name_blind_index"]
                .as_js_string()
                .context("MCP blind index")?
                .clone();
            let priority = if project.is_some_and(|id| row["project_id"] == id) {
                2
            } else {
                0
            } + if row["worker_id"] == worker { 1 } else { 0 };
            let replace = selected
                .get(&key)
                .is_none_or(|(current, _)| priority > *current);
            if replace {
                selected.insert(key, (priority, row));
            }
        }
        Ok(selected
            .into_values()
            .map(|(_, row)| {
                Value::object([
                    ("id", row["id"].clone()),
                    ("enabled", row["enabled"].clone()),
                    ("nameBlindIndex", row["name_blind_index"].clone()),
                    (
                        "protectedConfiguration",
                        row["protected_configuration"].clone(),
                    ),
                ])
            })
            .collect())
    }
}
