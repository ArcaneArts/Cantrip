//! Node and Rust execute the same transactional projection and keyset queries.
mod reconcile;
use crate::{database::Database, wire::Value};
use anyhow::{Context, Result};
pub use reconcile::worker_connected;
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
    pub async fn register_goal_worker(
        &self,
        owner: &str,
        worker: &str,
        generation: &str,
    ) -> Result<()> {
        self.database
            .query(
                "UPDATE workers SET project_goal_generation=$3 WHERE id=$2 AND owner_id=$1",
                &[&owner, &worker, &generation],
            )
            .await?;
        Ok(())
    }
    pub async fn goal_chats(
        &self,
        owner: &str,
        worker: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        let rows = self
            .database
            .query(
                "SELECT project_alert_goal_chats($1,$2,$3)::text",
                &[&owner, &worker, &after],
            )
            .await?;
        let raw = rows
            .first()
            .context("Known Goal sources")?
            .get::<String>(0)?;
        let chats: Vec<String> = serde_json::from_str(&raw)?;
        anyhow::ensure!(chats.len() <= 100, "Invalid Goal source page");
        Ok(chats)
    }
    pub async fn observe_goal(&self, owner: &str, input: &Value) -> Result<Value> {
        let input = crate::settings::parse_response("projectGoalObservationSchema", Some(input))?;
        let worker = input["workerId"].as_str();
        let serialized = input.stringify();
        let rows = self
            .database
            .query(
                "SELECT project_alert_observe_goal($1,$2,$3::text::jsonb)::text",
                &[&owner, &worker, &serialized],
            )
            .await?;
        optional(
            rows.first()
                .context("Goal observation result")?
                .get::<Option<String>>(0)?,
            "projectGoalObservationResultSchema",
        )?
        .context("Goal observation result")
    }
    pub async fn apply_agent(
        &self,
        owner: &str,
        context: &Value,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = crate::settings::parse_response("agentAlertMutationWireSchema", Some(input))?;
        let event = crate::wire::value::json!({"projectId":context["projectId"],"chatId":context["chatId"],"source":"agent","sourceId":context["chatId"],"episodeId":input["key"],"sourceRevision":input["revision"],"status":input["status"],"kind":input["kind"],"target":crate::wire::value::json!({"kind":"chat","chatId":context["chatId"],"turnId":Value::Null}),"protectedDetail":input["protectedDetail"],"occurredAt":crate::auth::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        let event = crate::settings::parse_response("projectAlertProjectionSchema", Some(&event))?;
        let serialized = event.stringify();
        let chat = context["chatId"].as_str();
        let worker = context["workerId"].as_str();
        let lane = context["executionLaneId"].as_str();
        let rows = self
            .database
            .query(
                "SELECT project_alert_agent_apply($1,$2,$3,$4,$5::text::jsonb)::text",
                &[&owner, &chat, &worker, &lane, &serialized],
            )
            .await?;
        optional(
            rows.first()
                .context("Agent Alert result")?
                .get::<Option<String>>(0)?,
            "projectAlertSchema",
        )
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
