//! Node and Rust execute the same transactional projection and keyset queries.
use crate::{database::Database, wire::Value};
use anyhow::{Context, Result};
use std::sync::Arc;

pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    async fn expire_interactions(&self) -> Result<()> {
        crate::agent_interactions::Repository::new(crate::database::Executor::Database(
            &self.database,
        ))
        .expire(None)
        .await?;
        Ok(())
    }
    pub async fn apply(&self, owner: &str, input: &Value) -> Result<Option<Value>> {
        let event = crate::settings::parse_response("projectAlertProjectionSchema", Some(input))?;
        let serialized = serde_json::to_string(&event)?;
        let rows = self
            .database
            .query(
                "SELECT project_alert_apply($1,$2::text::jsonb)::text",
                &[&owner, &serialized],
            )
            .await?;
        optional(
            rows.first()
                .context("Alert projection result")?
                .get::<Option<String>>(0)?,
            "projectAlertSchema",
        )
    }
    pub async fn list(&self, owner: &str, project: &str, query: &Value) -> Result<Option<Value>> {
        let query = crate::settings::parse_response("projectAlertQuerySchema", Some(query))?;
        self.expire_interactions().await?;
        let limit = query["limit"].as_i64().context("Alert page limit")? as i32;
        let after = query["after"].as_str();
        let rows = self
            .database
            .query(
                "SELECT project_alert_page($1,$2,$3,$4)::text",
                &[&owner, &project, &limit, &after],
            )
            .await?;
        optional(
            rows.first()
                .context("Alert page result")?
                .get::<Option<String>>(0)?,
            "projectAlertPageSchema",
        )
    }
    pub async fn counts(&self, owner: &str) -> Result<Value> {
        self.expire_interactions().await?;
        let rows = self
            .database
            .query("SELECT project_alert_counts($1)::text", &[&owner])
            .await?;
        optional(
            rows.first()
                .context("Alert counts result")?
                .get::<Option<String>>(0)?,
            "projectAlertCountsSchema",
        )?
        .context("Alert counts")
    }
}
fn optional(raw: Option<String>, schema: &str) -> Result<Option<Value>> {
    raw.map(|text| {
        let value: Value = serde_json::from_str(&text)?;
        crate::settings::parse_response(schema, Some(&value))
    })
    .transpose()
}
