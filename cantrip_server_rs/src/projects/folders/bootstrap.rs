use super::*;
use crate::database::Transaction;

impl FolderRepository {
    pub async fn ensure_default_workspace(&self, owner: &str) -> Result<Value> {
        let owner = owner.to_owned();
        self.database.transaction(|tx|Box::pin(async move {
            let id=format!("workspace:default:{owner}");
            // Preserve the independent reads and broad ON CONFLICT behavior.
            let initial=tx.query("SELECT is_default FROM project_workspaces WHERE owner_id=$1",&[&owner]).await?;
            let is_default=!initial.iter().map(|r|r.get::<bool>(0)).collect::<Result<Vec<_>>>()?.into_iter().any(|v|v);
            tx.query("INSERT INTO project_workspaces(id,owner_id,position,is_default) VALUES($1,$2,0,$3) ON CONFLICT DO NOTHING",&[&id,&owner,&is_default]).await?;
            let workspaces=tx.query("SELECT id FROM project_workspaces WHERE owner_id=$1",&[&owner]).await?;
            let profiles=tx.query("SELECT s.workspace_id FROM project_workspace_storage_profiles s INNER JOIN project_workspaces w ON w.id=s.workspace_id WHERE w.owner_id=$1",&[&owner]).await?;
            let present=profiles.iter().map(|r|r.get::<String>(0)).collect::<Result<std::collections::HashSet<_>>>()?;
            let missing=workspaces.iter().map(|r|r.get::<String>(0)).collect::<Result<Vec<_>>>()?.into_iter().filter(|v|!present.contains(v)).collect::<Vec<_>>();
            if !missing.is_empty() {
                // One INSERT, as in the source bulk insert (including its defaults).
                let mut params:Vec<&(dyn tokio_postgres::types::ToSql+Sync)>=Vec::new();
                let kinds=missing.iter().map(|v|if *v==id {"system"} else {"legacy"}).collect::<Vec<_>>();
                let mut values=Vec::new();
                for (i,(workspace,kind)) in missing.iter().zip(&kinds).enumerate() {
                    params.push(workspace);params.push(kind);values.push(format!("(${},${})",i*2+1,i*2+2));
                }
                tx.query(&format!("INSERT INTO project_workspace_storage_profiles(workspace_id,kind) VALUES {} ON CONFLICT DO NOTHING",values.join(",")),&params).await?;
            }
            let profiles=tx.query("SELECT to_jsonb(w)::text,s.kind FROM project_workspace_storage_profiles s INNER JOIN project_workspaces w ON w.id=s.workspace_id WHERE w.owner_id=$1",&[&owner]).await?;
            let profiles=profiles.iter().map(|r|Ok((raw(r)?,r.get::<String>(1)?))).collect::<Result<Vec<_>>>()?;
            let current=profiles.iter().find(|(value,_)|value["is_default"]==true);
            if let Some((current,kind))=current && kind!="attached" { return Ok(current.clone()); }
            let at=crate::auth::now();
            if let Some((current,_))=current {
                let current_id=text(&current["id"])?;
                tx.query("UPDATE project_workspaces SET is_default=false,revision=revision+1,updated_at=$2 WHERE id=$1",&[&current_id,&at]).await?;
            }
            let rows=tx.query("UPDATE project_workspaces SET is_default=true,revision=revision+1,updated_at=$3 WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(project_workspaces)::text",&[&id,&owner,&at]).await?;
            raw(rows.first().context("restoring the system workspace default")?)
        })).await
    }

    pub async fn workspace_storage(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT s.kind,s.worker_id,m.workspace_id FROM project_workspace_memberships m INNER JOIN project_workspaces w ON w.id=m.workspace_id INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=m.workspace_id WHERE m.project_id=$1 AND w.owner_id=$2 LIMIT 1",&[&project,&owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let kind = row.get::<String>(0)?;
        let mut result = Value::object([("kind", Value::String(kind.clone().into()))]);
        if matches!(kind.as_str(), "managed" | "attached") {
            result["workspaceId"] = Value::String(row.get::<String>(2)?.into());
        }
        if kind == "attached" {
            result["workerId"] = row
                .get::<Option<String>>(1)?
                .map_or(Value::Null, |v| Value::String(v.into()));
        }
        Ok(Some(
            crate::wire::parse("projectWorkspaceStorageContextSchema", Some(&result))
                .map_err(|_| anyhow::anyhow!("Invalid workspace storage context"))?,
        ))
    }
}

pub(super) async fn update_project(
    tx: &Transaction<'_>,
    project: &str,
    at: chrono::DateTime<chrono::Utc>,
) -> Result<()> {
    tx.query(
        "UPDATE projects SET setup_status='preparing',setup_error=NULL,updated_at=$2 WHERE id=$1",
        &[&project, &at],
    )
    .await?;
    Ok(())
}
