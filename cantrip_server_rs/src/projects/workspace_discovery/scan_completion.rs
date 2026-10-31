use super::*;
impl DiscoveryRepository {
    pub async fn complete_scan(&self, id: &str, command: &str, input: &Value) -> Result<Value> {
        let counts = crate::settings::parse_response(
            "workspaceRepositoryDiscoveryCountsSchema",
            input.get("counts"),
        )?;
        let items = input["candidates"]
            .as_array()
            .context("Discovery candidates")?;
        anyhow::ensure!(
            counts["candidates"].as_f64() == Some(items.len() as f64),
            DiscoveryError::Invariant("Repository discovery candidate counts do not match.")
        );
        let handle = |value: &Value| {
            crate::settings::parse_response("repositoryRoutingHandleSchema", Some(value))
        };
        let mut candidates = Vec::new();
        for item in items {
            let class = item
                .get("classification")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!("unclassified"));
            let class = crate::settings::parse_response(
                "workspaceRepositoryCandidateClassificationSchema",
                Some(&class),
            )?;
            let diagnostic = item
                .get("diagnosticCode")
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_js_string()
                        .context("Discovery diagnostic text")
                        .map(|s| s.trim())
                })
                .transpose()?;
            let diagnostic = if let Some(diagnostic) = diagnostic.filter(|s| !s.is_empty()) {
                crate::settings::parse_response(
                    "workspaceRepositoryCandidateDiagnosticCodeSchema",
                    Some(&Value::String(diagnostic)),
                )?
            } else {
                Value::Null
            };
            let display = handle(&item["displayHandle"])?;
            let origin = if crate::wire::coercion::truthy(item.get("originUrlHandle")) {
                handle(&item["originUrlHandle"])?
            } else {
                Value::Null
            };
            let github = if crate::wire::coercion::truthy(item.get("github")) {
                json!({"repositoryId":handle(&item["github"]["repositoryId"])?,"nameWithOwner":handle(&item["github"]["nameWithOwner"])?,"url":handle(&item["github"]["url"]) ?})
            } else {
                Value::Null
            };
            let path = handle(&item["pathHandle"])?;
            anyhow::ensure!(
                item["repositoryFingerprint"]
                    .as_js_string()
                    .is_some_and(|s| s.len() == 64
                        && s.units().iter().all(|u| matches!(*u,48..=57|97..=102))),
                DiscoveryError::Invariant("Repository discovery fingerprint is invalid.")
            );
            candidates.push(json!({"classification":class,"diagnosticCode":diagnostic,"displayHandle":display,"originUrlHandle":origin,"github":github,"pathHandle":path,"repositoryFingerprint":item["repositoryFingerprint"]}));
        }
        for candidate in &candidates {
            anyhow::ensure!(
                crate::wire::workspace_discovery::classification_valid(
                    candidate,
                    "originUrlHandle"
                ),
                DiscoveryError::Invariant(
                    "Repository discovery classification metadata is invalid."
                )
            );
        }
        let mut seen = std::collections::HashSet::new();
        anyhow::ensure!(
            candidates
                .iter()
                .all(|c| seen.insert(c["repositoryFingerprint"].clone().stringify())),
            DiscoveryError::Invariant("Repository discovery returned duplicate fingerprints.")
        );
        let (id, command, input) = (id.to_owned(), command.to_owned(), input.clone());
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM workspace_repository_discovery_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE", &[&id]).await?;
            let row=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(!row.is_null()&&row["state"]=="running"&&row["command_id"]==command&&row["attempt"]==input["attempt"], DiscoveryError::Stale("The repository discovery completion is no longer current."));
            let owner=text(&row["owner_id"])?;let workspace=text(&row["workspace_id"])?;let worker=text(&row["worker_id"])?;
            for candidate in &candidates {
                let candidate_id=uuid::Uuid::new_v4().to_string();let path=text(&candidate["pathHandle"])?;let display=text(&candidate["displayHandle"])?;let origin=optional(&candidate["originUrlHandle"])?;
                let github=&candidate["github"];let repository_id=optional(&github["repositoryId"])?;let name=optional(&github["nameWithOwner"])?;let url=optional(&github["url"])?;let fingerprint=text(&candidate["repositoryFingerprint"])?;let class=text(&candidate["classification"])?;let diagnostic=optional(&candidate["diagnosticCode"])?;
                tx.query("INSERT INTO workspace_repository_candidates(id,owner_id,job_id,workspace_id,worker_id,protected_path_handle,protected_display_handle,protected_origin_url_handle,protected_github_repository_id_handle,protected_github_name_with_owner_handle,protected_github_url_handle,repository_fingerprint,classification,diagnostic_code,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(workspace_id,repository_fingerprint) DO UPDATE SET job_id=excluded.job_id,worker_id=excluded.worker_id,protected_path_handle=excluded.protected_path_handle,protected_display_handle=excluded.protected_display_handle,protected_origin_url_handle=excluded.protected_origin_url_handle,protected_github_repository_id_handle=excluded.protected_github_repository_id_handle,protected_github_name_with_owner_handle=excluded.protected_github_name_with_owner_handle,protected_github_url_handle=excluded.protected_github_url_handle,classification=excluded.classification,diagnostic_code=excluded.diagnostic_code,updated_at=excluded.updated_at", &[&candidate_id,&owner,&id,&workspace,&worker,&path,&display,&origin,&repository_id,&name,&url,&fingerprint,&class,&diagnostic,&at]).await?;
            }
            let fingerprints=json!(candidates.iter().map(|c|c["repositoryFingerprint"].clone()).collect::<Vec<_>>());
            if candidates.is_empty() {
                tx.query("DELETE FROM workspace_repository_candidates WHERE workspace_id=$1 AND import_state IN ('pending','failed','skipped')", &[&workspace]).await?;
            }else{
                tx.query("DELETE FROM workspace_repository_candidates WHERE workspace_id=$1 AND import_state IN ('pending','failed','skipped') AND repository_fingerprint NOT IN (SELECT jsonb_array_elements_text($2::jsonb))", &[&workspace,&postgres_types::Json(fingerprints)]).await?;
            }
            let values=COUNTS.iter().map(|(field,_)|counts[*field].stringify()).collect::<Vec<_>>();
            let truncated=input["truncated"].as_bool().context("Discovery truncation flag")?;
            let rows=tx.query("UPDATE workspace_repository_discovery_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,completed_at=$3,last_error_code=NULL,error_retryable=NULL,truncated=$4,candidate_count=$5::text::integer,collapsed_repository_count=$6::text::integer,rejected_repository_count=$7::text::integer,scanned_directory_count=$8::text::integer,scanned_entry_count=$9::text::integer,skipped_symlink_count=$10::text::integer,unreadable_directory_count=$11::text::integer,updated_at=$3 WHERE id=$1 AND command_id=$2 RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&id,&command,&at,&truncated,&values[0],&values[1],&values[2],&values[3],&values[4],&values[5],&values[6]]).await?;
            let completed=raw(rows.first().context("Completing discovery job")?)?;
            let rows=tx.query("SELECT to_jsonb(c)::text FROM workspace_repository_candidates c WHERE workspace_id=$1 ORDER BY created_at ASC", &[&workspace]).await?;
            let candidates=rows.iter().map(|r|candidate(&raw(r)?,Value::Null)).collect::<Result<Vec<_>>>()?;
            crate::settings::parse_response("workspaceRepositoryDiscoverySnapshotSchema", Some(&json!({"job":job(&completed)?,"candidates":candidates})))
        })).await
    }
}
