//! Owner-bound storage of opaque endpoint encryption material. No key is
//! unwrapped here; transaction and revision semantics match the existing schema.
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    auth::{iso, now},
    database::{Database, Row, Transaction},
};

const PROFILE: &str = "owner_id,format_version,active_master_key_revision,password_kdf,password_wrapped_master_key,payload_migration_status,revision,created_at,updated_at";
const PRINCIPAL: &str = "id,owner_id,kind,worker_id,label,public_key,state,revision,approved_at,revoked_at,revoked_reason,created_at,updated_at";
const GRANT: &str = "id,owner_id,principal_id,component,key_revision,wrapped_key,state,revision,revoked_at,revoked_reason,created_at,updated_at";

fn profile(row: &Row) -> Result<Value> {
    Ok(
        json!({"ownerId":row.get::<String>(0)?,"formatVersion":1,"activeMasterKeyRevision":row.get::<i32>(2)?,"passwordKdf":row.get::<Option<Value>>(3)?,"passwordWrappedMasterKey":row.get::<Option<Value>>(4)?,"initializationStatus":"initialized","payloadMigrationStatus":row.get::<String>(5)?,"revision":row.get::<i32>(6)?,"createdAt":iso(row.get::<DateTime<Utc>>(7)?),"updatedAt":iso(row.get::<DateTime<Utc>>(8)?)}),
    )
}
fn principal(row: &Row) -> Result<Value> {
    Ok(
        json!({"id":row.get::<String>(0)?,"ownerId":row.get::<String>(1)?,"kind":row.get::<String>(2)?,"workerId":row.get::<Option<String>>(3)?,"label":row.get::<Option<String>>(4)?,"publicKey":row.get::<Value>(5)?,"state":row.get::<String>(6)?,"revision":row.get::<i32>(7)?,"approvedAt":row.get::<Option<DateTime<Utc>>>(8)?.map(iso),"revokedAt":row.get::<Option<DateTime<Utc>>>(9)?.map(iso),"revokedReason":row.get::<Option<String>>(10)?,"createdAt":iso(row.get::<DateTime<Utc>>(11)?),"updatedAt":iso(row.get::<DateTime<Utc>>(12)?)}),
    )
}
fn grant(row: &Row) -> Result<Value> {
    Ok(
        json!({"id":row.get::<String>(0)?,"ownerId":row.get::<String>(1)?,"principalId":row.get::<String>(2)?,"component":row.get::<String>(3)?,"keyRevision":row.get::<i32>(4)?,"wrappedKey":row.get::<Value>(5)?,"state":row.get::<String>(6)?,"revision":row.get::<i32>(7)?,"revokedAt":row.get::<Option<DateTime<Utc>>>(8)?.map(iso),"revokedReason":row.get::<Option<String>>(9)?,"createdAt":iso(row.get::<DateTime<Utc>>(10)?),"updatedAt":iso(row.get::<DateTime<Utc>>(11)?)}),
    )
}
fn revision(value: &Value, name: &str) -> Result<i32> {
    value[name]
        .as_i64()
        .and_then(|v| i32::try_from(v).ok())
        .context("validated encryption revision")
}
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name].as_str().context("validated encryption text")
}
fn nullable(value: &Value) -> Option<Value> {
    if value.is_null() {
        None
    } else {
        Some(value.clone())
    }
}

