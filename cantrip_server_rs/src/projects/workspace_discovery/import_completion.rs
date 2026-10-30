use super::*;
impl DiscoveryRepository {
    pub async fn complete_import(&self, claimed: &Value, result: &Value) -> Result<Value> {
        let (claimed, result) = (claimed.clone(), result.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let id=text(&claimed["candidateId"])?;
            let rows=tx.query("SELECT jsonb_build_object('candidate',to_jsonb(c),'job',to_jsonb(j),'storage',to_jsonb(s))::text FROM workspace_repository_candidates c INNER JOIN workspace_repository_discovery_jobs j ON j.id=c.job_id INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=c.workspace_id WHERE c.id=$1 LIMIT 1 FOR UPDATE", &[&id]).await?;
            let selected=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);let candidate=&selected["candidate"];let storage=&selected["storage"];
            anyhow::ensure!(!selected.is_null()&&candidate["import_state"]=="importing"&&candidate["import_command_id"]==claimed["commandId"]&&candidate["import_attempt"]==result["attempt"]&&result["candidateId"]==candidate["id"]&&result["repositoryFingerprint"]==candidate["repository_fingerprint"]&&storage["kind"]=="attached"&&storage["worker_id"]==candidate["worker_id"], DiscoveryError::ImportStale("The repository import completion is no longer current."));
            let owner=text(&claimed["ownerId"])?;let worker=text(&claimed["workerId"])?;let fingerprint=text(&result["repositoryFingerprint"])?;
            let checkouts=tx.query("SELECT p.id,m.workspace_id FROM project_sources s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 INNER JOIN project_workspace_memberships m ON m.project_id=p.id WHERE s.worker_id=$2 AND s.repository_fingerprint=$3 AND s.removed_at IS NULL ORDER BY s.created_at ASC LIMIT 1", &[&owner,&worker,&fingerprint]).await?;
            let github=&result["github"];let blind=optional(&claimed["repositoryBlindIndex"])?;
            let conflicts=if crate::wire::coercion::truthy(result.get("github")) {
                let repository=text(&github["repositoryId"])?;
                if crate::wire::coercion::truthy(claimed.get("repositoryBlindIndex")) {
                    tx.query("SELECT p.id,m.workspace_id FROM projects p INNER JOIN project_workspace_memberships m ON m.project_id=p.id WHERE p.owner_id=$1 AND (p.github_repository_id=$2 OR p.github_repository_blind_index=$3) ORDER BY p.created_at ASC LIMIT 1", &[&owner,&repository,&blind]).await?
                } else {
                    tx.query("SELECT p.id,m.workspace_id FROM projects p INNER JOIN project_workspace_memberships m ON m.project_id=p.id WHERE p.owner_id=$1 AND p.github_repository_id=$2 ORDER BY p.created_at ASC LIMIT 1", &[&owner,&repository]).await?
                }
            }else{Vec::new()};
            if let Some(conflict)=checkouts.first().or(conflicts.first()) {
                let project=conflict.get::<String>(0)?;
                tx.query("UPDATE workspace_repository_candidates SET import_state='skipped',import_project_id=$2,import_command_id=NULL,import_error_code=NULL,import_error_retryable=NULL,import_available_at=NULL,import_lease_expires_at=NULL,updated_at=$3 WHERE id=$1", &[&id,&project,&at]).await?;
            }else{
                let project=text(&claimed["projectId"])?;
                anyhow::ensure!(tx.query("SELECT id FROM projects WHERE id=$1 LIMIT 1", &[&project]).await?.is_empty(), DiscoveryError::Invariant("Repository import project identity already exists."));
                let github_import=result["classification"]=="github-accessible"&&crate::wire::coercion::truthy(result.get("github"))&&crate::wire::coercion::truthy(claimed.get("repositoryBlindIndex"));
                let last=tx.query("SELECT position FROM projects WHERE owner_id=$1 ORDER BY position DESC LIMIT 1", &[&owner]).await?;
                let position=(last.first().map(|r|r.get::<i32>(0)).transpose()?.map(i64::from).unwrap_or(-1)+1).to_string();
                let origin=if github_import {"github"}else{"managed-folder"};let management=(!github_import).then_some("external");let policy=if github_import {"agent-managed"}else{"direct"};
                let repository_blind=if github_import {blind}else{None};let repository=if github_import {optional(&github["repositoryId"])?}else{None};let name=if github_import {optional(&github["nameWithOwner"])?}else{None};let url=if github_import {optional(&github["url"])?}else{None};
                tx.query("INSERT INTO projects(id,owner_id,protected_label,position,origin_kind,folder_management,setup_status,setup_error,worktree_policy,git_capability,github_capability,preferred_worker_id,github_repository_blind_index,github_repository_id,github_repository_full_name,github_repository_url,created_at,updated_at) VALUES($1,$2,$3,$4::text::integer,$5,$6,'ready',NULL,$7,true,$8,$9,$10,$11,$12,$13,$14,$14)", &[&project,&owner,&postgres_types::Json(&claimed["nameProtection"]),&position,&origin,&management,&policy,&github_import,&worker,&repository_blind,&repository,&name,&url,&at]).await?;
                let workspace=text(&claimed["workspaceId"])?;
                tx.query("INSERT INTO project_workspace_memberships(workspace_id,project_id,created_at) VALUES($1,$2,$3)", &[&workspace,&project,&at]).await?;
                let source=uuid::Uuid::new_v4().to_string();let path=text(&result["path"])?;let display=text(&result["displayPath"])?;
                tx.query("INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path,placement_mode,ownership_kind,requested_path,link_path,repository_fingerprint,created_at,updated_at) VALUES($1,$2,$3,'git',$4,$5,'direct','user',$4,NULL,$6,$7,$7)", &[&source,&project,&worker,&path,&display,&fingerprint,&at]).await?;
                let tree=uuid::Uuid::new_v4().to_string();let branch=optional(&result["branch"])?;let head=optional(&result["head"])?;let detached=!result["head"].is_null()&&result["branch"].is_null();
                tx.query("INSERT INTO project_worktrees(id,project_source_id,worker_id,root_kind,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state,branch,head,detached,last_scanned_at,created_at,updated_at) VALUES($1,$2,$3,'git-worktree','Primary',$4,$5,true,true,'external','ready',$6,$7,$8,$9,$9,$9)", &[&tree,&source,&worker,&path,&display,&branch,&head,&detached,&at]).await?;
                let class=text(&result["classification"])?;let diagnostic=optional(&result["diagnosticCode"])?;let origin_url=optional(&result["originUrl"])?;let repository=optional(&github["repositoryId"])?;let name=optional(&github["nameWithOwner"])?;let url=optional(&github["url"])?;
                tx.query("UPDATE workspace_repository_candidates SET classification=$2,diagnostic_code=$3,protected_path_handle=$4,protected_origin_url_handle=$5,protected_github_repository_id_handle=$6,protected_github_name_with_owner_handle=$7,protected_github_url_handle=$8,import_state='imported',import_command_id=NULL,import_error_code=NULL,import_error_retryable=NULL,import_available_at=NULL,import_lease_expires_at=NULL,updated_at=$9 WHERE id=$1", &[&id,&class,&diagnostic,&path,&origin_url,&repository,&name,&url,&at]).await?;
            }
            let parent=text(&selected["job"]["id"])?;let revision=selected["job"]["state_revision"].stringify();
            let rows=tx.query("UPDATE workspace_repository_discovery_jobs SET state_revision=$2::text::integer+1,updated_at=$3 WHERE id=$1 RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&parent,&revision,&at]).await?;
            raw(rows.first().context("Completing repository import")?)
        })).await?;
        job(&row)
    }
}
