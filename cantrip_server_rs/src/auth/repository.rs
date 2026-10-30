use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

use super::{
    ActiveSession, LOCAL_USER_ID, UserSummary,
    crypto::{PasswordService, normalize_email},
    now,
};
use crate::{
    config::{AuthMode, ServerConfig},
    database::{Database, Row, Transaction},
};

const USER_COLUMNS: &str = "id, kind, display_name, email, role";

fn user(row: &Row, offset: usize) -> Result<UserSummary> {
    Ok(serde_json::from_value(
        json!({"id":row.get::<String>(offset)?,"kind":row.get::<String>(offset+1)?,"displayName":row.get::<String>(offset+2)?,"email":row.get::<Option<String>>(offset+3)?,"role":row.get::<String>(offset+4)?}),
    )?)
}

async fn workspace(tx: &Transaction<'_>, owner: &str) -> Result<()> {
    let id = format!("workspace:default:{owner}");
    tx.query("INSERT INTO project_workspaces (id,owner_id,position,is_default) VALUES ($1,$2,0,NOT EXISTS(SELECT 1 FROM project_workspaces WHERE owner_id=$2 AND is_default)) ON CONFLICT DO NOTHING",&[&id,&owner]).await?;
    tx.query("INSERT INTO project_workspace_storage_profiles (workspace_id,kind) SELECT w.id,CASE WHEN w.id=$1 THEN 'system' ELSE 'legacy' END FROM project_workspaces w LEFT JOIN project_workspace_storage_profiles p ON p.workspace_id=w.id WHERE w.owner_id=$2 AND p.workspace_id IS NULL ON CONFLICT DO NOTHING",&[&id,&owner]).await?;
    let defaults=tx.query("SELECT w.id,p.kind FROM project_workspaces w JOIN project_workspace_storage_profiles p ON p.workspace_id=w.id WHERE w.owner_id=$1 AND w.is_default",&[&owner]).await?;
    if defaults
        .first()
        .is_some_and(|r| r.get::<String>(1).is_ok_and(|kind| kind != "attached"))
    {
        return Ok(());
    }
    let at = now();
    if let Some(current) = defaults.first() {
        tx.query("UPDATE project_workspaces SET is_default=false,revision=revision+1,updated_at=$2 WHERE id=$1",&[&current.get::<String>(0)?,&at]).await?;
    }
    let rows=tx.query("UPDATE project_workspaces SET is_default=true,revision=revision+1,updated_at=$3 WHERE id=$1 AND owner_id=$2 RETURNING id",&[&id,&owner,&at]).await?;
    anyhow::ensure!(
        !rows.is_empty(),
        "Could not restore the system workspace default"
    );
    Ok(())
}

#[derive(Clone)]
pub struct AuthRepository {
    pub database: Arc<Database>,
}

