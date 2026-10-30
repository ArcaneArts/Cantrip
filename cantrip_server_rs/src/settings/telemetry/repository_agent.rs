//! Token persistence for the exact non-chat Git-agent call shape. Native chat
//! attribution and history ingestion remain separate consumers of telemetry.
use crate::{
    database::Transaction,
    settings::repository::SettingsRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, bail};

pub struct RepositoryAgentUsage<'a> {
    pub owner: &'a str,
    pub project: &'a str,
    pub worker: &'a str,
    pub operation: &'a str,
    pub runtime: &'a Value,
    pub execution: &'a Value,
    pub server_version: &'a str,
}
impl SettingsRepository {
    pub async fn record_repository_agent_usage(
        &self,
        input: RepositoryAgentUsage<'_>,
    ) -> Result<()> {
        let route = input.runtime["routeId"]
            .as_str()
            .context("Git agent route")?;
        let attempt = format!("{}:{route}", input.operation);
        let data = json!({"owner_id":input.owner,"project_id":input.project,"chat_id":Value::Null,
            "source_key":format!("git-agent:{attempt}"),"model_route_id":route,
            "provider_account_id":input.runtime["provider"]["accountId"],"worker_id":input.worker,
            "turn_id":input.execution["turnId"],"execution_attempt_id":attempt,"attempt_kind":"git-agent",
            "attempt_status":"completed","reasoning_effort":input.runtime["model"]["reasoningEffort"],
            "worker_version":Value::Null,"server_version":input.server_version,"codex_version":Value::Null});
        let usage = input.execution.get("measuredUsage").cloned();
        self.database
            .transaction(|tx| Box::pin(async move { persist(tx, data, usage).await }))
            .await
    }
}
async fn persist(tx: &Transaction<'_>, mut data: Value, usage: Option<Value>) -> Result<()> {
    let owner = data["owner_id"].as_str().unwrap().to_owned();
    let source = data["source_key"].as_str().unwrap().to_owned();
    let turn = data["turn_id"].as_str().map(str::to_owned);
    let aliases = postgres_types::Json(Value::from_serialize(std::slice::from_ref(&source)));
    let rows = tx.query("SELECT source_key,turn_id,native_model_attribution IS NOT NULL FROM token_usage_records WHERE owner_id=$1 AND chat_id IS NULL AND (source_key=$2 OR source_aliases @> $3::jsonb)", &[&owner,&source,&aliases]).await?;
    let mut matching = Vec::new();
    for row in &rows {
        let retained_turn = row.get::<Option<String>>(1)?;
        if turn.as_ref().is_none_or(|v| v.is_empty())
            || retained_turn == turn
            || (retained_turn.is_none() && !row.get::<bool>(2)?)
        {
            matching.push(row);
        }
    }
    if matching.len() > 1 {
        bail!("Usage source alias identifies multiple native turns; specify the exact turn.");
    }
    if matching.is_empty() && !rows.is_empty() {
        bail!("Usage source alias belongs to another retained turn.");
    }
    if let Some(row) = matching.first() {
        data["source_key"] = json!(row.get::<String>(0)?);
    } else {
        let elsewhere = tx
            .query(
                "SELECT chat_id FROM token_usage_records WHERE owner_id=$1 AND source_key=$2",
                &[&owner, &source],
            )
            .await?;
        if let Some(row) = elsewhere.first()
            && row.get::<Option<String>>(0)?.is_some()
        {
            bail!("Usage source key belongs to another chat.");
        }
    }
    let source = data["source_key"].as_str().unwrap();
    let retained = tx.query("SELECT native_usage IS NOT NULL FROM token_usage_records WHERE owner_id=$1 AND source_key=$2", &[&owner,&source]).await?;
    let native_usage = retained
        .first()
        .map(|row| row.get::<bool>(0))
        .transpose()?
        .unwrap_or(false);
    let usage = if native_usage { None } else { usage };
    let route = data["model_route_id"].as_str().unwrap();
    let routes = tx.query("SELECT m.id,r.id,p.id FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 INNER JOIN model_providers p ON p.id=r.provider_id AND p.owner_id=$1 WHERE r.id=$2 LIMIT 1", &[&owner,&route]).await?;
    for (index, key) in ["model_id", "model_route_id", "provider_id"]
        .iter()
        .enumerate()
    {
        data[*key] = routes
            .first()
            .map(|row| row.get::<String>(index).map(|v| json!(v)))
            .transpose()?
            .unwrap_or(Value::Null);
    }
    let now = json!(crate::auth::iso(crate::auth::now()));
    for key in ["started_at", "completed_at", "finalized_at", "updated_at"] {
        data[key] = now.clone();
    }
    data["id"] = json!(uuid::Uuid::new_v4().to_string());
    let counts = [
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("cached_input_tokens", "cachedInputTokens"),
        ("reasoning_output_tokens", "reasoningOutputTokens"),
        ("cache_write_input_tokens", "cacheWriteInputTokens"),
    ];
    for (column, key) in counts {
        data[column] = json!(
            usage
                .as_ref()
                .and_then(|u| u[key].as_f64())
                .unwrap_or(0.0)
                .round()
                .max(0.0)
        );
    }
    data["visible_output_tokens"] = usage
        .as_ref()
        .and_then(|u| u["visibleOutputTokens"].as_f64())
        .map_or(Value::Null, |v| json!(v.round().max(0.0)));
    data["reported_total_tokens"] = usage.as_ref().map_or(Value::Null, |u| {
        json!(u["totalTokens"].as_f64().unwrap_or(0.0).round().max(0.0))
    });
    data["usage_semantics"] = json!("provider-reported-v2");
    let columns = data
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, _)| key.as_str().unwrap())
        .collect::<Vec<_>>();
    let retain =
        "retained.native_model_attribution IS NOT NULL OR retained.native_usage IS NOT NULL";
    let mut updates = vec![
        "project_id=excluded.project_id".to_owned(),
        "chat_id=excluded.chat_id".to_owned(),
    ];
    for key in [
        "model_id",
        "model_route_id",
        "provider_id",
        "provider_account_id",
        "worker_id",
        "reasoning_effort",
    ] {
        updates.push(format!(
            "{key}=CASE WHEN {retain} THEN retained.{key} ELSE excluded.{key} END"
        ));
    }
    if turn.is_some() {
        updates.push(format!(
            "turn_id=CASE WHEN {retain} THEN retained.turn_id ELSE excluded.turn_id END"
        ));
    }
    for key in [
        "execution_attempt_id",
        "attempt_kind",
        "worker_version",
        "server_version",
        "updated_at",
    ] {
        updates.push(format!("{key}=excluded.{key}"));
    }
    updates.push("attempt_status=CASE WHEN retained.attempt_status <> 'running' AND retained.native_usage IS NOT NULL THEN retained.attempt_status ELSE excluded.attempt_status END".into());
    if usage.is_some() {
        for key in [
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "reasoning_output_tokens",
            "cache_write_input_tokens",
            "visible_output_tokens",
            "reported_total_tokens",
            "usage_semantics",
        ] {
            updates.push(format!("{key}=excluded.{key}"));
        }
    }
    let sql = format!(
        "INSERT INTO token_usage_records AS retained ({}) SELECT {} FROM jsonb_populate_record(NULL::token_usage_records,$1::jsonb) AS incoming ON CONFLICT(owner_id,source_key) DO UPDATE SET {} WHERE retained.native_model_attribution IS NULL OR (retained.chat_id IS NOT DISTINCT FROM excluded.chat_id AND (excluded.worker_id IS NULL OR retained.worker_id IS NOT DISTINCT FROM excluded.worker_id) AND (excluded.turn_id IS NULL OR retained.turn_id IS NOT DISTINCT FROM excluded.turn_id)) RETURNING id",
        columns.join(","),
        columns
            .iter()
            .map(|c| format!("incoming.{c}"))
            .collect::<Vec<_>>()
            .join(","),
        updates.join(",")
    );
    if tx
        .query(&sql, &[&postgres_types::Json(data)])
        .await?
        .is_empty()
    {
        bail!("Native turn model attribution conflicts with the retained usage record.");
    }
    Ok(())
}
