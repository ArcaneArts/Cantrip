//! Canonical remote-surface execution contexts and status publication.
use crate::{
    database::Database, live::LiveService, projects::targets::TargetRepository, wire::Value,
};
use anyhow::Result;
use std::sync::Arc;
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn context(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        TargetRepository::new(self.database.clone())
            .remote_execution_context(owner, &Value::String(id.into()))
            .await
    }
    /// Source browser bootstrap uses independent source reads and one bulk
    /// INSERT. Existing surfaces, including their chosen worker, stay intact.
    pub async fn ensure_browsers(&self, owner: &str) -> Result<()> {
        let rows = self.database.query("SELECT b.id,b.project_id FROM browsers b INNER JOIN projects p ON p.id=b.project_id AND p.owner_id=$1 LEFT JOIN remote_surfaces r ON r.id=b.id WHERE r.id IS NULL", &[&owner]).await?;
        let missing = rows
            .iter()
            .map(|row| Ok((row.get::<String>(0)?, row.get::<String>(1)?)))
            .collect::<Result<Vec<_>>>()?;
        let selected = futures::future::try_join_all(missing.iter().map(|(id, project)| async move {
            let rows = self.database.query("SELECT w.worker_id FROM projects p INNER JOIN project_sources s ON s.project_id=p.id INNER JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true LEFT JOIN user_settings u ON u.user_id=p.owner_id WHERE p.id=$1 AND p.owner_id=$2 AND s.removed_at IS NULL AND w.lifecycle_state='ready' ORDER BY coalesce(s.worker_id=p.preferred_worker_id,false) DESC,coalesce(s.worker_id=u.default_worker_id,false) DESC,s.created_at ASC,s.id ASC LIMIT 1", &[&project,&owner]).await?;
            rows.first().map(|row| Ok::<_,anyhow::Error>((id.clone(),project.clone(),row.get::<String>(0)?))).transpose()
        })).await?;
        let selected = selected.into_iter().flatten().collect::<Vec<_>>();
        if selected.is_empty() {
            return Ok(());
        }
        let mut parameters: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
        let mut values = Vec::new();
        for (i, (id, project, worker)) in selected.iter().enumerate() {
            parameters.extend([
                id as &(dyn tokio_postgres::types::ToSql + Sync),
                project,
                worker,
            ]);
            values.push(format!(
                "(${},${},${},'browser','webrtc','{{\"kind\":\"browser\",\"profileId\":null}}')",
                i * 3 + 1,
                i * 3 + 2,
                i * 3 + 3
            ));
        }
        self.database.query(&format!("INSERT INTO remote_surfaces(id,project_id,worker_id,kind,preferred_transport,configuration) VALUES {} ON CONFLICT DO NOTHING",values.join(",")),&parameters).await?;
        Ok(())
    }
    pub async fn set_status(&self, id: &str, status: &str, last_error: Option<&str>) -> Result<()> {
        if status == "active" {
            let connected = crate::auth::now();
            let updated = crate::auth::now();
            self.database.query("UPDATE remote_surfaces SET status=$2,last_error=$3,last_connected_at=$4,updated_at=$5 WHERE id=$1",&[&id,&status,&last_error,&connected,&updated]).await?;
        } else {
            let updated = crate::auth::now();
            self.database
                .query(
                    "UPDATE remote_surfaces SET status=$2,last_error=$3,updated_at=$4 WHERE id=$1",
                    &[&id, &status, &last_error, &updated],
                )
                .await?;
        }
        Ok(())
    }
    pub async fn record_status(
        &self,
        live: &LiveService,
        owner: &str,
        id: &str,
        status: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        self.set_status(id, status, last_error).await?;
        for resource in ["browser", "remote-desktop", "project-view"] {
            live.invalidate(owner, resource, id);
        }
        Ok(())
    }
    pub async fn reset_transient(&self) -> Result<()> {
        self.database.execute("UPDATE remote_surfaces SET status='idle',last_error=NULL,updated_at=now() WHERE status IN ('connecting','active','offline')").await
    }
}
