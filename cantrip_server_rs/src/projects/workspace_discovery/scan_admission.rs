use super::*;
impl DiscoveryRepository {
    pub async fn queue_scan(
        &self,
        owner: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let depth = input
            .get("depth")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(-1));
        anyhow::ensure!(
            depth
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && (-1.0..=16.0).contains(&n)),
            DiscoveryError::Invariant("Workspace repository discovery depth is invalid.")
        );
        let (owner, workspace, input) = (owner.to_owned(), workspace.to_owned(), input.clone());
        let at = crate::auth::now();
        let depth = depth.stringify();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT jsonb_build_object('workspace',to_jsonb(w),'storage',to_jsonb(s))::text FROM project_workspaces w INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=w.id WHERE w.id=$1 AND w.owner_id=$2 LIMIT 1 FOR UPDATE", &[&workspace,&owner]).await?;
            let workspace_row=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            let storage=&workspace_row["storage"];
            anyhow::ensure!(storage["kind"]=="attached"&&crate::wire::coercion::truthy(storage.get("worker_id"))&&crate::wire::coercion::truthy(storage.get("protected_root_path_handle")), DiscoveryError::Invariant("Repository discovery is available only for attached workspaces."));
            let existing=tx.query("SELECT to_jsonb(j)::text FROM workspace_repository_discovery_jobs j WHERE workspace_id=$1 LIMIT 1 FOR UPDATE", &[&workspace]).await?;
            let rows=if let Some(row)=existing.first() {
                let row=raw(row)?;
                if row["state"]=="running"||input.get("expectedStateRevision").is_some_and(|v|*v!=row["state_revision"]) {return Ok(None)};
                let id=text(&row["id"])?;let revision=row["state_revision"].stringify();
                tx.query("UPDATE workspace_repository_discovery_jobs SET state='queued',state_revision=state_revision+1,depth=$2::text::integer,command_id=NULL,last_error_code=NULL,error_retryable=NULL,truncated=false,candidate_count=NULL,collapsed_repository_count=NULL,rejected_repository_count=NULL,scanned_directory_count=NULL,scanned_entry_count=NULL,skipped_symlink_count=NULL,unreadable_directory_count=NULL,available_at=$3,lease_expires_at=NULL,completed_at=NULL,updated_at=$3 WHERE id=$1 AND state_revision=$4::text::integer RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&id,&depth,&at,&revision]).await?
            } else {
                if input.get("expectedStateRevision").is_some() {return Ok(None)};
                let id=uuid::Uuid::new_v4().to_string();let worker=text(&storage["worker_id"])?;
                tx.query("INSERT INTO workspace_repository_discovery_jobs(id,owner_id,workspace_id,worker_id,state,depth,available_at,updated_at) VALUES($1,$2,$3,$4,'queued',$5::text::integer,$6,$6) RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&id,&owner,&workspace,&worker,&depth,&at]).await?
            };
            rows.first().map(raw).transpose()
        })).await?;
        row.as_ref().map(job).transpose()
    }
}
