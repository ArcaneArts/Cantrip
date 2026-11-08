//! Owner-scoped encrypted surface writes preserve Source's independent reads/CAS.
use super::{Repository, StateConflict};
use crate::{
    projects::targets::remote_summary,
    wire::{self, Value, coercion, value::json},
};
use anyhow::{Context, Result};
use futures::FutureExt;
use postgres_types::Json;

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Remote Surface identity")?
        .lossy()
        .into_owned())
}
fn summary(raw: &Value, title: Value) -> Result<Value> {
    remote_summary(
        raw,
        title,
        raw["protected_state"].clone(),
        raw["state_revision"].clone(),
    )
}
impl Repository {
    pub(super) async fn creation_owned(
        &self,
        owner: &str,
        project: &str,
        worker: &str,
    ) -> Result<bool> {
        let projects: crate::database::Parameters<'_> = &[&project, &owner];
        let workers: crate::database::Parameters<'_> = &[&worker, &owner];
        let (projects, workers) = tokio::try_join!(
            self.database
                .query(
                    "SELECT id FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1",
                    projects
                )
                .boxed(),
            self.database
                .query(
                    "SELECT id FROM workers WHERE id=$1 AND owner_id=$2 LIMIT 1",
                    workers
                )
                .boxed(),
        )?;
        Ok(!projects.is_empty() && !workers.is_empty())
    }
    pub async fn create(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
        let worker = text(&input["workerId"])?;
        // Public generic creation is browser-only; callers that accept desktop
        // configurations must resolve their captured OS execution separately.
        if !self.creation_owned(owner, project, &worker).await? {
            return Ok(None);
        }
        let id = text(&input["id"])?;
        let kind = text(&input["configuration"]["kind"])?;
        let title = Json(&input["titleProtection"]);
        let state = input.get("stateProtection").map(Json);
        let revision = state.as_ref().map(|_| 1i32);
        let configuration = Json(&input["configuration"]);
        let rows=self.database.query("INSERT INTO remote_surfaces(id,project_id,worker_id,kind,protected_label,protected_state,state_revision,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING to_jsonb(remote_surfaces)::text",&[&id,&project,&worker,&kind,&title,&state,&revision,&configuration]).await?;
        let row = rows
            .first()
            .context("Database returned no row after creating a Remote Surface.")?;
        let raw: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        Ok(Some(summary(&raw, raw["protected_label"].clone())?))
    }
    pub async fn update(&self, owner: &str, id: &str, input: &Value) -> Result<Option<Value>> {
        let Some(context) = self.context(owner, id).await? else {
            return Ok(None);
        };
        let surface = &context["surface"];
        if input
            .get("configuration")
            .is_some_and(|v| v["kind"] != surface["kind"])
            || input.get("stateProtection").is_some_and(|v| {
                v["classification"]["recordKind"]
                    != if surface["kind"] == "browser" {
                        "browser-state"
                    } else {
                        "remote-desktop-state"
                    }
            })
        {
            return Ok(None);
        }
        if coercion::truthy(input.get("titleProtection")) {
            let classification = wire::property(surface.get("titleProtection"), "classification")?;
            if wire::property(classification, "recordKind")? != Some(&json!("remote-surface")) {
                return Ok(None);
            }
        }
        let now = crate::auth::now();
        let body = Json(input);
        let rows=self.database.query(
            "UPDATE remote_surfaces SET protected_label=CASE WHEN $2::jsonb?'titleProtection' THEN $2::jsonb->'titleProtection' ELSE protected_label END,configuration=CASE WHEN $2::jsonb?'configuration' THEN $2::jsonb->'configuration' ELSE configuration END,protected_state=CASE WHEN $2::jsonb?'stateProtection' THEN $2::jsonb->'stateProtection' ELSE protected_state END,state_revision=CASE WHEN $2::jsonb?'stateProtection' THEN ($2::jsonb->>'expectedStateRevision')::integer+1 ELSE state_revision END,preferred_transport=CASE WHEN $2::jsonb?'preferredTransport' THEN $2::jsonb->>'preferredTransport' ELSE preferred_transport END,updated_at=$3 WHERE id=$1 AND (NOT($2::jsonb?'expectedStateRevision') OR state_revision=($2::jsonb->>'expectedStateRevision')::integer) RETURNING to_jsonb(remote_surfaces)::text",
            &[&id,&body,&now],
        ).await?;
        let Some(row) = rows.first() else {
            if input.get("expectedStateRevision").is_some() {
                return Err(StateConflict.into());
            }
            return Ok(None);
        };
        let raw: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let title = raw
            .get("protected_label")
            .filter(|v| !v.is_null())
            .unwrap_or(&surface["titleProtection"])
            .clone();
        Ok(Some(summary(&raw, title)?))
    }
    pub async fn delete(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let context = self.context(owner, id).await?;
        if context.is_some() {
            self.database
                .query("DELETE FROM remote_surfaces WHERE id=$1", &[&id])
                .await?;
        }
        Ok(context)
    }
}
