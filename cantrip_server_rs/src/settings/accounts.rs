//! Opaque provider credentials, their optimistic revisions and legacy worker
//! projections. Neither credential records nor protected labels are decrypted.
use super::repository::{SettingsRepository, account_summary, date};
use crate::{
    auth::{iso, now},
    wire::{self, JsString, Value as WireValue},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialConflict {
    Identity,
    Revision,
}
impl std::fmt::Display for CredentialConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Identity => "The provider account identity does not match the stored identity.",
            Self::Revision => "The provider account credential changed before it could be saved.",
        })
    }
}
impl std::error::Error for CredentialConflict {}

const ACCOUNT_SCOPE: &str =
    "a.id=$3 AND a.provider_id=$2 AND p.owner_id=$1 AND p.kind IN ('chatgpt','grok')";
const OWNED: &str = "EXISTS(SELECT 1 FROM model_providers p WHERE p.id=$2 AND p.owner_id=$1 AND p.kind IN ('chatgpt','grok'))";

fn migration(row: &Value) -> Value {
    let a = &row["account"];
    json!({"accountId":a["id"],"credentialHomeKey":a["credential_home_key"],"providerId":a["provider_id"],"providerKind":row["kind"],"revision":a["credential_revision"],"state":a["credential_state"],"subjectBlindIndex":a["credential_subject_blind_index"]})
}
fn credential(row: &Value) -> Result<Option<Value>> {
    let a = &row["account"];
    if a["protected_credential"].is_null() {
        return Ok(None);
    }
    Ok(Some(
        json!({"accountId":a["id"],"credential":{"subjectBlindIndex":a["credential_subject_blind_index"],"protectedCredential":a["protected_credential"]},"metadata":{"expiresAt":date(&a["credential_expires_at"])?},"providerId":a["provider_id"],"providerKind":row["kind"],"revision":a["credential_revision"],"state":a["credential_state"],"updatedAt":date(&a["credential_updated_at"])?}),
    ))
}
fn text<'a>(value: &'a WireValue, field: &str) -> Result<&'a JsString> {
    value[field]
        .as_js_string()
        .context("validated provider account text")
}
fn expires(value: &Value) -> Result<Option<String>> {
    let Some(value) = value.as_str().filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let ms = wire::date_milliseconds(&JsString::from(value)).context("Invalid time value")?;
    Ok(Some(
        wire::date_iso_milliseconds(ms).context("Invalid time value")?,
    ))
}

