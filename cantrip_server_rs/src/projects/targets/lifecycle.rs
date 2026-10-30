//! Reconcile a worker inventory atomically while retaining existing worktree identity.
use super::{TargetRepository, reads};
use crate::wire::{Value, value::json};
use anyhow::{Context, Result, bail};
use std::collections::{HashMap, HashSet};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("Worktree inventory field")
}
fn lifecycle(observed: &Value) -> &'static str {
    if observed["missing"] == true {
        "missing"
    } else if observed["prunable"] == true {
        "prunable"
    } else {
        "ready"
    }
}

impl TargetRepository {
    pub async fn reconcile_worktrees(
        &self,
        owner: &str,
        project: &str,
        worker: &str,
        inventory: &Value,
        created: Option<&Value>,
    ) -> Result<Option<Vec<Value>>> {
        let rows = self.database.query("SELECT to_jsonb(s)::text FROM project_sources s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE p.id=$2 AND s.worker_id=$3 AND s.removed_at IS NULL LIMIT 1", &[&owner,&project,&worker]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let source = reads::parse(row.get(0)?)?;
        if source["source_kind"] != "git" {
            bail!("Git worktree reconciliation is unavailable for folder sources.");
        }
        let observed = inventory["worktrees"]
            .as_array()
            .context("Worktree inventory")?;
        let primaries = observed
            .iter()
            .filter(|item| item["isPrimary"] == true)
            .collect::<Vec<_>>();
        if primaries.len() != 1 {
            bail!("Worker inventory did not contain exactly one Primary.");
        }
        if source["absolute_path"] != primaries[0]["path"] {
            bail!("Worker inventory referred to a different replica path.");
        }
        if source["repository_fingerprint"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
            && source["repository_fingerprint"] != inventory["repositoryFingerprint"]
        {
            bail!("Worker inventory belongs to a different Git common directory.");
        }
        let observed = observed.clone();
        let fingerprint = inventory["repositoryFingerprint"].clone();
        let created = created.cloned();
        self.database.transaction(|tx| Box::pin(async move {
            let now = crate::auth::now();
            let source_id = text(&source,"id")?;
            let existing = tx.query("SELECT to_jsonb(w)::text FROM project_worktrees w WHERE project_source_id=$1", &[&source_id]).await?.into_iter().map(|row| reads::parse(row.get(0)?)).collect::<Result<Vec<_>>>()?;
            let primary = existing.iter().find(|item| item["is_primary"] == true).context("Project source has no Primary worktree.")?;
            tx.query("UPDATE project_sources SET absolute_path=$1,repository_fingerprint=$2,updated_at=$3 WHERE id=$4", &[&text(&source,"absolute_path")?,&fingerprint.as_str(),&now,&source_id]).await?;
            let by_path = existing.iter().map(|row| Ok((text(row,"absolute_path")?,row))).collect::<Result<HashMap<_,_>>>()?;
            let mut seen = HashSet::new();
            for item in &observed {
                let path = text(item,"path")?;
                let matched = if item["isPrimary"] == true { Some(primary) } else { by_path.get(path).copied() };
                let creation = created.as_ref().filter(|created| created["path"] == path);
                let id = matched.map(|row| row["id"].clone()).or_else(|| creation.map(|row| row["id"].clone())).unwrap_or_else(|| Value::String(uuid::Uuid::new_v4().to_string().into()));
                seen.insert(id.as_str().context("Worktree id")?.to_owned());
                let name = matched.map(|row| row["name"].clone()).or_else(|| creation.map(|row| row["name"].clone())).unwrap_or_else(|| item.get("branch").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::String("External worktree".into())));
                let display = matched.map(|row| row["display_path"].clone()).unwrap_or_else(|| if item["isPrimary"] == true { source["display_path"].clone() } else { item["path"].clone() });
                let origin = matched.map(|row| row["origin"].clone()).or_else(|| creation.map(|row| row["origin"].clone())).unwrap_or_else(|| Value::String("external".into()));
                let values = json!({"id":id,"worker":source["worker_id"],"name":name,"path":path,"display":display,"primary":item["isPrimary"],"default":matched.map(|row|row["is_default"].clone()).unwrap_or_else(||item["isPrimary"].clone()),"origin":origin,"lifecycle":lifecycle(item),"branch":item["branch"],"head":item["head"],"detached":item["detached"],"locked":item["locked"],"lockReason":item["lockReason"]});
                let values = postgres_types::Json(values);
                if matched.is_some() {
                    tx.query("UPDATE project_worktrees SET worker_id=$1::jsonb->>'worker',name=$1::jsonb->>'name',absolute_path=$1::jsonb->>'path',display_path=$1::jsonb->>'display',is_primary=($1::jsonb->>'primary')::boolean,is_default=($1::jsonb->>'default')::boolean,origin=$1::jsonb->>'origin',lifecycle_state=$1::jsonb->>'lifecycle',branch=$1::jsonb->>'branch',head=$1::jsonb->>'head',detached=($1::jsonb->>'detached')::boolean,locked=($1::jsonb->>'locked')::boolean,lock_reason=$1::jsonb->>'lockReason',last_scanned_at=$2,updated_at=$2 WHERE id=$1::jsonb->>'id'", &[&values,&now]).await?;
                } else {
                    tx.query("INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state,branch,head,detached,locked,lock_reason,last_scanned_at,updated_at) VALUES($1::jsonb->>'id',$2,$1::jsonb->>'worker',$1::jsonb->>'name',$1::jsonb->>'path',$1::jsonb->>'display',($1::jsonb->>'primary')::boolean,($1::jsonb->>'default')::boolean,$1::jsonb->>'origin',$1::jsonb->>'lifecycle',$1::jsonb->>'branch',$1::jsonb->>'head',($1::jsonb->>'detached')::boolean,($1::jsonb->>'locked')::boolean,$1::jsonb->>'lockReason',$3,$3)", &[&values,&source_id,&now]).await?;
                }
            }
            for missing in &existing {
                let id = text(missing,"id")?;
                if missing["is_primary"] != true && !seen.contains(id) {
                    tx.query("UPDATE project_worktrees SET lifecycle_state='missing',updated_at=$1,last_scanned_at=$1 WHERE id=$2", &[&now,&id]).await?;
                }
            }
            Ok(())
        })).await?;
        Ok(Some(
            reads::Reads::new(self.database.clone())
                .worktrees(owner, project)
                .await?,
        ))
    }
}
