use super::{json_rows, object as json, stored_date};
use crate::{
    auth::{iso, now},
    settings::repository::SettingsRepository,
    wire::Value,
};
use anyhow::{Context, Result};

fn column(name: &str) -> String {
    let mut result = String::new();
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}
fn project(row: &Value, fields: &[&str]) -> Result<Value> {
    let mut result = crate::wire::value::Object::new();
    for field in fields {
        let value = &row[column(field).as_str()];
        result.insert(
            (*field).into(),
            if field.ends_with("At") {
                stored_date(value)?
            } else {
                value.clone()
            },
        );
    }
    Ok(Value::Object(result))
}
impl SettingsRepository {
    async fn telemetry_provider_owned(&self, owner: &str, provider: &str) -> Result<bool> {
        Ok(!self
            .database
            .query(
                "SELECT id FROM model_providers WHERE owner_id=$1 AND id=$2 LIMIT 1",
                &[&owner, &provider],
            )
            .await?
            .is_empty())
    }
    pub async fn export_provider_telemetry(
        &self,
        owner: &str,
        provider: &str,
    ) -> Result<Option<Value>> {
        if !self.telemetry_provider_owned(owner, provider).await? {
            return Ok(None);
        }
        let parameters: crate::database::Parameters<'_> = &[&owner, &provider];
        let (quota, tokens, behavior, catalog) = tokio::try_join!(
            json_rows(
                self,
                "SELECT to_jsonb(q)::text FROM provider_quota_observations q WHERE owner_id=$1 AND provider_id=$2 ORDER BY observed_at ASC",
                parameters
            ),
            json_rows(
                self,
                "SELECT to_jsonb(q)::text FROM token_usage_records q WHERE owner_id=$1 AND provider_id=$2 ORDER BY started_at ASC",
                parameters
            ),
            json_rows(
                self,
                "SELECT to_jsonb(q)::text FROM model_behavior_observations q WHERE owner_id=$1 AND provider_id=$2 ORDER BY started_at ASC",
                parameters
            ),
            json_rows(
                self,
                "SELECT to_jsonb(q)::text FROM provider_model_catalog_snapshots q WHERE owner_id=$1 AND provider_id=$2 ORDER BY observed_at ASC",
                parameters
            ),
        )?;
        let quota = quota
            .iter()
            .map(|row| {
                let mut result = project(
                    row,
                    &[
                        "id",
                        "eventKey",
                        "observationBatchKey",
                        "providerAccountId",
                        "workerId",
                        "observedAt",
                        "receivedAt",
                        "resetsAt",
                        "windowDurationMinutes",
                        "limitId",
                        "windowKind",
                        "reachedType",
                        "observationTrigger",
                        "chatId",
                        "turnId",
                        "executionAttemptId",
                        "workerVersion",
                        "serverVersion",
                        "codexVersion",
                    ],
                )?;
                result["usedPercent"] = Value::Number(
                    row["used_percent_micros"]
                        .as_f64()
                        .context("stored quota percentage")?
                        / 1_000_000.0,
                );
                Ok(result)
            })
            .collect::<Result<Vec<_>>>()?;
        let tokens = tokens
            .iter()
            .map(|row| {
                let mut result = project(
                    row,
                    &[
                        "id",
                        "projectId",
                        "chatId",
                        "sourceKey",
                        "modelId",
                        "modelRouteId",
                        "providerAccountId",
                        "workerId",
                        "turnId",
                        "executionAttemptId",
                        "attemptKind",
                        "attemptStatus",
                        "reasoningEffort",
                        "inputTokens",
                        "cachedInputTokens",
                        "cacheWriteInputTokens",
                        "outputTokens",
                        "reasoningOutputTokens",
                        "visibleOutputTokens",
                        "reportedTotalTokens",
                        "usageSemantics",
                        "startedAt",
                        "completedAt",
                        "finalizedAt",
                        "workerVersion",
                        "serverVersion",
                        "codexVersion",
                    ],
                )?;
                if !row["native_usage"].is_null() {
                    result["nativeUsage"] = row["native_usage"].clone();
                }
                Ok(result)
            })
            .collect::<Result<Vec<_>>>()?;
        let behavior = behavior
            .iter()
            .map(|row| {
                let mut result = project(
                    row,
                    &[
                        "id",
                        "sourceKey",
                        "projectId",
                        "chatId",
                        "modelId",
                        "modelRouteId",
                        "providerAccountId",
                        "workerId",
                        "turnId",
                        "executionAttemptId",
                        "attemptStatus",
                        "reasoningEffort",
                        "startedAt",
                        "completedAt",
                        "finalizedAt",
                        "durationMs",
                        "finalAnswerAppeared",
                        "toolCallCount",
                        "invalidToolCallCount",
                        "retryFailoverCount",
                        "compactionCount",
                        "approvalRequestCount",
                        "inputTokens",
                        "cachedInputTokens",
                        "cacheWriteInputTokens",
                        "outputTokens",
                        "reasoningOutputTokens",
                        "filesChangedCount",
                        "testCommandCount",
                        "testPassCount",
                        "testFailureCount",
                        "userInterrupted",
                        "userRetryRegeneration",
                        "immediateCorrectiveFollowup",
                        "forkCount",
                        "copyCount",
                        "ratingValue",
                        "workerVersion",
                        "serverVersion",
                        "codexVersion",
                        "signalAvailability",
                    ],
                )?;
                if crate::wire::coercion::truthy(row.get("native_attribution")) {
                    result["nativeAttribution"] = row["native_attribution"].clone();
                }
                Ok(result)
            })
            .collect::<Result<Vec<_>>>()?;
        let catalog = catalog
            .iter()
            .map(|row| {
                project(
                    row,
                    &[
                        "id",
                        "providerAccountId",
                        "workerId",
                        "availabilityScope",
                        "metadataSource",
                        "metadataHash",
                        "observedAt",
                    ],
                )
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(
            json!({"schemaVersion":2,"generatedAt":iso(now()),"provider":json!({"id":provider}),"privacy":json!({"includesMessageContent":false,"rawPayloadsStored":false,"dimensionLabels":"opaque-ids","retention":"owner-controlled-indefinite"}),"quotaObservations":quota,"tokenUsage":tokens,"modelBehavior":behavior,"modelCatalogSnapshots":catalog}),
        ))
    }
    pub async fn delete_provider_telemetry(
        &self,
        owner: &str,
        provider: &str,
    ) -> Result<Option<Value>> {
        if !self.telemetry_provider_owned(owner, provider).await? {
            return Ok(None);
        }
        let (owner, provider) = (owner.to_owned(), provider.to_owned());
        self.database.transaction(move |transaction| Box::pin(async move {
            let mut deleted=Value::object([] as [(&str,Value);0]);
            for (table,field) in [("provider_quota_observations","quotaObservations"),("token_usage_records","tokenUsage"),("model_behavior_observations","modelBehavior"),("provider_model_catalog_snapshots","modelCatalogSnapshots")] {
                let rows=transaction.query(&format!("DELETE FROM {table} WHERE owner_id=$1 AND provider_id=$2 RETURNING id"), &[&owner,&provider]).await?;
                deleted[field]=Value::Number(rows.len() as f64);
            }
            Ok(Some(json!({"providerId":provider,"deleted":deleted})))
        })).await
    }
}
