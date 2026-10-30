use super::*;
use crate::database::Transaction;
use sha2::{Digest, Sha256};
const REUSED_KEY: &str = "This idempotency key is already attached to a different replica request.";
const ACTIVE_PROVISION: &str = "A replica provision job is already active for this worker.";
const ACTIVE_OPERATION: &str = "Another operation is already active for this replica.";
fn unique(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<tokio_postgres::Error>()
            .and_then(|e| e.as_db_error())
            .is_some_and(|e| e.code().code() == "23505")
            || {
                let message = error.to_string().to_lowercase();
                message.contains("duplicate key") || message.contains("unique constraint")
            }
    })
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.stringify().as_bytes()))
}
fn local_git(project: &Value) -> bool {
    project["origin_kind"] == "managed-folder" && project["git_capability"] == true
}
fn conflict(message: &'static str) -> anyhow::Error {
    ReplicaError::Conflict(message).into()
}
impl ReplicaRepository {
    async fn existing(&self, owner: &str, key: &str) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(j)::text FROM project_replica_jobs j WHERE owner_id=$1 AND idempotency_key=$2 LIMIT 1",&[&owner,&key]).await?.first().map(raw).transpose()
    }
    async fn replay(&self, owner: &str, key: &str, fingerprint: &str) -> Result<Option<Value>> {
        let Some(row) = self.existing(owner, key).await? else {
            return Ok(None);
        };
        anyhow::ensure!(
            row["payload_fingerprint"] == fingerprint,
            ReplicaError::Conflict(REUSED_KEY)
        );
        summary(&row).map(Some)
    }
    async fn admitted(
        &self,
        result: Result<Value>,
        owner: &str,
        key: &str,
        fingerprint: &str,
        active: &'static str,
    ) -> Result<Value> {
        match result {
            Ok(row) => summary(&row),
            Err(error) if unique(&error) => {
                let row = self.existing(owner, key).await?;
                if let Some(row) = row
                    .as_ref()
                    .filter(|r| r["payload_fingerprint"] == fingerprint)
                {
                    return summary(row);
                }
                Err(conflict(if row.is_some() { REUSED_KEY } else { active }))
            }
            Err(error) => Err(error),
        }
    }
    pub async fn create_provision(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
    ) -> Result<Value> {
        let placement = input
            .get("placement")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!({"mode":"managed"}));
        let mut payload = json!({"kind":"provision","projectId":project});
        for key in ["workerId", "repository"] {
            if let Some(value) = input.get(key) {
                payload[key] = value.clone()
            }
        }
        payload["placement"] = placement.clone();
        if let Some(value) = input.get("expectedRevision") {
            payload["expectedRevision"] = value.clone()
        }
        let fingerprint = hash(&payload);
        let key = text(&input["idempotencyKey"])?;
        if let Some(job) = self.replay(owner, &key, &fingerprint).await? {
            return Ok(job);
        }
        let at = crate::auth::now();
        let (owned, project_owned, input, fingerprint_owned, key_owned) = (
            owner.to_owned(),
            project.to_owned(),
            input.clone(),
            fingerprint.clone(),
            key.clone(),
        );
        let result=self.database.transaction(|tx|Box::pin(async move {
            let worker=text(&input["workerId"])?;
            let rows=tx.query("SELECT jsonb_build_object('project',to_jsonb(p),'capabilities',w.project_replica_capabilities)::text FROM projects p INNER JOIN workers w ON w.id=$3 AND w.owner_id=$1 AND w.unlinked_at IS NULL WHERE p.id=$2 AND p.owner_id=$1 LIMIT 1",&[&owned,&project_owned,&worker]).await?;
            let target=raw(rows.first().ok_or(ReplicaError::NotFound("Project or target worker was not found."))?)?;
            let github=crate::wire::coercion::truthy(target["project"].get("github_repository_full_name"));let local=local_git(&target["project"]);
            anyhow::ensure!(github||local,ReplicaError::Conflict("Only GitHub-backed or local Git projects can add worker sources."));
            anyhow::ensure!(github!=input["repository"].is_null(),ReplicaError::Conflict(if github{"GitHub replica provisioning requires protected repository identity."}else{"Local Git source attachment cannot include GitHub repository identity."}));
            let mode=text(&placement["mode"])?;
            anyhow::ensure!(!local||(mode=="direct"&&crate::wire::coercion::truthy(input.get("expectedRevision"))),ReplicaError::Conflict("Local Git sources must attach an existing direct checkout at the project's current revision."));
            let caps=&target["capabilities"];
            let supported=mode=="managed"||if mode=="managed-link"{caps["managedLinkPlacement"]==true&&caps["recursiveParentCreation"]==true}else{caps["directPlacement"]==true&&caps["attachExisting"]==true&&(local||caps["recursiveParentCreation"]==true)};
            anyhow::ensure!(supported,ReplicaError::Conflict("The selected worker does not support this repository placement mode."));
            anyhow::ensure!(tx.query("SELECT id FROM project_sources WHERE project_id=$1 AND worker_id=$2 AND removed_at IS NULL LIMIT 1",&[&project_owned,&worker]).await?.is_empty(),ReplicaError::Conflict("This worker already has a replica of the project."));
            anyhow::ensure!(tx.query("SELECT id FROM project_replica_jobs WHERE project_id=$1 AND worker_id=$2 AND kind='provision' AND state IN ('queued','running','blocked') LIMIT 1",&[&project_owned,&worker]).await?.is_empty(),ReplicaError::Conflict(ACTIVE_PROVISION));
            let path=if mode=="managed"{None}else{optional(&placement["path"])?};
            insert(tx,NewJob{owner:&owned,project:&project_owned,replica:None,worker:&worker,kind:"provision",key:&key_owned,fingerprint:&fingerprint_owned,repository:optional(&input["repository"])?,mode:&mode,path,revision:optional(&input["expectedRevision"])?,policy:None,delete:None,at}).await
        })).await;
        self.admitted(result, owner, &key, &fingerprint, ACTIVE_PROVISION)
            .await
    }
    pub async fn create_synchronize(
        &self,
        owner: &str,
        project: &str,
        replica: &str,
        input: &Value,
    ) -> Result<Value> {
        self.create_operation(owner, project, replica, "synchronize", input)
            .await
    }
    pub async fn create_remove(
        &self,
        owner: &str,
        project: &str,
        replica: &str,
        input: &Value,
    ) -> Result<Value> {
        self.create_operation(owner, project, replica, "remove", input)
            .await
    }
    async fn create_operation(
        &self,
        owner: &str,
        project: &str,
        replica: &str,
        kind: &str,
        input: &Value,
    ) -> Result<Value> {
        let mut payload = json!({"kind":kind,"projectId":project,"projectReplicaId":replica});
        if let Value::Object(fields) = &mut payload {
            fields.extend(
                input
                    .as_object()
                    .context("Replica operation input")?
                    .clone(),
            );
        }
        let fingerprint = hash(&payload);
        let key = text(&input["idempotencyKey"])?;
        if let Some(job) = self.replay(owner, &key, &fingerprint).await? {
            return Ok(job);
        }
        let at = crate::auth::now();
        let (owned, project_owned, replica, kind, input, fingerprint_owned, key_owned) = (
            owner.to_owned(),
            project.to_owned(),
            replica.to_owned(),
            kind.to_owned(),
            input.clone(),
            fingerprint.clone(),
            key.clone(),
        );
        let result=self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT jsonb_build_object('project',to_jsonb(p),'source',to_jsonb(s))::text FROM project_sources s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 INNER JOIN workers w ON w.id=s.worker_id AND w.unlinked_at IS NULL WHERE p.id=$2 AND s.id=$3 AND s.removed_at IS NULL LIMIT 1 FOR UPDATE",&[&owned,&project_owned,&replica]).await?;
            let target=raw(rows.first().ok_or(ReplicaError::NotFound("Project replica or target worker was not found."))?)?;
            let github=crate::wire::coercion::truthy(target["project"].get("github_repository_full_name"));let local=local_git(&target["project"]);let source=&target["source"];
            anyhow::ensure!(github||local,ReplicaError::Conflict("Only GitHub-backed or local Git project sources support this operation."));
            anyhow::ensure!(github!=input["repository"].is_null(),ReplicaError::Conflict(if github{"GitHub replica operations require protected repository identity."}else{"Local Git source operations cannot include GitHub repository identity."}));
            anyhow::ensure!(!local||kind=="remove",ReplicaError::Conflict("Local Git sources do not support remote synchronization."));
            let delete=crate::wire::coercion::truthy(input.get("deleteLocalFiles"));
            anyhow::ensure!(!(local&&kind=="remove"&&delete),ReplicaError::Conflict("Detaching a local Git source never deletes its checkout."));
            anyhow::ensure!(!(kind=="remove"&&source["ownership_kind"]=="user"&&delete),ReplicaError::Conflict("This checkout existed before Cantrip and cannot be deleted."));
            if kind=="remove" {anyhow::ensure!(tx.query("SELECT id FROM project_sources WHERE project_id=$1 AND removed_at IS NULL",&[&project_owned]).await?.len()>1,ReplicaError::Conflict("The last project replica cannot be removed. Remove the project instead."));}
            let rows=if kind=="remove"{tx.query("SELECT id FROM project_replica_jobs WHERE (project_replica_id=$1 OR (project_id=$2 AND kind='remove')) AND state IN ('queued','running','blocked') LIMIT 1",&[&replica,&project_owned]).await?}else{tx.query("SELECT id FROM project_replica_jobs WHERE project_replica_id=$1 AND state IN ('queued','running','blocked') LIMIT 1",&[&replica]).await?};
            anyhow::ensure!(rows.is_empty(),ReplicaError::Conflict(ACTIVE_OPERATION));
            let worker=text(&source["worker_id"])?;let mode=text(&source["placement_mode"])?;
            insert(tx,NewJob{owner:&owned,project:&project_owned,replica:Some(&replica),worker:&worker,kind:&kind,key:&key_owned,fingerprint:&fingerprint_owned,repository:optional(&input["repository"])?,mode:&mode,path:optional(&source["requested_path"])?,revision:if kind=="synchronize"{optional(&input["expectedRevision"])?}else{None},policy:if kind=="synchronize"{optional(&input["policy"])?}else{None},delete:if kind=="remove"{input["deleteLocalFiles"].as_bool()}else{None},at}).await
        })).await;
        self.admitted(result, owner, &key, &fingerprint, ACTIVE_OPERATION)
            .await
    }
}
struct NewJob<'a> {
    owner: &'a str,
    project: &'a str,
    replica: Option<&'a str>,
    worker: &'a str,
    kind: &'a str,
    key: &'a str,
    fingerprint: &'a str,
    repository: Option<String>,
    mode: &'a str,
    path: Option<String>,
    revision: Option<String>,
    policy: Option<String>,
    delete: Option<bool>,
    at: chrono::DateTime<chrono::Utc>,
}
async fn insert(tx: &Transaction<'_>, job: NewJob<'_>) -> Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let progress = progress("queued", 0, job.at);
    let rows=tx.query("INSERT INTO project_replica_jobs(id,owner_id,project_id,project_replica_id,worker_id,kind,state,idempotency_key,payload_fingerprint,repository,placement_mode,placement_path,expected_revision,synchronization_policy,delete_local_files,progress,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13,$14,$15::text::jsonb,$16,$16,$16) RETURNING to_jsonb(project_replica_jobs)::text",&[&id,&job.owner,&job.project,&job.replica,&job.worker,&job.kind,&job.key,&job.fingerprint,&job.repository,&job.mode,&job.path,&job.revision,&job.policy,&job.delete,&progress,&job.at]).await?;
    raw(rows.first().context("Creating replica job")?)
}
