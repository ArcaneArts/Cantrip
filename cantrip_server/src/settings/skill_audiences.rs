//! Skill audiences are public authorization metadata, scoped to an owned pair.
use super::repository::SettingsRepository;
use crate::{wire::Value, workers::repository::WorkerRepository};
use anyhow::{Context, Result};

impl SettingsRepository {
    async fn owns_skill_context(&self, owner: &str, worker: &str, provider: &str) -> Result<bool> {
        let workers = WorkerRepository::new(self.database.clone());
        let (worker, provider) = tokio::try_join!(
            workers.get_worker(owner, worker),
            self.get_model_provider(owner, provider)
        )?;
        Ok(worker.is_some() && provider.is_some())
    }

    pub async fn list_skill_audiences(
        &self,
        owner: &str,
        worker: &str,
        provider: &str,
    ) -> Result<Option<Value>> {
        if !self.owns_skill_context(owner, worker, provider).await? {
            return Ok(None);
        }
        let rows = self.database.query("SELECT jsonb_build_object('audienceKey',audience_key,'audience',audience)::text FROM skill_audiences WHERE owner_id=$1 AND worker_id=$2 AND provider_id=$3 ORDER BY audience_key ASC", &[&owner,&worker,&provider]).await?;
        Ok(Some(Value::Array(
            rows.iter()
                .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
                .collect::<Result<Vec<_>>>()?,
        )))
    }

    pub async fn update_skill_audience(&self, owner: &str, input: &Value) -> Result<Option<Value>> {
        let text = |key: &str| -> Result<String> {
            Ok(input[key]
                .as_js_string()
                .context("Skill audience field")?
                .lossy()
                .into_owned())
        };
        let (worker, provider, key, audience) = (
            text("workerId")?,
            text("providerId")?,
            text("audienceKey")?,
            text("audience")?,
        );
        if !self.owns_skill_context(owner, &worker, &provider).await? {
            return Ok(None);
        }
        let rows = self.database.query("INSERT INTO skill_audiences(owner_id,worker_id,provider_id,audience_key,audience) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,worker_id,provider_id,audience_key) DO UPDATE SET audience=EXCLUDED.audience,updated_at=$6 RETURNING jsonb_build_object('audienceKey',audience_key,'audience',audience)::text", &[&owner,&worker,&provider,&key,&audience,&crate::auth::now()]).await?;
        rows.first()
            .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
            .transpose()
    }
}