#[derive(Clone)]
pub struct EncryptionRepository {
    pub database: Arc<Database>,
}
impl EncryptionRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get_profile(&self, owner: &str) -> Result<Option<Value>> {
        self.database
            .query(
                &format!(
                    "SELECT {PROFILE} FROM account_encryption_profiles WHERE owner_id=$1 LIMIT 1"
                ),
                &[&owner],
            )
            .await?
            .first()
            .map(profile)
            .transpose()
    }
    pub async fn initialize(&self, owner: &str, input: &Value) -> Result<Value> {
        let owner = owner.to_owned();
        let identity = owner.clone();
        let input = input.clone();
        let at = now();
        let created=self.database.transaction(move|tx|Box::pin(async move{
            let p=&input["profile"];
            let profiles=tx.query(&format!("INSERT INTO account_encryption_profiles(owner_id,format_version,active_master_key_revision,password_kdf,password_wrapped_master_key,initialization_status,payload_migration_status,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'initialized',$6,1,$7,$7) ON CONFLICT(owner_id) DO NOTHING RETURNING {PROFILE}"),&[&identity,&revision(p,"formatVersion")?,&revision(p,"activeMasterKeyRevision")?,&nullable(&p["passwordKdf"]),&nullable(&p["passwordWrappedMasterKey"]),&text(p,"payloadMigrationStatus")?,&at]).await?;
            let Some(profile_row)=profiles.first()else{return Ok(None)};
            let client=&input["initialClient"];
            let principals=tx.query(&format!("INSERT INTO encryption_principals(id,owner_id,kind,worker_id,label,public_key,state,revision,approved_at,revoked_at,revoked_reason,created_at,updated_at) VALUES($1,$2,'client',NULL,$3,$4,'approved',1,$5,NULL,NULL,$5,$5) RETURNING {PRINCIPAL}"),&[&text(client,"id")?,&identity,&client["label"].as_str(),&client["publicKey"],&at]).await?;
            let principal_row=principals.first().context("Initial encryption principal was not created.")?;
            let grants=tx.query(&format!("INSERT INTO encryption_key_grants(id,owner_id,principal_id,component,key_revision,wrapped_key,state,revision,revoked_at,revoked_reason,created_at,updated_at) VALUES($1,$2,$3,'account-master-key',$4,$5,'active',1,NULL,NULL,$6,$6) RETURNING {GRANT}"),&[&Uuid::new_v4().to_string(),&identity,&text(client,"id")?,&revision(p,"activeMasterKeyRevision")?,&client["wrappedMasterKey"],&at]).await?;
            Ok(Some(json!({"created":true,"profile":profile(profile_row)?,"principal":principal(principal_row)?,"grant":grant(grants.first().context("Initial encryption grant was not created.")?)?})))
        })).await?;
        if let Some(created) = created {
            return Ok(created);
        }
        Ok(
            json!({"created":false,"profile":self.get_profile(&owner).await?.context("Encryption profile initialization did not become visible.")?}),
        )
    }
    pub async fn update_migration(&self, owner: &str, input: &Value) -> Result<Option<Value>> {
        self.database.query(&format!("UPDATE account_encryption_profiles SET payload_migration_status=$3,revision=revision+1,updated_at=$4 WHERE owner_id=$1 AND revision=$2 RETURNING {PROFILE}"),&[&owner,&revision(input,"expectedRevision")?,&text(input,"payloadMigrationStatus")?,&now()]).await?.first().map(profile).transpose()
    }
    pub async fn change_password(
        &self,
        owner: &str,
        input: &Value,
        password_hash: &str,
    ) -> Result<Option<Value>> {
        let owner = owner.to_owned();
        let input = input.clone();
        let password_hash = password_hash.to_owned();
        let at = now();
        self.database.transaction(move|tx|Box::pin(async move{
            let profiles=tx.query(&format!("SELECT {PROFILE} FROM account_encryption_profiles WHERE owner_id=$1 LIMIT 1 FOR UPDATE"),&[&owner]).await?;
            let Some(p)=profiles.first()else{return Ok(None)};
            if p.get::<i32>(6)?!=revision(&input,"expectedProfileRevision")? || p.get::<i32>(2)?!=revision(&input["passwordWrappedMasterKey"],"masterKeyRevision")?{return Ok(None)}
            if tx.query("UPDATE users SET password_hash=$2,password_changed_at=$3,updated_at=$3 WHERE id=$1 AND kind='account' AND status='active' RETURNING id",&[&owner,&password_hash,&at]).await?.is_empty(){return Ok(None)}
            let updated=tx.query(&format!("UPDATE account_encryption_profiles SET password_kdf=$3,password_wrapped_master_key=$4,revision=revision+1,updated_at=$5 WHERE owner_id=$1 AND revision=$2 RETURNING {PROFILE}"),&[&owner,&revision(&input,"expectedProfileRevision")?,&input["passwordKdf"],&input["passwordWrappedMasterKey"],&at]).await?;
            Ok(Some(profile(updated.first().context("Atomic password-wrapper update did not complete.")?)?))
        })).await
    }
    pub async fn list_principals(&self, owner: &str) -> Result<Vec<Value>> {
        self.database.query(&format!("SELECT {PRINCIPAL} FROM encryption_principals WHERE owner_id=$1 ORDER BY created_at ASC,id ASC"),&[&owner]).await?.iter().map(principal).collect()
    }
    pub async fn find_worker_principal(
        &self,
        owner: &str,
        worker: &str,
        id: Option<&str>,
    ) -> Result<Option<Value>> {
        let predicate = if id.is_some() {
            "AND id=$3"
        } else {
            "AND state<>'revoked'"
        };
        let sql = format!(
            "SELECT {PRINCIPAL} FROM encryption_principals WHERE owner_id=$1 AND worker_id=$2 AND kind='worker' {predicate} LIMIT 1"
        );
        let rows = if let Some(id) = id {
            self.database.query(&sql, &[&owner, &worker, &id]).await?
        } else {
            self.database.query(&sql, &[&owner, &worker]).await?
        };
        rows.first().map(principal).transpose()
    }
    pub async fn create_principal(
        &self,
        owner: &str,
        input: &Value,
        development_worker: Option<&str>,
    ) -> Result<Option<Value>> {
        if self.get_profile(owner).await?.is_none() {
            return Ok(None);
        }
        let worker = input["workerId"]
            .as_str()
            .filter(|_| input["kind"] == "worker");
        if let Some(worker) = worker {
            let available = if development_worker == Some(worker) {
                !self.database.query("SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1",&[&worker,&owner]).await?.is_empty()
            } else {
                !self.database.query("SELECT w.id FROM workers w JOIN worker_credentials c ON c.worker_id=w.id AND c.owner_id=w.owner_id WHERE w.id=$1 AND w.owner_id=$2 AND w.unlinked_at IS NULL AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>$3) LIMIT 1",&[&worker,&owner,&now()]).await?.is_empty()
            };
            if !available {
                return Ok(None);
            }
        }
        self.database.query(&format!("INSERT INTO encryption_principals(id,owner_id,kind,worker_id,label,public_key,state,revision) VALUES($1,$2,$3,$4,$5,$6,'pending',1) ON CONFLICT DO NOTHING RETURNING {PRINCIPAL}"),&[&text(input,"id")?,&owner,&text(input,"kind")?,&worker,&input["label"].as_str(),&input["publicKey"]]).await?.first().map(principal).transpose()
    }
    pub async fn approve_principal(
        &self,
        owner: &str,
        id: &str,
        expected: i32,
    ) -> Result<Option<Value>> {
        self.database.query(&format!("UPDATE encryption_principals SET state='approved',approved_at=$4,revision=revision+1,updated_at=$4 WHERE id=$1 AND owner_id=$2 AND state='pending' AND revision=$3 RETURNING {PRINCIPAL}"),&[&id,&owner,&expected,&now()]).await?.first().map(principal).transpose()
    }
    pub async fn revoke_principal(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let owner = owner.to_owned();
        let id = id.to_owned();
        let input = input.clone();
        let at = now();
        self.database.transaction(move|tx|Box::pin(async move{
            let rows=tx.query(&format!("UPDATE encryption_principals SET state='revoked',revoked_at=$5,revoked_reason=$4,revision=revision+1,updated_at=$5 WHERE id=$1 AND owner_id=$2 AND revision=$3 AND state<>'revoked' RETURNING {PRINCIPAL}"),&[&id,&owner,&revision(&input,"expectedRevision")?,&text(&input,"reason")?,&at]).await?;
            let Some(row)=rows.first()else{return Ok(None)};
            revoke_grants(tx,&owner,&id,"principal revoked",at).await?;
            Ok(Some(principal(row)?))
        })).await
    }
    pub async fn replace_worker_principal(
        &self,
        owner: &str,
        worker: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        if input["kind"] != "worker" || input["workerId"] != worker {
            return Ok(None);
        }
        let owner = owner.to_owned();
        let worker = worker.to_owned();
        let input = input.clone();
        let at = now();
        self.database.transaction(move|tx|Box::pin(async move{
            let previous=tx.query("SELECT id FROM encryption_principals WHERE owner_id=$1 AND worker_id=$2 AND kind='worker' AND state<>'revoked' LIMIT 1 FOR UPDATE",&[&owner,&worker]).await?;
            let Some(previous)=previous.first()else{return Ok(None)};let previous=previous.get::<String>(0)?;
            if previous==text(&input,"id")?{return Ok(None)}
            if tx.query("UPDATE encryption_principals SET state='revoked',revoked_at=$3,revoked_reason='worker encryption identity rotated',revision=revision+1,updated_at=$3 WHERE id=$1 AND owner_id=$2 AND state<>'revoked' RETURNING id",&[&previous,&owner,&at]).await?.is_empty(){return Ok(None)}
            revoke_grants(tx,&owner,&previous,"principal rotated",at).await?;
            let rows=tx.query(&format!("INSERT INTO encryption_principals(id,owner_id,kind,worker_id,label,public_key,state,revision) VALUES($1,$2,'worker',$3,$4,$5,'pending',1) RETURNING {PRINCIPAL}"),&[&text(&input,"id")?,&owner,&worker,&input["label"].as_str(),&input["publicKey"]]).await?;
            rows.first().map(principal).transpose()
        })).await
    }
    pub async fn active_grants(&self, owner: &str, id: &str) -> Result<Value> {
        let rows = self
            .database
            .query(
                "SELECT state FROM encryption_principals WHERE owner_id=$1 AND id=$2 LIMIT 1",
                &[&owner, &id],
            )
            .await?;
        let Some(row) = rows.first() else {
            return Ok(json!({"status":"missing"}));
        };
        if row.get::<String>(0)? != "approved" {
            return Ok(json!({"status":"unavailable"}));
        }
        let grants=self.database.query(&format!("SELECT {GRANT} FROM encryption_key_grants WHERE owner_id=$1 AND principal_id=$2 AND state='active' ORDER BY component ASC,key_revision ASC"),&[&owner,&id]).await?.iter().map(grant).collect::<Result<Vec<_>>>()?;
        Ok(json!({"status":"ok","grants":grants}))
    }
    pub async fn create_grant(&self, owner: &str, id: &str, input: &Value) -> Result<Value> {
        let owner = owner.to_owned();
        let id = id.to_owned();
        let input = input.clone();
        self.database.transaction(move|tx|Box::pin(async move{
            let principals=tx.query(&format!("SELECT {PRINCIPAL} FROM encryption_principals WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE"),&[&id,&owner]).await?;
            let Some(row)=principals.first()else{return Ok(json!({"status":"missing"}))};let principal=principal(row)?;
            if principal["state"]!="approved"{return Ok(json!({"status":"unavailable"}))}
            let profiles=tx.query("SELECT active_master_key_revision FROM account_encryption_profiles WHERE owner_id=$1 LIMIT 1",&[&owner]).await?;
            let Some(profile)=profiles.first()else{return Ok(json!({"status":"missing"}))};
            let wrapped=&input["wrappedKey"];
            let matches=if principal["kind"]=="client" && wrapped["purpose"]=="client-account-master-key"{
                input["component"]=="account-master-key" && wrapped["clientId"]==id && wrapped["masterKeyRevision"]==input["keyRevision"] && revision(&input,"keyRevision")?==profile.get::<i32>(0)?
            }else if principal["kind"]=="worker" && principal["workerId"].as_str().is_some_and(|v|!v.is_empty()) && wrapped["purpose"]=="worker-component-key"{
                input["component"]!="account-master-key" && wrapped["workerId"]==principal["workerId"] && wrapped["component"]==input["component"] && wrapped["keyRevision"]==input["keyRevision"]
            }else{false};
            if !matches{return Ok(json!({"status":"wrapper-mismatch"}))}
            let rows=tx.query(&format!("INSERT INTO encryption_key_grants(id,owner_id,principal_id,component,key_revision,wrapped_key,state,revision) VALUES($1,$2,$3,$4,$5,$6,'active',1) ON CONFLICT DO NOTHING RETURNING {GRANT}"),&[&Uuid::new_v4().to_string(),&owner,&id,&text(&input,"component")?,&revision(&input,"keyRevision")?,&wrapped]).await?;
            Ok(match rows.first(){Some(row)=>json!({"status":"created","grant":grant(row)?}),None=>json!({"status":"conflict"})})
        })).await
    }
    pub async fn revoke_grant(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        self.database.query(&format!("UPDATE encryption_key_grants SET state='revoked',revoked_at=$5,revoked_reason=$4,revision=revision+1,updated_at=$5 WHERE id=$1 AND owner_id=$2 AND state='active' AND revision=$3 RETURNING {GRANT}"),&[&id,&owner,&revision(input,"expectedRevision")?,&text(input,"reason")?,&now()]).await?.first().map(grant).transpose()
    }
}

async fn revoke_grants(
    tx: &Transaction<'_>,
    owner: &str,
    id: &str,
    reason: &str,
    at: DateTime<Utc>,
) -> Result<()> {
    tx.query("UPDATE encryption_key_grants SET state='revoked',revoked_at=$4,revoked_reason=$3,revision=revision+1,updated_at=$4 WHERE owner_id=$1 AND principal_id=$2 AND state='active'",&[&owner,&id,&reason,&at]).await?;
    Ok(())
}
