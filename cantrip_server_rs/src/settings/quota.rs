//! Immutable quota readings and their separately committed account projections.
use super::{parse_response, repository::SettingsRepository};
use crate::{
    auth::now,
    wire::{self, JsString, Value},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use serde_json::{Value as Json, json};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

pub struct QuotaContext<'a> {
    pub owner: &'a str,
    pub provider: &'a str,
    pub account: &'a str,
    pub worker: &'a str,
    pub account_plan_type: Option<&'a str>,
    pub trigger: &'a str,
    pub chat: Option<&'a str>,
    pub turn: Option<&'a str>,
    pub execution_attempt: Option<&'a str>,
}
pub(crate) fn server_version() -> &'static str {
    static VERSION: OnceLock<Json> = OnceLock::new();
    VERSION.get_or_init(|| {
        serde_json::from_slice(include_bytes!(concat!(env!("OUT_DIR"), "/version.json")))
            .expect("embedded server version")
    })["version"]
        .as_str()
        .expect("embedded version string")
}
fn iso(input: &Value) -> Result<String> {
    let milliseconds = input
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .context("Invalid time value")?;
    wire::date_iso_milliseconds(milliseconds).context("Invalid time value")
}
fn text(input: &Value, key: &str) -> Result<String> {
    Ok(input[key]
        .as_js_string()
        .context("quota text field")?
        .lossy()
        .into_owned())
}
fn concatenate(parts: &[&JsString]) -> JsString {
    JsString::new(
        parts
            .iter()
            .flat_map(|part| part.units().iter().copied())
            .collect(),
    )
}
impl SettingsRepository {
    pub async fn persist_rate_limit_activity(
        &self,
        context: &QuotaContext<'_>,
        activity: &Value,
    ) -> Result<usize> {
        self.persist_rate_limit_activity_at(context, activity, now().timestamp_millis())
            .await
    }
    pub async fn persist_rate_limit_activity_at(
        &self,
        context: &QuotaContext<'_>,
        activity: &Value,
        fallback_milliseconds: i64,
    ) -> Result<usize> {
        let milliseconds = activity
            .get("updatedAtMs")
            .filter(|value| !value.is_null())
            .map_or(Some(fallback_milliseconds as f64), Value::as_f64)
            .filter(|value| value.is_finite() && value.abs() <= 8.64e15)
            .context("Invalid time value")?;
        let milliseconds = milliseconds.trunc() as i64;
        let observed = wire::date_iso_milliseconds(milliseconds).context("Invalid time value")?;
        let batch = activity["correlation"]
            .get("diagnosticId")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| {
                let prefix = JsString::from(format!(
                    "{}:",
                    context.execution_attempt.or(context.turn).unwrap_or("turn")
                ));
                let id = activity["id"]
                    .as_js_string()
                    .expect("validated rate-limit activity ID");
                let suffix = JsString::from(format!(":{milliseconds}"));
                Value::String(concatenate(&[&prefix, id, &suffix]))
            });
        let codex = activity
            .get("limitId")
            .is_some_and(|value| value.is_null() || *value == "codex");
        let mut snapshot = Value::object([
            ("snapshotId", batch),
            ("observedAt", Value::String(observed.into())),
            ("workerVersion", Value::Null),
            ("codexVersion", Value::Null),
        ]);
        if codex && let Some(credits) = activity.get("credits") {
            snapshot["credits"] = credits.clone();
        }
        let mut windows = Vec::new();
        for kind in ["primary", "secondary"] {
            let Some(window) = activity.get(kind).filter(|value| !value.is_null()) else {
                continue;
            };
            let source = activity["correlation"]
                .get("sourceMethod")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(Value::String("rate-limit-activity".into()));
            let mut raw = Value::object([("source", source)]);
            let mut reading = Value::object([
                ("windowKind", Value::String(kind.into())),
                (
                    "isWeeklyProjection",
                    Value::Bool(codex && window["windowDurationMins"] == Value::Number(10080.0)),
                ),
            ]);
            for key in ["limitId", "limitName", "planType", "reachedType"] {
                if let Some(value) = activity.get(key) {
                    reading[key] = value.clone();
                    raw[key] = value.clone();
                }
            }
            raw["windowKind"] = Value::String(kind.into());
            for (source, target) in [
                ("usedPercent", "usedPercent"),
                ("windowDurationMins", "windowDurationMinutes"),
                ("resetsAt", "resetsAt"),
            ] {
                if let Some(value) = window.get(source) {
                    reading[target] = value.clone();
                    raw[target] = value.clone();
                }
            }
            reading["rawPayload"] = raw;
            windows.push(reading);
        }
        snapshot["windows"] = Value::Array(windows);
        let snapshot = parse_response("providerQuotaSnapshotSchema", Some(&snapshot))?;
        self.persist_quota_snapshot(context, &snapshot).await
    }
    pub async fn record_provider_quota_observation(
        &self,
        owner: &str,
        input: &Value,
    ) -> Result<bool> {
        let Some(used) = input["usedPercent"]
            .as_f64()
            .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
        else {
            return Ok(false);
        };
        let Some(observed) = input["observedAt"]
            .as_js_string()
            .and_then(wire::date_milliseconds)
        else {
            return Ok(false);
        };
        let duration = match input.get("windowDurationMinutes") {
            Some(Value::Null) => None,
            Some(value) => {
                let Some(value) = value
                    .as_f64()
                    .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0)
                else {
                    return Ok(false);
                };
                Some(value)
            }
            None => return Ok(false),
        };
        let (owner, provider, account) = (
            owner.to_owned(),
            text(input, "providerId")?,
            text(input, "providerAccountId")?,
        );
        let rows=self.database.query("SELECT p.kind FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=$2 AND p.owner_id=$1 WHERE a.id=$3 AND a.provider_id=$2 LIMIT 1", &[&owner,&provider,&account]).await?;
        let Some(row) = rows.first() else {
            return Ok(false);
        };
        let kind: String = row.get(0)?;
        let worker = input["workerId"]
            .as_js_string()
            .filter(|value| !value.is_empty())
            .map(|value| value.lossy().into_owned());
        // Historical readings accept an owned worker even after unlinking.
        if let Some(worker) = &worker
            && self
                .database
                .query(
                    "SELECT id FROM workers WHERE id=$2 AND owner_id=$1 LIMIT 1",
                    &[&owner, &worker],
                )
                .await?
                .is_empty()
        {
            return Ok(false);
        }
        let mut record = Value::object([
            ("id", Value::String(uuid::Uuid::new_v4().to_string().into())),
            ("owner_id", Value::String(owner.into())),
            ("provider_id", Value::String(provider.into())),
            ("provider_kind", Value::String(kind.into())),
            ("provider_account_id", Value::String(account.clone().into())),
            (
                "observed_at",
                Value::String(
                    wire::date_iso_milliseconds(observed)
                        .context("Invalid time value")?
                        .into(),
                ),
            ),
            (
                "used_percent_micros",
                Value::Number(super::round_nonnegative(used * 1_000_000.0)),
            ),
            (
                "window_duration_minutes",
                duration.map_or(Value::Null, Value::Number),
            ),
        ]);
        for (source, target) in [
            ("eventKey", "event_key"),
            ("observationBatchKey", "observation_batch_key"),
            ("workerId", "worker_id"),
            ("limitId", "limit_id"),
            ("windowKind", "window_kind"),
            ("reachedType", "reached_type"),
            ("observationTrigger", "observation_trigger"),
            ("isWeeklyProjection", "is_weekly_projection"),
            ("chatId", "chat_id"),
            ("turnId", "turn_id"),
            ("executionAttemptId", "execution_attempt_id"),
            ("workerVersion", "worker_version"),
            ("serverVersion", "server_version"),
            ("codexVersion", "codex_version"),
        ] {
            record[target] = input.get(source).cloned().unwrap_or(Value::Null);
            if let Some(value) = record[target].as_js_string() {
                record[target] = Value::String(value.lossy().into_owned().into());
            }
        }
        let resets = if input["resetsAt"].is_null() {
            None
        } else {
            Some(iso(&input["resetsAt"])?)
        };
        record["resets_at"] = resets
            .as_ref()
            .map_or(Value::Null, |value| Value::String(value.as_str().into()));
        let weekly = input["isWeeklyProjection"] == true;
        let plan = input["planType"]
            .as_js_string()
            .filter(|value| !value.is_empty())
            .map(|value| value.lossy().into_owned());
        let original = input.clone();
        self.database.transaction(move |tx|Box::pin(async move {
            let result=tx.query("INSERT INTO provider_quota_observations(id,owner_id,event_key,observation_batch_key,provider_id,provider_kind,provider_account_id,worker_id,observed_at,used_percent_micros,resets_at,window_duration_minutes,limit_id,window_kind,reached_type,observation_trigger,is_weekly_projection,chat_id,turn_id,execution_attempt_id,worker_version,server_version,codex_version) SELECT q.id,q.owner_id,q.event_key,q.observation_batch_key,q.provider_id,q.provider_kind,q.provider_account_id,q.worker_id,q.observed_at,q.used_percent_micros,q.resets_at,q.window_duration_minutes,q.limit_id,q.window_kind,q.reached_type,q.observation_trigger,q.is_weekly_projection,q.chat_id,q.turn_id,q.execution_attempt_id,q.worker_version,q.server_version,q.codex_version FROM jsonb_populate_record(NULL::provider_quota_observations,$1::text::jsonb) q ON CONFLICT(owner_id,event_key) DO NOTHING RETURNING id", &[&record.stringify()]).await;
            let rows = match result { Ok(rows) => rows, Err(error) => {
                let context=super::quota_query_error::insert(&record,&original);
                super::query_error::context(Err(error),&context.0,&context.1)?
            }};
            if rows.is_empty() {return Ok(false);}
            if !weekly {return Ok(true);}
            let at=now();
            let observed=wire::date_iso_milliseconds(observed).context("Invalid time value")?;
            let basis=Value::Number(super::round_nonnegative(used*100.0)).stringify();
            let result=tx.query("UPDATE model_provider_accounts SET weekly_usage_used_basis_points=$2::text::integer,weekly_usage_resets_at=$3::text::timestamptz,weekly_usage_observed_at=$4::text::timestamptz,updated_at=$5,plan_type=CASE WHEN $6::text IS NOT NULL THEN $6 ELSE plan_type END WHERE id=$1 AND (weekly_usage_observed_at IS NULL OR weekly_usage_observed_at<=$4::text::timestamptz)", &[&account,&basis,&resets,&observed,&at,&plan]).await;
            if result.is_err() { let context=super::quota_query_error::projection(&record,&original,super::round_nonnegative(used*100.0),at,false); super::query_error::context(result,&context.0,&context.1)?; }
            if let Some(worker)=worker {
                let result=tx.query("UPDATE model_provider_account_workers SET weekly_usage_used_basis_points=$3::text::integer,weekly_usage_resets_at=$4::text::timestamptz,weekly_usage_observed_at=$5::text::timestamptz,updated_at=$6 WHERE account_id=$1 AND worker_id=$2 AND (weekly_usage_observed_at IS NULL OR weekly_usage_observed_at<=$5::text::timestamptz)", &[&account,&worker,&basis,&resets,&observed,&at]).await;
                if result.is_err() { let context=super::quota_query_error::projection(&record,&original,super::round_nonnegative(used*100.0),at,true); super::query_error::context(result,&context.0,&context.1)?; }
            }
            Ok(true)
        })).await
    }
    pub async fn persist_quota_snapshot(
        &self,
        context: &QuotaContext<'_>,
        input: &Value,
    ) -> Result<usize> {
        let snapshot = parse_response("providerQuotaSnapshotSchema", Some(input))?;
        let observed = iso(&snapshot["observedAt"])?;
        if let Some(credits) = snapshot.get("credits").filter(|value| !value.is_null()) {
            let date = chrono::DateTime::parse_from_rfc3339(&observed)?.with_timezone(&chrono::Utc);
            self.record_provider_account_credits_wire(
                context.owner,
                context.provider,
                context.account,
                credits,
                date,
            )
            .await?;
        }
        let snapshot_id = snapshot["snapshotId"]
            .as_js_string()
            .expect("validated snapshot ID");
        let mut inserted = 0;
        for (index, window) in snapshot["windows"]
            .as_array()
            .expect("validated quota windows")
            .iter()
            .enumerate()
        {
            let prefix = JsString::from(format!("{}:{}:", context.provider, context.account));
            let suffix = JsString::from(format!(":{index}"));
            let event_key = concatenate(&[&prefix, snapshot_id, &suffix]);
            let resets = window["resetsAt"]
                .as_f64()
                .map(|seconds| {
                    wire::date_iso_milliseconds((seconds * 1000.0) as i64)
                        .context("Invalid time value")
                })
                .transpose()?;
            let mut observation = Value::from_serialize(
                &json!({"providerId":context.provider,"providerAccountId":context.account,"workerId":context.worker,"observedAt":observed,"resetsAt":resets,"observationTrigger":context.trigger,"chatId":context.chat,"turnId":context.turn,"executionAttemptId":context.execution_attempt,"serverVersion":server_version()}),
            );
            observation["eventKey"] = Value::String(event_key);
            observation["observationBatchKey"] = snapshot["snapshotId"].clone();
            for key in [
                "usedPercent",
                "windowDurationMinutes",
                "limitId",
                "windowKind",
                "reachedType",
                "isWeeklyProjection",
            ] {
                observation[key] = window[key].clone();
            }
            observation["planType"] = window
                .get("planType")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| Value::from_serialize(&context.account_plan_type));
            observation["workerVersion"] = snapshot["workerVersion"].clone();
            observation["codexVersion"] = snapshot["codexVersion"].clone();
            if self
                .record_provider_quota_observation(context.owner, &observation)
                .await?
            {
                inserted += 1;
            }
        }
        Ok(inserted)
    }
    pub async fn read_and_persist_quota_snapshot(
        &self,
        context: &QuotaContext<'_>,
        commands: &Arc<LimitedCommandBus>,
        provider: &Value,
    ) -> Result<(usize, Value)> {
        let mut runtime = Value::object([
            ("id", Value::String(context.provider.into())),
            ("protectedApiKey", Value::Null),
            ("accountId", Value::String(context.account.into())),
        ]);
        for key in ["name", "kind", "baseUrl", "credentialHomeKey"] {
            runtime[key] = provider[key].clone();
        }
        let response = commands
            .request(
                context.worker,
                Value::object([
                    ("type", Value::String("provider.quota.read".into())),
                    ("provider", runtime),
                ]),
                Some(Duration::from_secs(120)),
                None,
            )
            .await?;
        let snapshot = parse_response("providerQuotaSnapshotSchema", response.as_ref())?;
        let inserted = self.persist_quota_snapshot(context, &snapshot).await?;
        Ok((inserted, snapshot))
    }
}
