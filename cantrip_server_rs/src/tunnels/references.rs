use super::management::ManagementError;
use super::*;
impl Repository {
    pub(super) async fn references_owned(
        &self,
        owner: &str,
        project: Option<&str>,
        source: &Value,
        destination: &Value,
    ) -> Result<bool> {
        let worker_id = |endpoint: &Value| {
            endpoint["workerId"]
                .as_js_string()
                .cloned()
                .context("Tunnel workerId")
        };
        let mut workers = Vec::new();
        if source["kind"] == "worker-listener" {
            workers.push(worker_id(source)?);
        }
        let destination = worker_id(destination)?;
        if !workers.contains(&destination) {
            workers.push(destination);
        }
        // JS Set membership precedes PostgreSQL's lossy UTF-8 binding. Distinct
        // lone-surrogate IDs must retain their original cardinality even when
        // both SQL parameters become the same replacement-character ID.
        let bound_workers = workers
            .iter()
            .map(|w| w.lossy().into_owned())
            .collect::<Vec<_>>();
        let project = project.filter(|s| !s.is_empty());
        // All three reads are admitted before evaluating project ownership or
        // placement errors, just as the reference's Promise.all does.
        let (projects, owned, sources) = tokio::join!(
            async {
                match project { None=>Ok(Vec::new()),Some(project)=>self.database.query("SELECT git_capability,id,origin_kind,preferred_worker_id FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1",&[&project,&owner]).await }
            },
            async {
                self.database.query("SELECT id FROM workers WHERE owner_id=$1 AND unlinked_at IS NULL AND id=ANY($2::text[])",&[&owner,&bound_workers]).await
            },
            async {
                match project { None=>Ok(Vec::new()),Some(project)=>self.database.query("SELECT project_sources.worker_id FROM project_sources INNER JOIN project_worktrees ON project_worktrees.project_source_id=project_sources.id AND project_worktrees.is_primary=true AND project_worktrees.lifecycle_state='ready' WHERE project_sources.project_id=$1 AND project_sources.removed_at IS NULL",&[&project]).await }
            }
        );
        let (projects, owned, sources) = (projects?, owned?, sources?);
        let row = projects.first();
        if project.is_some() && row.is_none() {
            return Ok(false);
        }
        if let Some(row) = row {
            let git = row.get::<bool>(0)?;
            let preferred: Option<crate::wire::JsString> =
                row.get::<Option<String>>(3)?.map(Into::into);
            if row.get::<String>(2)? == "managed-folder" {
                if !git && workers.iter().any(|w| Some(w) != preferred.as_ref()) {
                    return Err(ManagementError(
                        "This worker-managed folder is bound to its owning worker.",
                    )
                    .into());
                }
                let ready: Vec<crate::wire::JsString> = sources
                    .iter()
                    .map(|r| r.get::<String>(0).map(Into::into))
                    .collect::<Result<Vec<_>>>()?;
                if git && workers.iter().any(|w| !ready.contains(w)) {
                    return Err(ManagementError(
                        "This local Git project has no ready source on the selected worker.",
                    )
                    .into());
                }
            }
        }
        Ok(owned.len() == workers.len())
    }
}
