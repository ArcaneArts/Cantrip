use super::{
    WorkerEnrollmentError,
    rows::{self, CREDENTIAL, WORKER},
};
use crate::{
    auth::{iso, now},
    database::{Database, Transaction},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

#[derive(Clone)]
pub struct WorkerRepository {
    pub database: Arc<Database>,
}
pub struct ActiveCredential {
    pub id: String,
    pub owner_id: String,
    pub worker_id: String,
    pub scopes: Vec<String>,
}
pub struct EnrollmentProvision {
    pub owner_id: String,
    pub replaced_worker_id: Option<String>,
    pub revoked_credential_ids: Vec<String>,
    pub worker: Value,
    pub credential: Value,
}
pub struct EnrollmentInput {
    pub code_hash: String,
    pub credential_hash: String,
    pub credential_id: String,
    pub heartbeat: Value,
    pub replacement: Option<(String, String)>,
    pub scopes: Vec<String>,
}
pub struct RotationInput {
    pub credential_hash: String,
    pub credential_id: String,
    pub label: Option<String>,
    pub owner_id: String,
    pub worker_id: String,
    pub scopes: Vec<String>,
}

fn enrollment_error(message: &'static str) -> anyhow::Error {
    WorkerEnrollmentError(message).into()
}
fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key].as_str().context("validated worker text")
}