impl SettingsRepository {
    pub async fn list_provider_accounts(
        &self,
        owner: &str,
        provider: &str,
    ) -> Result<Option<Vec<Value>>> {
        if self.database.query("SELECT id FROM model_providers WHERE id=$2 AND owner_id=$1 AND kind IN ('chatgpt','grok') LIMIT 1", &[&owner,&provider]).await?.is_empty() { return Ok(None) }
        let accounts=self.json_rows("SELECT to_jsonb(a) FROM model_provider_accounts a WHERE provider_id=$1 ORDER BY position ASC", &[&provider]).await?;
        let bindings=self.json_rows("SELECT to_jsonb(b) FROM model_provider_account_workers b INNER JOIN model_provider_accounts a ON a.id=b.account_id AND a.provider_id=$1", &[&provider]).await?;
        Ok(Some(
            accounts
                .iter()
                .map(|a| account_summary(a, &bindings))
                .collect::<Result<_>>()?,
        ))
    }
    pub async fn get_provider_account_credential(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<Option<Value>> {
        let rows=self.json_rows(&format!("SELECT jsonb_build_object('account',to_jsonb(a),'kind',p.kind) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE {ACCOUNT_SCOPE} LIMIT 1"), &[&owner,&provider,&account]).await?;
        rows.first()
            .map(credential)
            .transpose()
            .map(Option::flatten)
    }
    pub async fn list_provider_credential_migrations(&self, owner: &str) -> Result<Vec<Value>> {
        Ok(self.json_rows("SELECT jsonb_build_object('account',to_jsonb(a),'kind',p.kind) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE p.owner_id=$1 AND p.kind IN ('chatgpt','grok') AND a.credential_state IN ('migration-needed','signed-in') ORDER BY p.created_at ASC,a.position ASC", &[&owner]).await?.iter().map(migration).collect())
    }
    pub async fn get_provider_credential_migration(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<Option<Value>> {
        Ok(self.json_rows(&format!("SELECT jsonb_build_object('account',to_jsonb(a),'kind',p.kind) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE {ACCOUNT_SCOPE} LIMIT 1"), &[&owner,&provider,&account]).await?.first().map(migration))
    }
    pub async fn store_provider_account_credential(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        input: &WireValue,
        metadata: &Value,
        expected_revision: Option<f64>,
    ) -> Result<Option<Value>> {
        let (owner, provider, account) =
            (owner.to_owned(), provider.to_owned(), account.to_owned());
        let (input, metadata) = (input.clone(), metadata.clone());
        self.database.transaction(move |tx| Box::pin(async move {
            let rows=tx.query(&format!("SELECT to_jsonb(a),p.kind FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE {ACCOUNT_SCOPE} LIMIT 1"), &[&owner,&provider,&account]).await?;
            let Some(row)=rows.first() else { return Ok(None) };
            let current: Value=row.get(0)?;
            let subject=text(&input,"subjectBlindIndex")?;
            if current["credential_subject_blind_index"].as_str().filter(|s| !s.is_empty()).is_some_and(|s| JsString::from(s)!=*subject) { return Err(CredentialConflict::Identity.into()) }
            let revision=current["credential_revision"].as_i64().context("credential revision")?;
            if expected_revision.is_some_and(|expected| expected!=revision as f64) { return Err(CredentialConflict::Revision.into()) }
            let next=revision+1;
            let at=now();
            let expiry=expires(&metadata["expiresAt"])?;
            let protected=input["protectedCredential"].stringify();
            let updated=tx.query("UPDATE model_provider_accounts SET protected_credential=$4::text::jsonb,credential_revision=$5::text::integer,credential_state='signed-in',credential_subject_blind_index=$6,credential_expires_at=$7::text::timestamptz,credential_updated_at=$8,credential_last_refresh_at=$8,credential_refresh_lease_id=NULL,credential_refresh_lease_expires_at=NULL,auth_last_synced_at=$8,updated_at=$8 WHERE id=$1 AND provider_id=$2 AND credential_revision=$3::text::integer RETURNING credential_revision", &[&account,&provider,&revision.to_string(),&protected,&next.to_string(),&subject.lossy().as_ref(),&expiry,&at]).await?;
            if updated.is_empty() { return Err(CredentialConflict::Revision.into()) }
            Ok(Some(json!({"accountId":account,"credential":serde_json::from_str::<Value>(&input.stringify())?,"metadata":metadata,"providerId":provider,"providerKind":row.get::<String>(1)?,"revision":next,"state":"signed-in","updatedAt":iso(at)})))
        })).await
    }
    pub async fn update_provider_credential_state(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        expected_revision: f64,
        state: &str,
    ) -> Result<bool> {
        let expected = wire::Value::Number(expected_revision).stringify();
        Ok(!self.database.query("UPDATE model_provider_accounts a SET credential_state=$5,updated_at=$6 WHERE a.id=$3 AND a.provider_id=$2 AND a.credential_revision=$4::text::integer AND EXISTS(SELECT 1 FROM model_providers p WHERE p.id=$2 AND p.owner_id=$1) RETURNING id", &[&owner,&provider,&account,&expected,&state,&now()]).await?.is_empty())
    }
    pub async fn take_provider_credential_for_sign_out(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        expected_revision: Option<f64>,
    ) -> Result<Option<Value>> {
        let (owner, provider, account) =
            (owner.to_owned(), provider.to_owned(), account.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            let rows=tx.query(&format!("SELECT a.credential_revision FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE {ACCOUNT_SCOPE} LIMIT 1 FOR UPDATE"), &[&owner,&provider,&account]).await?;
            let Some(row)=rows.first() else { return Ok(None) };
            let revision=i64::from(row.get::<i32>(0)?);
            if expected_revision.is_some_and(|expected| expected!=revision as f64) { return Err(CredentialConflict::Revision.into()) }
            let at=now();
            let updated=super::query_error::context(tx.query("UPDATE model_provider_accounts SET protected_credential=NULL,credential_revision=$4::text::integer,credential_state='signed-out',credential_subject_blind_index=NULL,credential_expires_at=NULL,credential_updated_at=$5,credential_refresh_lease_id=NULL,credential_refresh_lease_expires_at=NULL,plan_type=NULL,credits=NULL,credits_observed_at=NULL,weekly_usage_used_basis_points=NULL,weekly_usage_resets_at=NULL,auth_last_synced_at=$5,updated_at=$5 WHERE id=$1 AND provider_id=$2 AND credential_revision=$3::text::integer RETURNING id", &[&account,&provider,&revision.to_string(),&(revision+1).to_string(),&at]).await,super::query_error::ACCOUNT_SIGN_OUT,&super::query_error::account_sign_out_params(&account,&provider,revision,at))?;
            if updated.is_empty() { return Err(CredentialConflict::Revision.into()) }
            super::query_error::context(tx.query("UPDATE model_provider_account_workers SET auth_state='signed-out',weekly_usage_used_basis_points=NULL,weekly_usage_resets_at=NULL,last_synced_at=$2,updated_at=$2 WHERE account_id=$1", &[&account,&at]).await,super::query_error::ACCOUNT_BINDINGS_SIGN_OUT,&[WireValue::String("signed-out".into()),WireValue::Null,WireValue::Null,WireValue::String(iso(at).into()),WireValue::String(iso(at).into()),WireValue::String(account.clone().into())])?;
            Ok(Some(json!({"revision":revision+1})))
        })).await
    }
    pub async fn clear_provider_account_credential(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        expected_revision: Option<f64>,
    ) -> Result<bool> {
        Ok(self
            .take_provider_credential_for_sign_out(owner, provider, account, expected_revision)
            .await?
            .is_some())
    }
    pub async fn create_provider_account(
        &self,
        owner: &str,
        provider: &str,
        input: &WireValue,
    ) -> Result<Option<Value>> {
        let (owner, provider, input) = (owner.to_owned(), provider.to_owned(), input.clone());
        self.database.transaction(move |tx| Box::pin(async move {
            let providers=tx.query("SELECT kind FROM model_providers WHERE id=$2 AND owner_id=$1 AND kind IN ('chatgpt','grok') LIMIT 1", &[&owner,&provider]).await?;
            let Some(row)=providers.first() else { return Ok(None) };
            let positions=tx.query("SELECT position FROM model_provider_accounts WHERE provider_id=$1 ORDER BY position DESC LIMIT 1", &[&provider]).await?;
            let position=positions.first().map(|row| row.get::<i32>(0).map(i64::from)).transpose()?.unwrap_or(-1)+1;
            let id=text(&input,"id")?.lossy();
            let label=input["protectedLabel"].stringify();
            let accounts=tx.query("INSERT INTO model_provider_accounts(id,provider_id,protected_label,position,credential_home_key) VALUES($1,$2,$3::text::jsonb,$4::text::integer,$1) RETURNING to_jsonb(model_provider_accounts)", &[&id.as_ref(),&provider,&label,&position.to_string()]).await?;
            let account=accounts.first().with_context(||format!("Database returned no row after creating a {} account.",if row.get::<String>(0).is_ok_and(|kind| kind=="grok") {"Grok"}else{"ChatGPT"}))?.get(0)?;
            Ok(Some(account_summary(&account,&[])?))
        })).await
    }
    pub async fn update_provider_account(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        input: &WireValue,
    ) -> Result<Option<Value>> {
        let mut values = wire::Value::object([] as [(&str, WireValue); 0]);
        let mut sets = vec!["updated_at=$5".to_owned()];
        for (wire, field) in [
            ("protectedLabel", "protected_label"),
            ("enabled", "enabled"),
        ] {
            if let Some(value) = input.get(wire) {
                values[field] = value.clone();
                sets.push(format!("{field}=v.{field}"));
            }
        }
        let rows=self.json_rows(&format!("UPDATE model_provider_accounts a SET {} FROM jsonb_populate_record(NULL::model_provider_accounts,$4::text::jsonb) v WHERE a.id=$3 AND a.provider_id=$2 AND {OWNED} RETURNING to_jsonb(a)",sets.join(",")), &[&owner,&provider,&account,&values.stringify(),&now()]).await?;
        rows.first()
            .map(|row| account_summary(row, &[]))
            .transpose()
    }
    pub async fn reorder_provider_accounts(
        &self,
        owner: &str,
        provider: &str,
        ids: &[JsString],
    ) -> Result<bool> {
        let (owner, provider, ids) = (owner.to_owned(), provider.to_owned(), ids.to_vec());
        self.database.transaction(move |tx| Box::pin(async move {
            let rows=tx.query("SELECT a.id,a.position FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE a.provider_id=$2 AND p.owner_id=$1 AND p.kind IN ('chatgpt','grok')", &[&owner,&provider]).await?;
            let accounts=rows.iter().map(|row|Ok((JsString::from(row.get::<String>(0)?),i64::from(row.get::<i32>(1)?)))).collect::<Result<Vec<_>>>()?;
            if accounts.len()!=ids.len() || accounts.iter().any(|(id,_)| !ids.contains(id)) { return Ok(false) }
            let offset=accounts.iter().map(|(_,position)|*position).fold(accounts.len() as i64-1,i64::max)+1;
            let at=now();
            for temporary in [true,false] {
                for (index,id) in ids.iter().enumerate() {
                    let position=if temporary {offset+index as i64}else{index as i64};
                    tx.query("UPDATE model_provider_accounts SET position=$3::text::integer,updated_at=$4 WHERE id=$1 AND provider_id=$2", &[&id.lossy().as_ref(),&provider,&position.to_string(),&at]).await?;
                }
            }
            Ok(true)
        })).await
    }
    pub async fn delete_provider_account(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
    ) -> Result<bool> {
        Ok(!self.database.query(&format!("DELETE FROM model_provider_accounts a WHERE a.id=$3 AND a.provider_id=$2 AND {OWNED} RETURNING id"), &[&owner,&provider,&account]).await?.is_empty())
    }
    pub async fn get_provider_account_runtime(
        &self,
        owner: &str,
        provider: &str,
        account: Option<&str>,
    ) -> Result<Option<Value>> {
        Ok(self.json_rows("SELECT jsonb_build_object('accountId',a.id,'credentialHomeKey',a.credential_home_key) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE a.provider_id=$2 AND p.owner_id=$1 AND p.kind IN ('chatgpt','grok') AND (($3::text IS NOT NULL AND a.id=$3) OR ($3::text IS NULL AND a.enabled=true)) ORDER BY a.position ASC LIMIT 1", &[&owner,&provider,&account.filter(|s| !s.is_empty())]).await?.into_iter().next())
    }
}
