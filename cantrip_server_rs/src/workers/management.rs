//! Worker management preserves runtime names, owner scope and unlink fencing.
use super::{
    repository::WorkerRepository,
    rows::{self, WORKER},
};
use crate::{auth::now, wire::Value as WireValue};
use anyhow::Result;
use serde_json::{Value, json};

pub struct ManagementRecord {
    pub worker: Value,
    pub runtime_name: String,
    pub credential_count: i64,
    pub active_credential_count: i64,
    pub sources: Vec<Value>,
}

impl WorkerRepository {
    pub async fn list_management(&self, owner: &str) -> Result<Vec<ManagementRecord>> {
        let workers=self.database.query(&format!("SELECT {WORKER},name FROM workers WHERE owner_id=$1 AND unlinked_at IS NULL ORDER BY name ASC"),&[&owner]).await?;
        futures::future::try_join_all(workers.into_iter().map(|row|async move {
            let worker=row.get::<String>(0)?;
            let credential_parameters:crate::database::Parameters<'_>=&[&owner,&worker];
            let source_parameters:crate::database::Parameters<'_>=&[&worker,&owner];
            let (credentials,sources)=futures::try_join!(
                self.database.query("SELECT count(*),count(*) FILTER(WHERE revoked_at IS NULL) FROM worker_credentials WHERE owner_id=$1 AND worker_id=$2",credential_parameters),
                self.database.query("SELECT s.id,p.id,coalesce(p.github_repository_full_name,s.display_path),s.display_path FROM project_sources s INNER JOIN projects p ON p.id=s.project_id WHERE s.worker_id=$1 AND p.owner_id=$2 AND s.removed_at IS NULL ORDER BY p.github_repository_full_name ASC",source_parameters)
            )?;
            let credential=&credentials[0];
            Ok(ManagementRecord {
                worker:rows::worker(&row)?,runtime_name:row.get(18)?,
                credential_count:credential.get(0)?,
                // Source counts all unrevoked credentials here, including
                // expired ones. Credential DTO.active has a different meaning.
                active_credential_count:credential.get(1)?,
                sources:sources.iter().map(|r|Ok(json!({"projectReplicaId":r.get::<String>(0)?,"projectId":r.get::<String>(1)?,"nameWithOwner":r.get::<String>(2)?,"displayPath":r.get::<String>(3)?}))).collect::<Result<_>>()?,
            })
        })).await
    }

    pub async fn update_display_name(
        &self,
        owner: &str,
        worker: &str,
        name: &WireValue,
    ) -> Result<Option<Value>> {
        let name = super::request::text(name)
            .ok_or_else(|| anyhow::anyhow!("Validated worker display name"))?;
        let rows=self.database.query(&format!("UPDATE workers SET display_name=$3,updated_at=$4 WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL RETURNING {WORKER}"),&[&worker,&owner,&name,&now()]).await?;
        rows.first().map(rows::worker).transpose()
    }

    pub async fn unlink(&self, owner: &str, worker: &str) -> Result<bool> {
        let at = now();
        let (owner, worker) = (owner.to_owned(), worker.to_owned());
        self.database.transaction(move|tx|Box::pin(async move {
            if tx.query("SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1 FOR UPDATE",&[&worker,&owner]).await?.is_empty(){return Ok(false);}
            tx.query("UPDATE worker_credentials SET revoked_at=$3,revoked_reason='worker unlinked by owner',updated_at=$3 WHERE owner_id=$1 AND worker_id=$2 AND revoked_at IS NULL",&[&owner,&worker,&at]).await?;
            let rows=tx.query("UPDATE workers SET unlinked_at=$3,updated_at=$3 WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL RETURNING id",&[&worker,&owner,&at]).await?;
            Ok(!rows.is_empty())
        })).await
    }
}
