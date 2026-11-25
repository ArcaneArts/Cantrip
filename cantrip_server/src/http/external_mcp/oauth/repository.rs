//! Durable, single-use authorization codes and rotating OAuth credentials.
use super::{Authorize, ResourceOwner, secret};
use crate::{
    auth::{
        crypto::hash_secret,
        external_mcp::{IntegrationPrincipal, lease_account},
        now,
        service::AuthService,
    },
    database::{Database, Row, Transaction},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::sync::Arc;

pub const ACCESS: &str = "ctoa_";
pub const REFRESH: &str = "ctor_";
pub const BRIDGE: &str = "ctmb_";
pub const CODE: &str = "ctoc_";
const CONSENT: &str = "ctop_";
const ACCESS_SECONDS: i64 = 900;
const BRIDGE_SECONDS: i64 = 90;

pub(super) struct Repository(pub Arc<Database>);

#[derive(Serialize)]
pub(super) struct Tokens {
    access_token: String,
    refresh_token: String,
    token_type: &'static str,
    expires_in: i64,
    scope: &'static str,
}

struct Scope {
    client: String,
    owner: String,
    integration: String,
    generation: i32,
    resource: String,
    maximum: DateTime<Utc>,
}

impl Scope {
    fn read(row: &Row) -> Result<Self> {
        Ok(Self {
            client: row.get(0)?,
            owner: row.get(1)?,
            integration: row.get(2)?,
            generation: row.get(3)?,
            resource: row.get(4)?,
            maximum: row.get(5)?,
        })
    }

    async fn mint(
        &self,
        tx: &Transaction<'_>,
        kind: &str,
        prefix: &str,
        ttl: i64,
    ) -> Result<(String, i64)> {
        let credential = secret(prefix)?;
        let hash = hash_secret(&credential);
        let issued = now();
        let expires = (issued + Duration::seconds(ttl)).min(self.maximum);
        tx.query(
            "INSERT INTO external_mcp_oauth_tokens(hash,kind,client_id,owner_id,integration_id,integration_generation,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            &[&hash, &kind, &self.client, &self.owner, &self.integration, &self.generation, &self.resource, &expires],
        ).await?;
        Ok((credential, (expires - issued).num_seconds().max(0)))
    }

    async fn tokens(&self, tx: &Transaction<'_>) -> Result<Tokens> {
        let (access_token, expires_in) = self.mint(tx, "access", ACCESS, ACCESS_SECONDS).await?;
        let (refresh_token, _) = self.mint(tx, "refresh", REFRESH, 30 * 24 * 60 * 60).await?;
        Ok(Tokens {
            access_token,
            refresh_token,
            token_type: "Bearer",
            expires_in,
            scope: cantrip_protocol::external_mcp::OAUTH_SCOPE,
        })
    }
}

impl Repository {
    pub async fn register(&self, name: &str, redirects: &[String]) -> Result<String> {
        self.0
            .query(
                "DELETE FROM external_mcp_oauth_clients WHERE expires_at<=now()",
                &[],
            )
            .await?;
        let client = uuid::Uuid::new_v4().to_string();
        self.0.query(
            "INSERT INTO external_mcp_oauth_clients(id,name,redirect_uris,expires_at) VALUES($1,$2,$3,now()+interval '365 days')",
            &[&client, &name, &postgres_types::Json(redirects)],
        ).await?;
        Ok(client)
    }

    pub async fn client(&self, id: &str, redirect: &str) -> Result<Option<String>> {
        let rows = self.0.query(
            "SELECT name FROM external_mcp_oauth_clients WHERE id=$1 AND expires_at>now() AND redirect_uris ? $2",
            &[&id, &redirect],
        ).await?;
        rows.first().map(|row| row.get(0)).transpose()
    }

    pub async fn begin(&self, browser: &ResourceOwner, request: &Authorize) -> Result<String> {
        let consent = secret(CONSENT)?;
        let hash = hash_secret(&consent);
        let payload = serde_json::to_value(request)?;
        self.0
            .query(
                "DELETE FROM external_mcp_oauth_authorizations WHERE expires_at<=now()",
                &[],
            )
            .await?;
        self.0.query(
            "INSERT INTO external_mcp_oauth_authorizations(consent_hash,client_id,owner_id,browser_session_id,request,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
            &[&hash, &request.client_id, &browser.owner, &browser.session, &payload],
        ).await?;
        Ok(consent)
    }

    pub async fn approve(
        &self,
        browser: &ResourceOwner,
        consent: &str,
        integration: &str,
    ) -> Result<Option<(Authorize, String)>> {
        let code = secret(CODE)?;
        let rows = self.0.query(
            "UPDATE external_mcp_oauth_authorizations a SET code_hash=$5,integration_id=i.id,integration_generation=i.generation,expires_at=LEAST(i.expires_at, now()+interval '5 minutes') FROM external_mcp_integrations i WHERE a.consent_hash=$1 AND a.owner_id=$2 AND a.browser_session_id=$3 AND a.expires_at>now() AND a.code_hash IS NULL AND i.id=$4 AND i.owner_id=a.owner_id AND i.revoked_at IS NULL AND i.expires_at>now() RETURNING a.request",
            &[&hash_secret(consent), &browser.owner, &browser.session, &integration, &hash_secret(&code)],
        ).await?;
        rows.first()
            .map(|row| Ok((serde_json::from_value(row.get(0)?)?, code)))
            .transpose()
    }

    pub async fn deny(&self, browser: &ResourceOwner, consent: &str) -> Result<Option<Authorize>> {
        let rows = self.0.query(
            "DELETE FROM external_mcp_oauth_authorizations WHERE consent_hash=$1 AND owner_id=$2 AND browser_session_id=$3 AND expires_at>now() AND code_hash IS NULL RETURNING request",
            &[&hash_secret(consent), &browser.owner, &browser.session],
        ).await?;
        rows.first()
            .map(|row| Ok(serde_json::from_value(row.get(0)?)?))
            .transpose()
    }

    pub async fn redeem(
        &self,
        client: String,
        code: String,
        challenge: String,
        redirect: String,
        resource: String,
    ) -> Result<Option<Tokens>> {
        self.0.transaction(|tx| Box::pin(async move {
            let rows = tx.query(
                "DELETE FROM external_mcp_oauth_authorizations a USING external_mcp_integrations i,external_mcp_oauth_clients c,users u WHERE a.code_hash=$1 AND a.client_id=$2 AND a.request->>'code_challenge'=$3 AND a.request->>'redirect_uri'=$4 AND a.request->>'resource'=$5 AND a.expires_at>now() AND i.id=a.integration_id AND i.owner_id=a.owner_id AND i.generation=a.integration_generation AND i.revoked_at IS NULL AND i.expires_at>now() AND c.id=a.client_id AND c.expires_at>now() AND u.id=a.owner_id AND u.status='active' RETURNING a.client_id,a.owner_id,i.id,i.generation,$5::text,LEAST(i.expires_at,c.expires_at)",
                &[&hash_secret(&code), &client, &challenge, &redirect, &resource],
            ).await?;
            match rows.first() {
                Some(row) => Ok(Some(Scope::read(row)?.tokens(tx).await?)),
                None => Ok(None),
            }
        })).await
    }

    pub async fn refresh(
        &self,
        client: String,
        refresh: String,
        resource: String,
    ) -> Result<Option<Tokens>> {
        self.0.transaction(|tx| Box::pin(async move {
            let rows = tx.query(
                "DELETE FROM external_mcp_oauth_tokens t USING external_mcp_integrations i,external_mcp_oauth_clients c,users u WHERE t.hash=$1 AND t.kind='refresh' AND t.client_id=$2 AND t.resource=$3 AND t.expires_at>now() AND i.id=t.integration_id AND i.owner_id=t.owner_id AND i.generation=t.integration_generation AND i.revoked_at IS NULL AND i.expires_at>now() AND c.id=t.client_id AND c.expires_at>now() AND u.id=t.owner_id AND u.status='active' RETURNING t.client_id,t.owner_id,i.id,i.generation,t.resource,LEAST(i.expires_at,c.expires_at)",
                &[&hash_secret(&refresh), &client, &resource],
            ).await?;
            match rows.first() {
                Some(row) => Ok(Some(Scope::read(row)?.tokens(tx).await?)),
                None => Ok(None),
            }
        })).await
    }

    pub async fn exchange(&self, access: String, resource: String) -> Result<Option<String>> {
        self.0.transaction(|tx| Box::pin(async move {
            let rows = tx.query(
                "SELECT t.client_id,t.owner_id,i.id,i.generation,t.resource,LEAST(t.expires_at,i.expires_at,c.expires_at) FROM external_mcp_oauth_tokens t JOIN external_mcp_integrations i ON i.id=t.integration_id AND i.owner_id=t.owner_id AND i.generation=t.integration_generation JOIN external_mcp_oauth_clients c ON c.id=t.client_id JOIN users u ON u.id=t.owner_id AND u.status='active' WHERE t.hash=$1 AND t.kind='access' AND t.resource=$2 AND t.expires_at>now() AND i.revoked_at IS NULL AND i.expires_at>now() AND c.expires_at>now()",
                &[&hash_secret(&access), &resource],
            ).await?;
            let Some(row) = rows.first() else { return Ok(None) };
            let scope = Scope::read(row)?;
            tx.query("DELETE FROM external_mcp_oauth_tokens WHERE owner_id=$1 AND expires_at<=now()", &[&scope.owner]).await?;
            let (credential, _) = scope.mint(tx, "bridge", BRIDGE, BRIDGE_SECONDS).await?;
            Ok(Some(credential))
        })).await
    }
}

pub(super) async fn bridge_principal(
    service: &AuthService,
    credential: &str,
) -> Result<Option<IntegrationPrincipal>> {
    let Some(configuration) = &service.config.external_mcp_oauth else {
        return Ok(None);
    };
    let rows = service.repository.database.query(
        "SELECT owner_id,integration_id,integration_generation,expires_at FROM external_mcp_oauth_tokens WHERE hash=$1 AND kind='bridge' AND resource=$2 AND expires_at>now()",
        &[&hash_secret(credential), &configuration.resource],
    ).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let owner: String = row.get(0)?;
    let identity: String = row.get(1)?;
    let generation: i32 = row.get(2)?;
    let expires: DateTime<Utc> = row.get(3).context("Bridge credential expiration")?;
    let integration = service
        .repository
        .mcp_integration_for_lease(&owner, &lease_account(&identity, generation))
        .await?;
    Ok(integration.map(|mut integration| {
        integration.expires_at = integration.expires_at.min(expires);
        IntegrationPrincipal {
            owner_id: owner,
            integration,
        }
    }))
}
