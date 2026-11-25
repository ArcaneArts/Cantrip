//! Durable integration grants. WorkerLink leases use the integration generation
//! as their account identity and have a separate, short-lived credential.
use super::{crypto, now, repository::AuthRepository};
use crate::database::{Row, Transaction};
use anyhow::Result;
use cantrip_protocol::external_mcp::{
    IntegrationCreate, IntegrationPermissions, valid_integration_credential,
};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use uuid::Uuid;

const COLUMNS: &str = "id,label,permissions,generation,created_at,updated_at,expires_at,revoked_at";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: String,
    pub label: String,
    pub permissions: IntegrationPermissions,
    pub generation: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Integration {
    pub fn lease_account(&self) -> String {
        lease_account(&self.id, self.generation)
    }
}

pub fn lease_account(id: &str, generation: i32) -> String {
    format!("external-mcp:{id}:{generation}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedIntegration {
    pub integration: Integration,
    pub credential: String,
}

pub struct IntegrationPrincipal {
    pub owner_id: String,
    pub integration: Integration,
}

pub struct IntegrationActor {
    pub owner: String,
    pub session: String,
    pub request_id: String,
}

fn integration(row: &Row) -> Result<Integration> {
    Ok(Integration {
        id: row.get(0)?,
        label: row.get(1)?,
        permissions: serde_json::from_value(row.get(2)?)?,
        generation: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        expires_at: row.get(6)?,
        revoked_at: row.get(7)?,
    })
}

async fn audit(
    transaction: &Transaction<'_>,
    actor: &IntegrationActor,
    action: &str,
    integration_id: &str,
) -> Result<()> {
    transaction.query(
        "INSERT INTO audit_events(action,result,owner_id,actor_user_id,actor_session_id,resource_type,resource_id,request_id) VALUES($1,'succeeded',$2,$2,$3,'external-mcp-integration',$4,$5)",
        &[&action,&actor.owner,&actor.session,&integration_id,&actor.request_id],
    ).await?;
    Ok(())
}

impl AuthRepository {
    pub async fn list_mcp_integrations(&self, owner: &str) -> Result<Vec<Integration>> {
        self.database.query(
            &format!("SELECT {COLUMNS} FROM external_mcp_integrations WHERE owner_id=$1 ORDER BY created_at DESC,id"),
            &[&owner],
        ).await?.iter().map(integration).collect()
    }

    pub async fn create_mcp_integration(
        &self,
        actor: IntegrationActor,
        input: IntegrationCreate,
    ) -> Result<IssuedIntegration> {
        let credential = crypto::external_mcp_credential()?;
        let hash = crypto::hash_secret(&credential);
        let id = Uuid::new_v4().to_string();
        let permissions = serde_json::to_value(input.permissions)?;
        let expires = now() + Duration::seconds(input.expires_in_seconds.into());
        let integration = self.database.transaction(|transaction| Box::pin(async move {
            let rows = transaction.query(
                &format!("INSERT INTO external_mcp_integrations(id,owner_id,label,permissions,credential_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING {COLUMNS}"),
                &[&id,&actor.owner,&input.label.trim(),&permissions,&hash,&expires],
            ).await?;
            let integration = integration(&rows[0])?;
            audit(transaction, &actor, "external-mcp.integration-created", &id).await?;
            Ok(integration)
        })).await?;
        Ok(IssuedIntegration {
            integration,
            credential,
        })
    }

    pub async fn rotate_mcp_integration(
        &self,
        actor: IntegrationActor,
        id: &str,
        expires_in_seconds: u32,
    ) -> Result<Option<IssuedIntegration>> {
        let id = id.to_owned();
        let credential = crypto::external_mcp_credential()?;
        let hash = crypto::hash_secret(&credential);
        let expires = now() + Duration::seconds(expires_in_seconds.into());
        let integration = self.database.transaction(|transaction| Box::pin(async move {
            let rows = transaction.query(
                &format!("UPDATE external_mcp_integrations SET credential_hash=$3,generation=generation+1,updated_at=now(),expires_at=$4 WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING {COLUMNS}"),
                &[&actor.owner,&id,&hash,&expires],
            ).await?;
            let Some(row) = rows.first() else { return Ok(None); };
            let integration = integration(row)?;
            audit(transaction, &actor, "external-mcp.integration-rotated", &id).await?;
            Ok(Some(integration))
        })).await?;
        Ok(integration.map(|integration| IssuedIntegration {
            integration,
            credential,
        }))
    }

    pub async fn revoke_mcp_integration(
        &self,
        actor: IntegrationActor,
        id: &str,
    ) -> Result<Option<Integration>> {
        let id = id.to_owned();
        self.database.transaction(|transaction| Box::pin(async move {
            let rows = transaction.query(
                &format!("UPDATE external_mcp_integrations SET revoked_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING {COLUMNS}"),
                &[&actor.owner,&id],
            ).await?;
            if let Some(row) = rows.first() {
                let integration = integration(row)?;
                audit(transaction, &actor, "external-mcp.integration-revoked", &id).await?;
                return Ok(Some(integration));
            }
            // A repeated revoke can finish closing live routes after a transport failure.
            let rows = transaction.query(
                &format!("SELECT {COLUMNS} FROM external_mcp_integrations WHERE owner_id=$1 AND id=$2 AND revoked_at IS NOT NULL"),
                &[&actor.owner,&id],
            ).await?;
            rows.first().map(integration).transpose()
        })).await
    }

    pub async fn authenticate_mcp_integration(
        &self,
        credential: &str,
    ) -> Result<Option<IntegrationPrincipal>> {
        if !valid_integration_credential(credential) {
            return Ok(None);
        }
        let hash = crypto::hash_secret(credential);
        let rows = self.database.query(
            &format!("SELECT {COLUMNS},owner_id FROM external_mcp_integrations WHERE credential_hash=$1 AND revoked_at IS NULL AND expires_at>now() AND EXISTS (SELECT 1 FROM users WHERE id=external_mcp_integrations.owner_id AND status='active')"),
            &[&hash],
        ).await?;
        rows.first()
            .map(|row| {
                Ok(IntegrationPrincipal {
                    owner_id: row.get(8)?,
                    integration: integration(row)?,
                })
            })
            .transpose()
    }

    pub async fn mcp_integration_current(&self, principal: &IntegrationPrincipal) -> Result<bool> {
        let rows = self.database.query(
            "SELECT 1 FROM external_mcp_integrations i JOIN users u ON u.id=i.owner_id AND u.status='active' WHERE i.owner_id=$1 AND i.id=$2 AND i.generation=$3 AND i.revoked_at IS NULL AND i.expires_at>now()",
            &[&principal.owner_id, &principal.integration.id, &principal.integration.generation],
        ).await?;
        Ok(!rows.is_empty())
    }
}
