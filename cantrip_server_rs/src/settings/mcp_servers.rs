//! Opaque MCP settings. Execute the reference builders' SQL and retain their
//! diagnostics only after the actual operation fails.
use super::repository::SettingsRepository;
use crate::{
    database::{Row, query_error},
    wire::{Value, value::json},
    workers::repository::WorkerRepository,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use std::sync::OnceLock;

fn query(name: &str) -> &'static str {
    static QUERIES: OnceLock<serde_json::Value> = OnceLock::new();
    QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/mcp-settings-queries.json"))
            .expect("MCP Source query manifest")
    })["queries"][name]["sql"]
        .as_str()
        .expect("MCP Source SQL")
}
fn text(input: &Value, key: &str) -> Result<String> {
    Ok(input[key]
        .as_js_string()
        .context("MCP field")?
        .lossy()
        .into_owned())
}
fn summary(row: &Row) -> Result<Value> {
    let project = row.get::<Option<String>>(2)?;
    Ok(json!({
        "id":row.get::<String>(0)?,"audience":row.get::<String>(7)?,
        "scope":if project.as_ref().is_some_and(|p|!p.is_empty()) {"project"} else {"global"},
        "projectId":project,"workerId":row.get::<Option<String>>(3)?,
        "enabled":row.get::<bool>(6)?,"nameBlindIndex":row.get::<String>(4)?,
        "protectedConfiguration":Value::from_serialize(&row.get::<serde_json::Value>(5)?),
        "createdAt":crate::auth::iso(row.get::<DateTime<Utc>>(8)?),
        "updatedAt":crate::auth::iso(row.get::<DateTime<Utc>>(9)?)
    }))
}
impl SettingsRepository {
    async fn owns_mcp_project(&self, owner: &str, project: Option<&str>) -> Result<bool> {
        let Some(project) = project.filter(|p| !p.is_empty()) else {
            return Ok(true);
        };
        let sql = query("project-project-check");
        Ok(!query_error::context(
            self.database.query(sql, &[&project, &owner, &1_i64]).await,
            sql,
            &[json!(project), json!(owner), json!(1)],
        )?
        .is_empty())
    }
    async fn check_mcp_worker(&self, owner: &str, input: &Value) -> Result<Option<String>> {
        let worker = input["workerId"]
            .as_js_string()
            .map(|s| s.lossy().into_owned());
        if let Some(worker) = &worker {
            anyhow::ensure!(
                WorkerRepository::new(self.database.clone())
                    .get_worker_with_query_context(
                        owner,
                        worker,
                        Some((
                            query("worker-lookup"),
                            // SQL uses UTF-8, but Source diagnostics retain the
                            // original JavaScript UTF-16 parameter value.
                            &[input["workerId"].clone(), json!(owner), json!(1)],
                        ))
                    )
                    .await?
                    .is_some(),
                "The selected MCP worker is not available to this account."
            );
        }
        Ok(worker)
    }
    pub async fn list_mcp_servers(
        &self,
        owner: &str,
        project: Option<&str>,
    ) -> Result<Option<Value>> {
        let project = project.filter(|p| !p.is_empty());
        if !self.owns_mcp_project(owner, project).await? {
            return Ok(None);
        }
        let rows = if let Some(project) = project {
            self.database
                .query(query("project-list"), &[&owner, &project])
                .await?
        } else {
            self.database.query(query("global-list"), &[&owner]).await?
        };
        Ok(Some(Value::Array(
            rows.iter().map(summary).collect::<Result<_>>()?,
        )))
    }
    pub async fn create_mcp_server(
        &self,
        owner: &str,
        project: Option<&str>,
        input: &Value,
    ) -> Result<Option<Value>> {
        let project = project.filter(|p| !p.is_empty());
        if !self.owns_mcp_project(owner, project).await? {
            return Ok(None);
        }
        let worker = self.check_mcp_worker(owner, input).await?;
        let (id, blind, audience) = (
            text(input, "id")?,
            text(input, "nameBlindIndex")?,
            text(input, "audience")?,
        );
        let protected: serde_json::Value =
            serde_json::from_str(&input["protectedConfiguration"].stringify())?;
        let enabled = input["enabled"].as_bool().context("MCP enabled")?;
        let params = vec![
            input["id"].clone(),
            json!(owner),
            json!(project),
            input["workerId"].clone(),
            input["nameBlindIndex"].clone(),
            json!(input["protectedConfiguration"].stringify()),
            input["enabled"].clone(),
            input["audience"].clone(),
        ];
        let sql = query(if project.is_some() {
            "project-create"
        } else {
            "global-create"
        });
        let rows = query_error::context(
            self.database
                .query(
                    sql,
                    &[
                        &id, &owner, &project, &worker, &blind, &protected, &enabled, &audience,
                    ],
                )
                .await,
            sql,
            &params,
        )?;
        rows.first().map(summary).transpose()?.map_or_else(
            || {
                Err(anyhow::anyhow!(
                    "Database returned no row after creating an MCP server."
                ))
            },
            |v| Ok(Some(v)),
        )
    }
    pub async fn update_mcp_server(
        &self,
        owner: &str,
        project: Option<&str>,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        // Source checks the requested worker before testing server/scope ownership.
        let worker = self.check_mcp_worker(owner, input).await?;
        let project = project.filter(|p| !p.is_empty());
        let blind = text(input, "nameBlindIndex")?;
        let protected: serde_json::Value =
            serde_json::from_str(&input["protectedConfiguration"].stringify())?;
        let enabled = input["enabled"].as_bool().context("MCP enabled")?;
        let audience = input
            .get("audience")
            .map(|_| text(input, "audience"))
            .transpose()?;
        let at = crate::auth::now();
        let mut params = vec![
            input["workerId"].clone(),
            input["nameBlindIndex"].clone(),
            json!(input["protectedConfiguration"].stringify()),
            input["enabled"].clone(),
        ];
        let mut bound: Vec<&(dyn postgres_types::ToSql + Sync)> =
            vec![&worker, &blind, &protected, &enabled];
        if let Some(audience) = &audience {
            params.push(json!(audience));
            bound.push(audience);
        }
        params.extend([json!(crate::auth::iso(at)), json!(id), json!(owner)]);
        bound.extend([&at as &(dyn postgres_types::ToSql + Sync), &id, &owner]);
        if let Some(project) = &project {
            params.push(json!(project));
            bound.push(project);
        }
        let name = format!(
            "{}-update-{}",
            if project.is_some() {
                "project"
            } else {
                "global"
            },
            audience.is_some()
        );
        let sql = query(&name);
        let rows = query_error::context(self.database.query(sql, &bound).await, sql, &params)?;
        rows.first().map(summary).transpose()
    }
    pub async fn delete_mcp_server(
        &self,
        owner: &str,
        project: Option<&str>,
        id: &str,
    ) -> Result<bool> {
        let project = project.filter(|p| !p.is_empty());
        let mut params = vec![json!(id), json!(owner)];
        let sql = query(if project.is_some() {
            "project-delete"
        } else {
            "global-delete"
        });
        let rows = if let Some(project) = project {
            params.push(json!(project));
            query_error::context(
                self.database.query(sql, &[&id, &owner, &project]).await,
                sql,
                &params,
            )?
        } else {
            query_error::context(self.database.query(sql, &[&id, &owner]).await, sql, &params)?
        };
        Ok(!rows.is_empty())
    }
}