pub struct AuditRecord<'a> {
    pub action: &'a str,
    pub result: &'a str,
    pub owner: Option<&'a str>,
    pub actor: Option<&'a str>,
    pub session: Option<&'a str>,
    pub resource_type: &'a str,
    pub resource: Option<&'a str>,
    pub request_id: &'a str,
}
impl AuthRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub async fn provision(&self, owner: &str) -> Result<()> {
        let owner = owner.to_owned();
        let workspace_owner = owner.clone();
        self.database
            .transaction(move |tx| Box::pin(async move { workspace(tx, &workspace_owner).await }))
            .await?;
        self.database
            .query(
                "INSERT INTO policy_owner_states(owner_id) VALUES ($1) ON CONFLICT DO NOTHING",
                &[&owner],
            )
            .await?;
        Ok(())
    }

    pub async fn local_user(&self) -> Result<UserSummary> {
        let rows=self.database.query(&format!("INSERT INTO users(id,kind,role,status,display_name,email,updated_at) VALUES ($1,'anonymous','owner','active','Local User',NULL,$2) ON CONFLICT(id) DO UPDATE SET role='owner',status='active',updated_at=$2 RETURNING {USER_COLUMNS}"),&[&LOCAL_USER_ID,&now()]).await?;
        let value = user(rows.first().context("ensure local user")?, 0)?;
        self.provision(&value.id).await?;
        Ok(value)
    }

    pub async fn settings(&self, owner: &str) -> Result<()> {
        self.database.query("INSERT INTO user_settings(user_id,theme,high_contrast,pro_mode,pro_mode_opacity,content_gutters,sidebar_width,show_chat_prompt_overlay,random_agent_names,desktop_frame_rate,desktop_stream_quality,default_model_id,default_permission_profile_id) VALUES ($1,'system',false,false,80,false,288,true,false,30,'adaptive',NULL,':workspace') ON CONFLICT(user_id) DO NOTHING",&[&owner]).await?;
        Ok(())
    }

    pub async fn server_id(&self) -> Result<String> {
        let value = json!({"id":Uuid::new_v4().to_string()});
        self.database.query("INSERT INTO system_state(key,value) VALUES ('server-id',$1) ON CONFLICT(key) DO NOTHING",&[&value]).await?;
        let rows = self
            .database
            .query("SELECT value FROM system_state WHERE key='server-id'", &[])
            .await?;
        let value = rows
            .first()
            .context("authoritative server identity")?
            .get::<Value>(0)?;
        value["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
            .context("The authoritative server identity is unavailable.")
    }

    pub async fn count_accounts(&self) -> Result<i64> {
        self.database
            .query("SELECT count(*) FROM users WHERE kind='account'", &[])
            .await?[0]
            .get(0)
    }

    pub async fn whitelisted(&self, email: &str) -> Result<bool> {
        Ok(!self
            .database
            .query(
                "SELECT id FROM account_license_whitelist WHERE normalized_email=$1 LIMIT 1",
                &[&email],
            )
            .await?
            .is_empty())
    }

    pub async fn credential(
        &self,
        key: &str,
        by_id: bool,
    ) -> Result<Option<(UserSummary, String)>> {
        let predicate = if by_id { "id" } else { "normalized_email" };
        let rows=self.database.query(&format!("SELECT {USER_COLUMNS},password_hash FROM users WHERE {predicate}=$1 AND kind='account' AND status='active' LIMIT 1"),&[&key]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        row.get::<Option<String>>(5)?
            .filter(|s| !s.is_empty())
            .map(|hash| user(row, 0).map(|user| (user, hash)))
            .transpose()
    }

    pub async fn create_account(
        &self,
        display: &str,
        email: &str,
        normalized: &str,
        hash: &str,
        role: &str,
    ) -> Result<UserSummary> {
        let id = Uuid::new_v4().to_string();
        let at = now();
        let rows=self.database.query(&format!("INSERT INTO users(id,kind,role,status,display_name,email,normalized_email,password_hash,password_changed_at,updated_at) VALUES ($1,'account',$2,'active',$3,$4,$5,$6,$7,$7) RETURNING {USER_COLUMNS}"),&[&id,&role,&display,&email,&normalized,&hash,&at]).await?;
        let value = user(rows.first().context("create account")?, 0)?;
        self.provision(&value.id).await?;
        Ok(value)
    }

    pub async fn configured_administrator(
        &self,
        config: &ServerConfig,
        passwords: &PasswordService,
    ) -> Result<()> {
        let Some(password) = config
            .admin_password
            .as_ref()
            .filter(|p| config.auth_mode == AuthMode::Accounts && !p.is_empty())
        else {
            return Ok(());
        };
        let email = config
            .admin_email
            .clone()
            .context("configured administrator email")?;
        let normalized = normalize_email(&email);
        let password = password.clone();
        let encoded = passwords.hash(password.clone()).await?;
        let passwords = passwords.clone();
        let value=self.database.transaction(move|tx|Box::pin(async move {
            let count=tx.query("SELECT count(*) FROM users WHERE kind='account'",&[]).await?[0].get::<i64>(0)?;
            let id=Uuid::new_v4().to_string(); let role=if count==0{"owner"}else{"admin"}; let at=now();
            tx.query("INSERT INTO users(id,kind,role,status,display_name,email,normalized_email,password_hash,password_changed_at,updated_at) VALUES ($1,'account',$2,'active','Administrator',$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING",&[&id,&role,&email,&normalized,&encoded,&at]).await?;
            let rows=tx.query(&format!("SELECT {USER_COLUMNS},password_hash,status FROM users WHERE kind='account' AND normalized_email=$1 FOR UPDATE"),&[&normalized]).await?;
            let row=rows.first().context("resolve configured administrator")?;
            let previous=user(row,0)?;
            let changed=match row.get::<Option<String>>(5)? { Some(hash)=>!passwords.verify(hash,password).await,None=>true };
            let role=if previous.role==super::UserRole::Owner{"owner"}else{"admin"};
            if !changed && row.get::<String>(4)?==role && row.get::<String>(6)?=="active" { return Ok(previous); }
            let rows=if changed { tx.query(&format!("UPDATE users SET role=$2,status='active',password_hash=$3,password_changed_at=$4,updated_at=$4 WHERE id=$1 RETURNING {USER_COLUMNS}"),&[&previous.id,&role,&encoded,&at]).await? }
                else { tx.query(&format!("UPDATE users SET role=$2,status='active',updated_at=$3 WHERE id=$1 RETURNING {USER_COLUMNS}"),&[&previous.id,&role,&at]).await? };
            if changed { tx.query("UPDATE user_sessions SET revoked_at=$2,revoked_reason='configured-admin-password-changed',updated_at=$2 WHERE user_id=$1 AND revoked_at IS NULL",&[&previous.id,&at]).await?; }
            user(rows.first().context("update configured administrator")?,0)
        })).await?;
        self.provision(&value.id).await?;
        self.settings(&value.id).await
    }

    pub async fn active_session(&self, hash: &str) -> Result<Option<ActiveSession>> {
        let rows=self.database.query("SELECT s.id,s.auth_method,s.csrf_token_hash,s.expires_at,u.id,u.kind,u.display_name,u.email,u.role FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND u.status='active' LIMIT 1",&[&hash,&now()]).await?;
        rows.first()
            .map(|row| {
                Ok(ActiveSession {
                    id: row.get(0)?,
                    auth_method: row.get(1)?,
                    csrf_token_hash: row.get(2)?,
                    expires_at: row.get(3)?,
                    user: user(row, 4)?,
                })
            })
            .transpose()
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        method: &str,
        secrets: &super::crypto::SessionSecret,
        expires: DateTime<Utc>,
    ) -> Result<()> {
        self.database.query("INSERT INTO user_sessions(id,user_id,auth_method,token_hash,csrf_token_hash,expires_at,label) VALUES ($1,$2,$3,$4,$5,$6,NULL)",&[&Uuid::new_v4().to_string(),&user_id,&method,&secrets.token_hash,&secrets.csrf_token_hash,&expires]).await?;
        Ok(())
    }
    pub async fn rotate_csrf(&self, id: &str, hash: &str) -> Result<()> {
        self.database.query("UPDATE user_sessions SET csrf_token_hash=$2,last_seen_at=$3,updated_at=$3 WHERE id=$1 AND revoked_at IS NULL",&[&id,&hash,&now()]).await?;
        Ok(())
    }
    pub async fn revoke(&self, id: &str, owner: bool, reason: &str) -> Result<usize> {
        let predicate = if owner { "user_id" } else { "id" };
        Ok(self.database.query(&format!("UPDATE user_sessions SET revoked_at=$2,revoked_reason=$3,updated_at=$2 WHERE {predicate}=$1 AND revoked_at IS NULL RETURNING id"),&[&id,&now(),&reason]).await?.len())
    }
    pub async fn mobile_grant(
        &self,
        owner: &str,
        session: &str,
        code_hash: &str,
        expires: DateTime<Utc>,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        self.database.query("INSERT INTO mobile_sign_in_grants(id,owner_id,created_by_session_id,code_hash,expires_at) VALUES($1,$2,$3,$4,$5)",&[&id,&owner,&session,&code_hash,&expires]).await?;
        Ok(id)
    }
    pub async fn consume_mobile_grant(&self, hash: &str) -> Result<Option<UserSummary>> {
        let hash = hash.to_owned();
        self.database.transaction(move|tx|Box::pin(async move {
            let at=now();
            let rows=tx.query("SELECT id,owner_id,created_by_session_id FROM mobile_sign_in_grants WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>$2 LIMIT 1 FOR UPDATE",&[&hash,&at]).await?;
            let Some(grant)=rows.first() else { return Ok(None); };
            let id=grant.get::<String>(0)?;let owner=grant.get::<String>(1)?;
            let Some(session)=grant.get::<Option<String>>(2)? else { return Ok(None); };
            if tx.query("SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3 LIMIT 1",&[&session,&owner,&at]).await?.is_empty() { return Ok(None); }
            if tx.query("UPDATE mobile_sign_in_grants SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL RETURNING id",&[&id,&at]).await?.is_empty() { return Ok(None); }
            let rows=tx.query(&format!("SELECT {USER_COLUMNS} FROM users WHERE id=$1 AND status='active' LIMIT 1"),&[&owner]).await?;
            rows.first().map(|row|user(row,0)).transpose()
        })).await
    }
    pub async fn prune_mobile(&self) -> Result<()> {
        let cutoff = now() - chrono::Duration::days(1);
        self.database
            .query(
                "DELETE FROM mobile_sign_in_grants WHERE expires_at<$1",
                &[&cutoff],
            )
            .await?;
        Ok(())
    }
    pub async fn audit(&self, input: AuditRecord<'_>) -> Result<()> {
        self.database.query("INSERT INTO audit_events(action,result,owner_id,actor_user_id,actor_session_id,resource_type,resource_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",&[&input.action,&input.result,&input.owner,&input.actor,&input.session,&input.resource_type,&input.resource,&input.request_id]).await?;
        Ok(())
    }
}
