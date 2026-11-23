use super::*;
impl DiscoveryRepository {
    pub async fn queue_imports(
        &self,
        owner: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (owner, workspace, input) = (owner.to_owned(), workspace.to_owned(), input.clone());
        let at = crate::auth::now();
        let retained_owner = owner.clone();
        let retained_workspace = workspace.clone();
        let queued=self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM workspace_repository_discovery_jobs j WHERE owner_id=$1 AND workspace_id=$2 LIMIT 1 FOR UPDATE", &[&owner,&workspace]).await?;
            let row=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            if row.is_null()||row["state"]!="succeeded"||row["state_revision"]!=input["expectedStateRevision"] {return Ok(false)};
            let id=text(&row["id"])?;let requests=input["candidates"].as_array().context("Import candidates")?;
            let ids=json!(requests.iter().map(|r|r["candidateId"].clone()).collect::<Vec<_>>());
            let rows=tx.query("SELECT to_jsonb(c)::text FROM workspace_repository_candidates c WHERE owner_id=$1 AND workspace_id=$2 AND job_id=$3 AND id IN (SELECT jsonb_array_elements_text($4::jsonb)) FOR UPDATE", &[&owner,&workspace,&id,&postgres_types::Json(ids)]).await?;
            anyhow::ensure!(rows.len()==requests.len(), DiscoveryError::Invariant("Repository import referenced an unknown discovery candidate."));
            let rows=rows.iter().map(raw).collect::<Result<Vec<_>>>()?;
            for requested in requests {
                let candidate=rows.iter().find(|r|r["id"]==requested["candidateId"]).context("Selected import candidate")?;
                anyhow::ensure!(candidate["classification"]!="github-accessible"||crate::wire::coercion::truthy(requested.get("repositoryBlindIndex")), DiscoveryError::Invariant("GitHub repository import requires a protected identity index."));
                anyhow::ensure!(!matches!(candidate["classification"].as_str(),Some("unclassified"|"unsupported")), DiscoveryError::Invariant("This repository candidate is not eligible for automatic import."));
                if matches!(candidate["import_state"].as_str(),Some("imported"|"skipped"|"importing")) {continue};
                anyhow::ensure!(candidate["import_state"]!="queued"||candidate["import_project_id"]==requested["projectId"], DiscoveryError::Invariant("Repository import is already queued with another project identity."));
                let candidate_id=text(&candidate["id"])?;let project=text(&requested["projectId"])?;
                let name=requested.get("nameProtection").unwrap_or(&candidate["protected_import_name"]);
                let blind=optional(requested.get("repositoryBlindIndex").unwrap_or(&candidate["import_repository_blind_index"]))?;
                tx.query("UPDATE workspace_repository_candidates SET import_state='queued',import_project_id=$2,protected_import_name=$3,import_repository_blind_index=$4,import_command_id=NULL,import_error_code=NULL,import_error_retryable=NULL,import_available_at=$5,import_lease_expires_at=NULL,updated_at=$5 WHERE id=$1", &[&candidate_id,&project,&postgres_types::Json(name),&blind,&at]).await?;
            }
            let revision=row["state_revision"].stringify();
            tx.query("UPDATE workspace_repository_discovery_jobs SET state_revision=$2::text::integer+1,updated_at=$3 WHERE id=$1", &[&id,&revision,&at]).await?;
            Ok(true)
        })).await?;
        if queued {
            self.snapshot(&retained_owner, &retained_workspace).await
        } else {
            Ok(None)
        }
    }
    pub async fn claim_import(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT jsonb_build_object('candidate',to_jsonb(c),'job',to_jsonb(j),'rootPathHandle',s.protected_root_path_handle)::text FROM workspace_repository_candidates c INNER JOIN workspace_repository_discovery_jobs j ON j.id=c.job_id AND j.state='succeeded' INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=c.workspace_id AND s.worker_id=c.worker_id AND s.kind='attached' WHERE c.import_state='queued' AND c.import_available_at<=$1 ORDER BY c.import_available_at ASC,c.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED", &[&at]).await?;
            let Some(row)=rows.first() else {return Ok(None)};let selected=raw(row)?;let candidate=&selected["candidate"];
            if !crate::wire::coercion::truthy(candidate.get("import_project_id"))||!crate::wire::coercion::truthy(candidate.get("protected_import_name"))||!crate::wire::coercion::truthy(selected.get("rootPathHandle")) {return Ok(None)};
            let id=text(&candidate["id"])?;let command=uuid::Uuid::new_v4().to_string();let expires=at+chrono::Duration::minutes(2);
            let rows=tx.query("UPDATE workspace_repository_candidates SET import_state='importing',import_attempt=import_attempt+1,import_command_id=$2,import_lease_expires_at=$3,import_error_code=NULL,import_error_retryable=NULL,updated_at=$4 WHERE id=$1 AND import_state='queued' RETURNING to_jsonb(workspace_repository_candidates)::text", &[&id,&command,&expires,&at]).await?;
            let Some(row)=rows.first() else {return Ok(None)};let row=raw(row)?;
            let job_id=text(&selected["job"]["id"])?;let revision=selected["job"]["state_revision"].stringify();
            tx.query("UPDATE workspace_repository_discovery_jobs SET state_revision=$2::text::integer+1,updated_at=$3 WHERE id=$1", &[&job_id,&revision,&at]).await?;
            Ok(Some(json!({"attempt":row["import_attempt"],"candidateId":row["id"],"commandId":command,"expectedRepositoryFingerprint":row["repository_fingerprint"],"nameProtection":row["protected_import_name"],"ownerId":row["owner_id"],"pathHandle":row["protected_path_handle"],"projectId":row["import_project_id"],"repositoryBlindIndex":row["import_repository_blind_index"],"rootPathHandle":selected["rootPathHandle"],"workerId":row["worker_id"],"workspaceId":row["workspace_id"]})))
        })).await
    }
}
