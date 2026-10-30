use super::*;
use std::collections::HashMap;
impl DiscoveryRepository {
    pub async fn snapshot(&self, owner: &str, workspace: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT to_jsonb(j)::text FROM workspace_repository_discovery_jobs j WHERE owner_id=$1 AND workspace_id=$2 LIMIT 1", &[&owner,&workspace]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let job_row = raw(row)?;
        let candidates=self.database.query("SELECT to_jsonb(c)::text FROM workspace_repository_candidates c WHERE owner_id=$1 AND workspace_id=$2 ORDER BY created_at ASC", &[&owner,&workspace]).await?.iter().map(raw).collect::<Result<Vec<_>>>()?;
        let fingerprints = json!(
            candidates
                .iter()
                .map(|c| c["repository_fingerprint"].clone())
                .collect::<Vec<_>>()
        );
        let github_ids = json!(
            candidates
                .iter()
                .filter_map(|c| c
                    .get("protected_github_repository_id_handle")
                    .filter(|v| crate::wire::coercion::truthy(Some(v)))
                    .cloned())
                .collect::<Vec<_>>()
        );
        let worker = text(&job_row["worker_id"])?;
        let mut checkouts = HashMap::new();
        if !candidates.is_empty() {
            let rows=self.database.query("SELECT p.id,s.repository_fingerprint,m.workspace_id FROM project_sources s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 INNER JOIN project_workspace_memberships m ON m.project_id=p.id WHERE s.removed_at IS NULL AND s.worker_id=$2 AND s.repository_fingerprint IN (SELECT jsonb_array_elements_text($3::jsonb)) ORDER BY s.created_at ASC", &[&owner,&worker,&postgres_types::Json(fingerprints)]).await?;
            for row in rows {
                if let Some(fingerprint) = row.get::<Option<String>>(1)? {
                    checkouts.insert(fingerprint,json!({"code":"duplicate-checkout","kind":"checkout","projectId":row.get::<String>(0)?,"workspaceId":row.get::<String>(2)?}));
                }
            }
        }
        let mut github = HashMap::new();
        if github_ids.as_array().is_some_and(|v| !v.is_empty()) {
            let rows=self.database.query("SELECT p.id,p.github_repository_id,m.workspace_id FROM projects p INNER JOIN project_workspace_memberships m ON m.project_id=p.id WHERE p.owner_id=$1 AND p.github_repository_id IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY p.created_at ASC", &[&owner,&postgres_types::Json(github_ids)]).await?;
            for row in rows {
                if let Some(id) = row.get::<Option<String>>(1)? {
                    github.insert(id,json!({"code":"duplicate-github","kind":"github","projectId":row.get::<String>(0)?,"workspaceId":row.get::<String>(2)?}));
                }
            }
        }
        let mut values = Vec::new();
        for row in &candidates {
            let conflict = checkouts
                .get(&text(&row["repository_fingerprint"])?)
                .cloned()
                .or_else(|| {
                    row["protected_github_repository_id_handle"]
                        .as_str()
                        .and_then(|id| github.get(id))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            values.push(candidate(row, conflict)?);
        }
        Ok(Some(crate::settings::parse_response(
            "workspaceRepositoryDiscoverySnapshotSchema",
            Some(&json!({"job":job(&job_row)?,"candidates":values})),
        )?))
    }
}