// A single bound JSONB value carries validated heartbeat fields. Text/date
// boundaries are normalized by the request layer; nested capabilities remain
// opaque JSONB and retain PostgreSQL's actual validation/error behavior.
fn heartbeat_sql(insert: bool) -> String {
    const FIELDS: [(&str, &str); 18] = [
        ("name", "$3::jsonb->>'name'"),
        ("platform", "$3::jsonb->>'platform'"),
        ("architecture", "$3::jsonb->>'architecture'"),
        ("codex_version", "$3::jsonb->>'codexVersion'"),
        ("codex_runtime", "$3::jsonb->'codexRuntime'"),
        ("remote_surface_capabilities", "$3::jsonb->'remoteSurfaces'"),
        ("direct_broker_advertisement", "$3::jsonb->'directBroker'"),
        ("codegraph_status", "$3::jsonb->'codegraph'"),
        ("web_runtime_capabilities", "$3::jsonb->'webRuntimes'"),
        ("encryption_status", "$3::jsonb->'encryption'"),
        (
            "project_replica_capabilities",
            "$3::jsonb->'projectReplicas'",
        ),
        ("managed_folder_capabilities", "$3::jsonb->'managedFolders'"),
        (
            "standalone_chat_capabilities",
            "$3::jsonb->'standaloneChat'",
        ),
        (
            "chat_relocation_capability",
            "($3::jsonb->>'chatRelocation')::boolean",
        ),
        (
            "external_codex_history_capability",
            "($3::jsonb->>'externalCodexHistory')::boolean",
        ),
        ("started_at", "($3::jsonb->>'startedAt')::timestamptz"),
        ("last_seen_at", "$4"),
        ("updated_at", "$4"),
    ];
    if insert {
        format!(
            "INSERT INTO workers(id,owner_id,{},unlinked_at) SELECT $1,$2,{},NULL RETURNING {WORKER}",
            FIELDS
                .iter()
                .map(|(column, _)| *column)
                .collect::<Vec<_>>()
                .join(","),
            FIELDS
                .iter()
                .map(|(_, expression)| *expression)
                .collect::<Vec<_>>()
                .join(",")
        )
    } else {
        format!(
            "UPDATE workers SET {},unlinked_at=NULL WHERE id=$1 AND owner_id=$2 RETURNING {WORKER}",
            FIELDS
                .iter()
                .map(|(column, expression)| format!("{column}={expression}"))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}
async fn heartbeat_in_transaction(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    insert: bool,
    at: DateTime<Utc>,
) -> Result<Value> {
    let rows = tx
        .query(
            &heartbeat_sql(insert),
            &[&text(input, "workerId")?, &owner, &input, &at],
        )
        .await?;
    rows::worker(
        rows.first()
            .context("Recording a worker heartbeat did not complete.")?,
    )
}

impl WorkerRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn create_enrollment_code(
        &self,
        owner: &str,
        session: Option<&str>,
        hash: &str,
        label: Option<&str>,
        expires: DateTime<Utc>,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        self.database.query("INSERT INTO worker_enrollment_codes(id,owner_id,created_by_session_id,code_hash,label,expires_at) VALUES($1,$2,$3,$4,$5,$6)",&[&id,&owner,&session,&hash,&label,&expires]).await?;
        Ok(id)
    }
    pub async fn reusable_worker_id(
        &self,
        owner: &str,
        candidates: &[String],
    ) -> Result<Option<String>> {
        let mut seen = HashSet::new();
        let candidates = candidates
            .iter()
            .filter(|id| seen.insert(id.as_str()))
            .take(64)
            .cloned()
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok(None);
        }
        let previous=self.database.query("SELECT w.id,count(s.id) FROM workers w LEFT JOIN project_sources s ON s.worker_id=w.id AND s.removed_at IS NULL WHERE w.owner_id=$1 AND w.id=ANY($2) AND w.unlinked_at IS NOT NULL GROUP BY w.id,w.last_seen_at ORDER BY count(s.id) DESC,w.last_seen_at DESC LIMIT 1",&[&owner,&candidates]).await?;
        if let Some(row) = previous.first() {
            return Ok(Some(row.get(0)?));
        }
        let claimed = self
            .database
            .query("SELECT id FROM workers WHERE id=ANY($1)", &[&candidates])
            .await?
            .iter()
            .map(|row| row.get::<String>(0))
            .collect::<Result<HashSet<_>>>()?;
        Ok(candidates.into_iter().find(|id| !claimed.contains(id)))
    }
    pub async fn enrollment_code_status(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT id,label,expires_at,consumed_at FROM worker_enrollment_codes WHERE id=$1 AND owner_id=$2 LIMIT 1",&[&id,&owner]).await?;
        rows.first().map(|row|{
            let expiry=row.get::<DateTime<Utc>>(2)?;
            Ok(json!({"id":row.get::<String>(0)?,"label":row.get::<Option<String>>(1)?,"expiresAt":iso(expiry),"status":if row.get::<Option<DateTime<Utc>>>(3)?.is_some(){"paired"}else if expiry.timestamp_millis()<=Utc::now().timestamp_millis(){"expired"}else{"pending"}}))
        }).transpose()
    }
    pub async fn exchange_enrollment_code(
        &self,
        input: EnrollmentInput,
    ) -> Result<EnrollmentProvision> {
        let at = now();
        self.database.transaction(move|tx|Box::pin(async move{
            let codes=tx.query("SELECT id,owner_id,label FROM worker_enrollment_codes WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>$2 LIMIT 1 FOR UPDATE",&[&input.code_hash,&at]).await?;
            let code=codes.first().ok_or_else(||enrollment_error("This worker link code is invalid, expired, or already used."))?;
            let code_id=code.get::<String>(0)?;let owner=code.get::<String>(1)?;let label=code.get::<Option<String>>(2)?;
            let id=text(&input.heartbeat,"workerId")?;
            if input.replacement.as_ref().is_some_and(|(worker,_)|worker==id){return Err(enrollment_error("A worker cannot replace its own identity during enrollment."))}
            let mut revoked=Vec::new();
            if let Some((worker,hash))=&input.replacement{
                let credentials=tx.query("SELECT owner_id FROM worker_credentials WHERE worker_id=$1 AND secret_hash=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3) LIMIT 1 FOR UPDATE",&[&worker,&hash,&at]).await?;
                let credential=credentials.first().ok_or_else(||enrollment_error("The previous worker credential could not authorize reassignment."))?;
                let workers=tx.query("SELECT owner_id FROM workers WHERE id=$1 LIMIT 1 FOR UPDATE",&[&worker]).await?;
                if !workers.first().is_some_and(|row|row.get::<String>(0).is_ok_and(|owner|credential.get::<String>(0).is_ok_and(|expected|owner==expected))){return Err(enrollment_error("The previous worker identity and credential do not match."))}
                revoked=tx.query("UPDATE worker_credentials SET revoked_at=$2,revoked_reason='Worker reassigned to another account.',updated_at=$2 WHERE worker_id=$1 AND revoked_at IS NULL RETURNING id",&[&worker,&at]).await?.iter().map(|row|row.get::<String>(0)).collect::<Result<_>>()?;
                tx.query("UPDATE workers SET unlinked_at=$2,updated_at=$2 WHERE id=$1",&[&worker,&at]).await?;
            }
            let existing=tx.query("SELECT owner_id FROM workers WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?;
            if let Some(worker)=existing.first(){
                if worker.get::<String>(0)?!=owner{return Err(enrollment_error("This worker identity is already owned by another account."))}
                if !tx.query("SELECT id FROM worker_credentials WHERE worker_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) LIMIT 1",&[&id,&at]).await?.is_empty(){return Err(enrollment_error("This worker identity is already enrolled. Rotate its credential instead."))}
            }
            if tx.query("UPDATE worker_enrollment_codes SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL RETURNING id",&[&code_id,&at]).await?.is_empty(){return Err(enrollment_error("This worker link code was already used."))}
            let worker=heartbeat_in_transaction(tx,&owner,&input.heartbeat,existing.is_empty(),at).await?;
            let scopes=json!(input.scopes);
            let credentials=tx.query(&format!("INSERT INTO worker_credentials(id,owner_id,worker_id,secret_hash,label,scopes,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING {CREDENTIAL}"),&[&input.credential_id,&owner,&id,&input.credential_hash,&label,&scopes,&at]).await?;
            Ok(EnrollmentProvision{owner_id:owner,replaced_worker_id:input.replacement.map(|(worker,_)|worker),revoked_credential_ids:revoked,worker,credential:rows::credential(credentials.first().context("Creating a worker credential did not complete.")?,at)?})
        })).await
    }
    pub async fn authenticate(
        &self,
        hash: &str,
        worker: &str,
        scope: &str,
    ) -> Result<Option<ActiveCredential>> {
        let hash = hash.to_owned();
        let worker = worker.to_owned();
        let scope = scope.to_owned();
        let at = now();
        self.database.transaction(move|tx|Box::pin(async move{
            let credentials=tx.query("SELECT id,owner_id,worker_id,scopes FROM worker_credentials WHERE secret_hash=$1 AND worker_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3) LIMIT 1 FOR UPDATE",&[&hash,&worker,&at]).await?;
            let Some(row)=credentials.first()else{return Ok(None)};
            let scopes=serde_json::from_value::<Vec<String>>(row.get(3)?)?;
            if !scopes.contains(&scope){return Ok(None)}
            let id=row.get::<String>(0)?;
            tx.query("UPDATE worker_credentials SET last_used_at=$2,updated_at=$2 WHERE id=$1",&[&id,&at]).await?;
            Ok(Some(ActiveCredential{id,owner_id:row.get(1)?,worker_id:row.get(2)?,scopes}))
        })).await
    }
    pub async fn get_worker(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        self.database.query(&format!("SELECT {WORKER} FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1"),&[&id,&owner]).await?.first().map(rows::worker).transpose()
    }
    pub async fn owner(&self, id: &str) -> Result<Option<String>> {
        self.database
            .query("SELECT owner_id FROM workers WHERE id=$1 LIMIT 1", &[&id])
            .await?
            .first()
            .map(|row| row.get(0))
            .transpose()
    }
    pub async fn list_workers(&self, owner: &str) -> Result<Vec<Value>> {
        self.database.query(&format!("SELECT {WORKER} FROM workers WHERE owner_id=$1 AND unlinked_at IS NULL ORDER BY name ASC"),&[&owner]).await?.iter().map(rows::worker).collect()
    }
    pub async fn list_credentials(&self, owner: &str, id: &str) -> Result<Option<Vec<Value>>> {
        if self.get_worker(owner, id).await?.is_none() {
            return Ok(None);
        }
        Ok(Some(self.database.query(&format!("SELECT {CREDENTIAL} FROM worker_credentials WHERE owner_id=$1 AND worker_id=$2 ORDER BY created_at DESC"),&[&owner,&id]).await?.iter().map(|row|rows::credential(row,now())).collect::<Result<_>>()?))
    }
    pub async fn rotate_credential(&self, input: RotationInput) -> Result<Option<Value>> {
        let at = now();
        self.database.transaction(move|tx|Box::pin(async move{
            if tx.query("SELECT id FROM workers WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE",&[&input.worker_id,&input.owner_id]).await?.is_empty(){return Ok(None)}
            let active=tx.query("SELECT id FROM worker_credentials WHERE owner_id=$1 AND worker_id=$2 AND revoked_at IS NULL ORDER BY created_at DESC",&[&input.owner_id,&input.worker_id]).await?;
            let Some(previous)=active.first()else{return Err(enrollment_error("Development bootstrap workers do not have rotatable credentials."))};
            tx.query("UPDATE worker_credentials SET revoked_at=$3,revoked_reason='rotated',updated_at=$3 WHERE owner_id=$1 AND worker_id=$2 AND revoked_at IS NULL",&[&input.owner_id,&input.worker_id,&at]).await?;
            let credentials=tx.query(&format!("INSERT INTO worker_credentials(id,owner_id,worker_id,secret_hash,label,scopes,replaces_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING {CREDENTIAL}"),&[&input.credential_id,&input.owner_id,&input.worker_id,&input.credential_hash,&input.label,&json!(input.scopes),&previous.get::<String>(0)?]).await?;
            Ok(Some(rows::credential(credentials.first().context("Rotating a worker credential did not complete.")?,at)?))
        })).await
    }
    pub async fn revoke_credential(
        &self,
        owner: &str,
        worker: &str,
        id: &str,
        reason: &str,
    ) -> Result<Option<Value>> {
        self.database.query(&format!("UPDATE worker_credentials SET revoked_at=$5,revoked_reason=$4,updated_at=$5 WHERE id=$1 AND worker_id=$2 AND owner_id=$3 AND revoked_at IS NULL RETURNING {CREDENTIAL}"),&[&id,&worker,&owner,&reason,&now()]).await?.first().map(|row|rows::credential(row,now())).transpose()
    }
    pub async fn record_worker(&self, owner: &str, heartbeat: &Value) -> Result<Value> {
        let id = text(heartbeat, "workerId")?;
        let at = now();
        let params: [&(dyn postgres_types::ToSql + Sync); 4] = [&id, &owner, &heartbeat, &at];
        let mut rows = self.database.query(&heartbeat_sql(false), &params).await?;
        if rows.is_empty() {
            match self.database.query(&heartbeat_sql(true), &params).await {
                Ok(inserted) => rows = inserted,
                Err(error) => {
                    let current = self
                        .database
                        .query("SELECT owner_id FROM workers WHERE id=$1 LIMIT 1", &[&id])
                        .await?;
                    match current
                        .first()
                        .map(|row| row.get::<String>(0))
                        .transpose()?
                    {
                        Some(current) if current != owner => {
                            return Err(enrollment_error(
                                "This worker identity belongs to another account.",
                            ));
                        }
                        Some(_) => {
                            rows = self.database.query(&heartbeat_sql(false), &params).await?
                        }
                        None => return Err(error),
                    }
                }
            }
        }
        rows::worker(
            rows.first()
                .context("Recording a worker heartbeat did not complete.")?,
        )
    }
}
