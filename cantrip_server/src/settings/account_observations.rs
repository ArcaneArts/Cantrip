use super::repository::SettingsRepository;
use crate::auth::now;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

fn reset_time(seconds: Option<f64>) -> Result<Option<String>> {
    let Some(seconds) = seconds.filter(|s| *s != 0.0 && !s.is_nan()) else {
        return Ok(None);
    };
    let ms = seconds * 1000.0;
    anyhow::ensure!(ms.is_finite() && ms.abs() <= 8.64e15, "Invalid time value");
    Ok(Some(
        crate::wire::date_iso_milliseconds(ms.trunc() as i64).expect("TimeClip checked"),
    ))
}
fn rounded(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}
fn number(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value == f64::INFINITY {
        "Infinity".into()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        crate::wire::Value::Number(value).stringify()
    }
}
impl SettingsRepository {
    pub async fn record_provider_account_status(
        &self,
        account: &str,
        worker: &str,
        authenticated: bool,
        plan: Option<&str>,
        weekly: Option<(f64, Option<f64>)>,
    ) -> Result<()> {
        let (account, worker, plan) = (
            account.to_owned(),
            worker.to_owned(),
            plan.filter(|p| !p.is_empty()).map(str::to_owned),
        );
        let at = now();
        self.database.transaction(move |tx| Box::pin(async move {
            let mut sets=vec!["auth_last_synced_at=$2".to_owned(),"updated_at=$2".into()];
            let mut values=json!({});
            if let Some((used,resets))=weekly {
                values["weekly_usage_used_basis_points"]=json!(number(rounded(used*100.0)));
                values["weekly_usage_resets_at"]=json!(reset_time(resets)?);
                sets.extend(["weekly_usage_used_basis_points=v.weekly_usage_used_basis_points".into(),"weekly_usage_resets_at=v.weekly_usage_resets_at".into(),"weekly_usage_observed_at=$2".into()]);
                if let Some(plan)=&plan {values["plan_type"]=json!(plan);sets.push("plan_type=v.plan_type".into());}
            }
            let result = tx.query(&format!("UPDATE model_provider_accounts a SET {} FROM jsonb_populate_record(NULL::model_provider_accounts,$3::jsonb) v WHERE a.id=$1",sets.join(",")), &[&account,&at,&values]).await;
            if result.is_err() {
                let resets = weekly.map(|(_,resets)|reset_time(resets)).transpose()?.flatten();
                let (context, _) = super::query_error::account_status(&account, &worker, if authenticated {"signed-in"} else {"signed-out"}, at, plan.as_deref(), weekly.map(|(used,_)|(rounded(used*100.0),resets.as_deref())));
                super::query_error::context(result, &context.0, &context.1)?;
            }
            let used=weekly.map(|(used,_)| number(rounded(used*100.0)));
            let resets=weekly.map(|(_,resets)| reset_time(resets)).transpose()?.flatten();
            let observed=weekly.map(|_|at);
            // On a signed-out observation, existing worker observation time is
            // retained even though its quota percentage/reset are cleared.
            let result = tx.query(&format!("INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state,weekly_usage_used_basis_points,weekly_usage_resets_at,weekly_usage_observed_at,last_synced_at,updated_at) VALUES($1,$2,$3,$4::text::integer,$5::text::timestamptz,$6,$7,$7) ON CONFLICT(account_id,worker_id) DO UPDATE SET auth_state=excluded.auth_state,weekly_usage_used_basis_points=excluded.weekly_usage_used_basis_points,weekly_usage_resets_at=excluded.weekly_usage_resets_at,{}last_synced_at=$7,updated_at=$7",if weekly.is_some(){"weekly_usage_observed_at=$6,"}else{""}), &[&account,&worker,&if authenticated {"signed-in"}else{"signed-out"},&used,&resets,&observed,&at]).await;
            if result.is_err() {
                let (_, context) = super::query_error::account_status(&account, &worker, if authenticated {"signed-in"} else {"signed-out"}, at, plan.as_deref(), weekly.map(|(used,_)|(rounded(used*100.0),resets.as_deref())));
                super::query_error::context(result, &context.0, &context.1)?;
            }
            Ok(())
        })).await
    }
    pub async fn record_provider_account_credits(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        credits: &Value,
        observed: DateTime<Utc>,
    ) -> Result<bool> {
        self.record_provider_account_credits_wire(
            owner,
            provider,
            account,
            &crate::wire::Value::from_serialize(credits),
            observed,
        )
        .await
    }
    pub(super) async fn record_provider_account_credits_wire(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        credits: &crate::wire::Value,
        observed: DateTime<Utc>,
    ) -> Result<bool> {
        // Drizzle writes Date.toISOString(), including millisecond clipping.
        // A binary timestamp accepts values (such as year zero) that that
        // actual PostgreSQL text input rejects, and retains extra precision.
        let observed = crate::wire::date_iso_milliseconds(observed.timestamp_millis())
            .context("Invalid time value")?;
        let at = now();
        let result = self.database.query("UPDATE model_provider_accounts a SET credits=$4::text::jsonb,credits_observed_at=$5::text::timestamptz,updated_at=$6 WHERE a.id=$3 AND a.provider_id=$2 AND (a.credits_observed_at IS NULL OR a.credits_observed_at<=$5::text::timestamptz) AND EXISTS(SELECT 1 FROM model_providers p WHERE p.id=$2 AND p.owner_id=$1 AND p.kind='chatgpt') RETURNING id", &[&owner,&provider,&account,&credits.stringify(),&observed,&at]).await;
        let result = match result {
            Ok(rows) => rows,
            Err(error) => {
                let context = super::quota_query_error::credits(
                    owner, provider, account, credits, &observed, at,
                );
                super::query_error::context(Err(error), &context.0, &context.1)?
            }
        };
        Ok(!result.is_empty())
    }
    pub async fn record_provider_account_usage(
        &self,
        owner: &str,
        provider: &str,
        account: &str,
        plan: Option<&str>,
        resets: Option<f64>,
        used: f64,
    ) -> Result<bool> {
        if !used.is_finite() {
            return Ok(false);
        }
        let mut sets = vec![
            "weekly_usage_used_basis_points=$4::text::integer",
            "weekly_usage_resets_at=$5::text::timestamptz",
            "weekly_usage_observed_at=$6",
            "auth_last_synced_at=$6",
            "updated_at=$6",
        ];
        let plan = plan.filter(|plan| !plan.is_empty());
        if plan.is_some() {
            sets.push("plan_type=$7");
        }
        let used = number(rounded(used.clamp(0.0, 100.0) * 100.0));
        let resets = reset_time(resets)?;
        let at = now();
        let mut params: Vec<&(dyn postgres_types::ToSql + Sync)> =
            vec![&owner, &provider, &account, &used, &resets, &at];
        if plan.is_some() {
            params.push(&plan);
        }
        let rows=self.database.query(&format!("UPDATE model_provider_accounts a SET {} WHERE a.id=$3 AND a.provider_id=$2 AND EXISTS(SELECT 1 FROM model_providers p WHERE p.id=$2 AND p.owner_id=$1) RETURNING id",sets.join(",")), &params).await?;
        Ok(!rows.is_empty())
    }
}
