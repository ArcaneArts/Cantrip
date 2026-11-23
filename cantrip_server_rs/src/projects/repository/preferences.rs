//! Owned project preferences and atomic catalog ordering.
use super::{ProjectRepository, project};
use crate::{
    database::Row,
    wire::{JsString, Value, coercion::truthy},
    workers::repository::WorkerRepository,
};
use anyhow::{Context, Result};

#[derive(Debug)]
pub struct PreferredWorkerConflict(pub &'static str);
impl std::fmt::Display for PreferredWorkerConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for PreferredWorkerConflict {}

impl ProjectRepository {
    async fn updated_summary(
        &self,
        owner: &str,
        id: &str,
        row: Option<&Row>,
    ) -> Result<Option<Value>> {
        let Some(row) = row else { return Ok(None) };
        let raw = serde_json::from_str(&row.get::<String>(0)?)?;
        let replicas = self.replicas(owner, id).await?.unwrap_or_default();
        Ok(Some(project(&raw, replicas, row.get(1)?, row.get(2)?)?))
    }

    pub async fn update_worktree_policy(
        &self,
        owner: &str,
        id: &str,
        policy: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query("UPDATE projects SET worktree_policy=$3,updated_at=$4 WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(projects)::text,created_at,updated_at", &[&id,&owner,&policy,&crate::auth::now()]).await?;
        self.updated_summary(owner, id, rows.first()).await
    }

    pub async fn update_preferred_worker(
        &self,
        owner: &str,
        id: &str,
        worker: Option<JsString>,
    ) -> Result<Option<Value>> {
        if let Some(worker) = &worker
            && WorkerRepository::new(self.database.clone())
                .get_worker(owner, &worker.lossy())
                .await?
                .is_none()
        {
            return Ok(None);
        }
        let projects = self.database.query("SELECT origin_kind,git_capability,preferred_worker_id FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&id,&owner]).await?;
        let Some(row) = projects.first() else {
            return Ok(None);
        };
        if let Some(worker) = &worker {
            let replicas = self.replicas(owner, id).await?.unwrap_or_default();
            let origin: String = row.get(0)?;
            let git: bool = row.get(1)?;
            if origin == "managed-folder" {
                if git {
                    anyhow::ensure!(
                        replicas
                            .iter()
                            .any(|r| r["workerId"].as_js_string() == Some(worker)
                                && truthy(r.get("ready"))),
                        PreferredWorkerConflict(
                            "Attach a ready local Git source on this worker before selecting it as preferred."
                        )
                    );
                } else {
                    let preferred: Option<String> = row.get(2)?;
                    let preferred = preferred.map(JsString::from);
                    let bound = preferred
                        .as_ref()
                        .or_else(|| replicas.first().and_then(|r| r["workerId"].as_js_string()));
                    anyhow::ensure!(
                        bound == Some(worker),
                        PreferredWorkerConflict(
                            "This folder project is bound to its owning worker."
                        )
                    );
                }
            }
        }
        let stored_worker = worker.map(|w| w.lossy().into_owned());
        let rows=self.database.query("UPDATE projects SET preferred_worker_id=$3,updated_at=$4 WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(projects)::text,created_at,updated_at", &[&id,&owner,&stored_worker,&crate::auth::now()]).await?;
        self.updated_summary(owner, id, rows.first()).await
    }

    pub async fn reorder(&self, owner: &str, ids: Vec<JsString>) -> Result<bool> {
        let rows = self
            .database
            .query("SELECT id FROM projects WHERE owner_id=$1", &[&owner])
            .await?;
        let existing = rows
            .iter()
            .map(|r| r.get::<String>(0).map(JsString::from))
            .collect::<Result<Vec<_>>>()?;
        if existing.len() != ids.len() || existing.iter().any(|id| !ids.contains(id)) {
            return Ok(false);
        }
        let owner = owner.to_owned();
        self.database
            .transaction(move |tx| {
                Box::pin(async move {
                    for (position, id) in ids.iter().enumerate() {
                        let position = i32::try_from(position).context("Project position")?;
                        let id = id.lossy().into_owned();
                        tx.query(
                            "UPDATE projects SET position=$2 WHERE id=$1 AND owner_id=$3",
                            &[&id, &position, &owner],
                        )
                        .await?;
                    }
                    Ok(true)
                })
            })
            .await
    }
}
