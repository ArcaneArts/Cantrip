//! Source-scoped aggregation never holds a lock across worker execution.
use super::write_support::*;
use crate::{
    chats::turn_behavior::{empty_attribution, merge_attribution},
    database::Transaction,
    settings::repository::SettingsRepository,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result, ensure};

fn summary(evidence: &Value) -> Result<Value> {
    let turns = evidence["turnIds"]
        .as_array()
        .context("Native behavior turn IDs")?;
    let captures = evidence["captures"]
        .as_array()
        .context("Native behavior captures")?;
    let covered = !turns.is_empty()
        && turns
            .iter()
            .all(|turn| captures.iter().any(|capture| capture["turnId"] == *turn))
        && evidence["conflictingTurnKeys"]
            .as_array()
            .context("Native behavior conflicts")?
            .is_empty();
    let (mut efforts, mut selections) = (Vec::new(), Vec::new());
    for capture in captures {
        if !efforts.contains(&capture["reasoningEffort"]) {
            efforts.push(capture["reasoningEffort"].clone());
        }
        let selection = capture["selection"].stringify();
        if !selections.contains(&selection) {
            selections.push(selection);
        }
    }
    let selection = if covered && selections.len() == 1 {
        captures
            .first()
            .map(|v| v["selection"].clone())
            .filter(|v| v["status"] == "resolved")
    } else {
        None
    };
    let reasoning_known = covered && efforts.len() == 1;
    Ok(
        json!({"selection":selection.unwrap_or(Value::Null),"reasoningKnown":reasoning_known,"reasoningEffort":if reasoning_known{efforts[0].clone()}else{Value::Null},"turnId":if turns.len()==1&&captures.len()<=1{turns[0].clone()}else{Value::Null}}),
    )
}
async fn attribution(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    existing: Option<&Value>,
    anchor: Option<&Value>,
) -> Result<Value> {
    let retained = existing
        .and_then(|v| v.get("native_attribution"))
        .filter(|v| truthy(Some(v)));
    if !truthy(input.get("nativeAttribution")) && retained.is_none() {
        return Ok(
            json!({"route":anchor.cloned().unwrap_or(Value::Null),"reasoningEffort":nullish(input.get("reasoningEffort")),"turnId":nullish(input.get("turnId")),"signals":Value::object([] as [(&str,Value);0]),"evidence":Value::Null}),
        );
    }
    if retained.is_some() {
        for (field, column) in [
            ("workerId", "worker_id"),
            ("providerAccountId", "provider_account_id"),
        ] {
            ensure!(
                input
                    .get(field)
                    .is_none_or(|value| existing.and_then(|v| v.get(column)) == Some(value)),
                "Native behavior observation belongs to another worker/account."
            );
        }
        if let (Some(existing), Some(anchor)) = (existing, anchor) {
            ensure!(
                !truthy(existing.get("provider_id"))
                    || anchor["providerId"] == existing["provider_id"],
                "Native behavior source belongs to another session provider."
            );
        }
    }
    let mut incoming = fallback(input.get("nativeAttribution"), &empty_attribution());
    let mut turns = incoming["turnIds"]
        .as_array()
        .context("Native behavior incoming turns")?
        .clone();
    if let Some(turn) = input.get("turnId").filter(|v| truthy(Some(v))) {
        turns.push(turn.clone());
    }
    incoming["turnIds"] = Value::Array(turns);
    let evidence = merge_attribution(retained, &incoming)?;
    let worker = input
        .get("workerId")
        .or_else(|| existing.and_then(|v| v.get("worker_id")));
    let account = input
        .get("providerAccountId")
        .cloned()
        .unwrap_or_else(|| nullish(existing.and_then(|v| v.get("provider_account_id"))));
    let captures = evidence["captures"]
        .as_array()
        .context("Native behavior captures")?;
    for capture in captures {
        let selection = &capture["selection"];
        ensure!(
            selection["status"] != "resolved"
                || (selection.get("workerId") == worker
                    && selection["providerAccountId"] == account),
            "Native behavior capture belongs to another worker/account."
        );
    }
    let summarized = summary(&evidence)?;
    let route = if retained == Some(&evidence) {
        let existing = existing.unwrap();
        Some(
            json!({"modelId":existing["model_id"],"modelRouteId":existing["model_route_id"],"providerId":existing["provider_id"]}),
        )
    } else {
        let selections: Vec<_> = captures
            .iter()
            .map(|v| &v["selection"])
            .filter(|v| v["status"] == "resolved")
            .collect();
        if selections.is_empty() {
            None
        } else {
            let ids = selections
                .iter()
                .map(|v| text(&v["routeId"]))
                .collect::<Result<Vec<_>>>()?;
            let routes = routes(tx, owner, &ids).await?;
            let valid = selections.iter().all(|s| {
                routes.iter().any(|r| {
                    r["modelRouteId"] == s["routeId"]
                        && r["modelId"] == s["modelId"]
                        && r["providerId"] == s["providerId"]
                        && anchor.and_then(|v| v.get("providerId")) == s.get("providerId")
                })
            });
            if valid && !summarized["selection"].is_null() {
                routes
                    .into_iter()
                    .find(|r| r["modelRouteId"] == summarized["selection"]["routeId"])
            } else {
                None
            }
        }
    };
    Ok(
        json!({"route":route.clone().unwrap_or(Value::Null),"evidence":evidence,"turnId":summarized["turnId"],"reasoningEffort":summarized["reasoningEffort"],"signals":json!({"nativeModelKnown":route.as_ref().is_some_and(|v|truthy(v.get("modelId"))),"nativeReasoningKnown":summarized["reasoningKnown"]})}),
    )
}
impl SettingsRepository {
    pub async fn record_model_behavior_observation(
        &self,
        owner: &str,
        input: &Value,
    ) -> Result<()> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let (owner,input) = (owner.as_str(),&input);
            let key = Value::Array(vec![json!("model-behavior"),json!(owner),input["sourceKey"].clone()]).stringify();
            tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",&[&key]).await?;
            let source = text(&input["sourceKey"])?;
            let existing = one(tx,"SELECT to_jsonb(b)::text FROM model_behavior_observations b WHERE owner_id=$1 AND source_key=$2",&[&owner,&source]).await?;
            if let Some(existing) = &existing {
                ensure!(existing.get("chat_id")==input.get("chatId") && existing.get("project_id")==input.get("projectId") && existing.get("execution_attempt_id")==input.get("executionAttemptId"),"Model behavior source belongs to a different attempt.");
            }
            if truthy(input.get("chatId")) {
                ensure!(!tx.query("SELECT id FROM chats WHERE id=$1 AND owner_id=$2",&[&text(&input["chatId"])?,&owner]).await?.is_empty(),"Model behavior chat is not owned by this account.");
            }
            let anchor = routes(tx,owner,&[text(&input["modelRouteId"])?]).await?.into_iter().next();
            let attribution = attribution(tx,owner,input,existing.as_ref(),anchor.as_ref()).await?;
            let at = json!(crate::auth::iso(crate::auth::now()));
            let mut values = json!({"project_id":nullish(input.get("projectId")),"chat_id":nullish(input.get("chatId")),"model_id":attribution["route"]["modelId"],"model_route_id":attribution["route"]["modelRouteId"],"provider_id":fallback(anchor.as_ref().and_then(|v|v.get("providerId")),&nullish(existing.as_ref().and_then(|v|v.get("provider_id")))),"turn_id":attribution["turnId"],"execution_attempt_id":input["executionAttemptId"],"attempt_kind":fallback(input.get("attemptKind"),&json!("chat-turn")),"attempt_status":input["attemptStatus"],"reasoning_effort":attribution["reasoningEffort"],"native_attribution":attribution["evidence"],"duration_ms":nullable_count(input.get("durationMs"))?,"model_context_window":nullable_count(input.get("modelContextWindow"))?,"context_used_percent_basis_points":if matches!(input.get("contextUsedPercent"),Some(Value::Number(_))){count(Some(&json!(input["contextUsedPercent"].as_f64().unwrap()*100.0)))?}else{Value::Null},"final_answer_appeared":fallback(input.get("finalAnswerAppeared"),&json!(false)),"user_interrupted":fallback(input.get("userInterrupted"),&json!(false)),"user_retry_regeneration":nullish(input.get("userRetryRegeneration")),"immediate_corrective_followup":fallback(input.get("immediateCorrectiveFollowup"),&json!(false)),"updated_at":at});
            for (field,column) in [("providerAccountId","provider_account_id"),("workerId","worker_id")] { values[column] = input.get(field).cloned().unwrap_or_else(||nullish(existing.as_ref().and_then(|v|v.get(column)))); }
            for (field,column) in [("firstActivityAt","first_activity_at"),("firstVisibleResponseAt","first_visible_response_at"),("completedAt","completed_at"),("finalizedAt","finalized_at"),("workerVersion","worker_version"),("serverVersion","server_version"),("codexVersion","codex_version")] { values[column] = nullish(input.get(field)); }
            for (field,column) in [("routeAttemptIndex","route_attempt_index"),("retryFailoverCount","retry_failover_count"),("toolCallCount","tool_call_count"),("invalidToolCallCount","invalid_tool_call_count"),("compactionCount","compaction_count"),("approvalRequestCount","approval_request_count"),("inputTokens","input_tokens"),("cachedInputTokens","cached_input_tokens"),("cacheWriteInputTokens","cache_write_input_tokens"),("outputTokens","output_tokens"),("reasoningOutputTokens","reasoning_output_tokens"),("filesChangedCount","files_changed_count"),("testCommandCount","test_command_count"),("testPassCount","test_pass_count"),("testFailureCount","test_failure_count")] { values[column] = count(input.get(field))?; }
            let mut signals = Value::object([] as [(&str,Value);0]);
            for value in [existing.as_ref().and_then(|v|v.get("signal_availability")),input.get("signalAvailability"),attribution.get("signals")].into_iter().flatten() {
                if let Some(object) = value.as_object() { for (key,value) in object { if let Value::Object(object) = &mut signals { object.insert(key.clone(),value.clone()); } } }
            }
            values["signal_availability"] = signals;
            if let Some(existing) = &existing && truthy(existing.get("native_attribution")) && existing["attempt_status"]!="running" && input["attemptStatus"]=="running" {
                let columns = values.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
                for key in columns { let column = key.as_str().unwrap();if !["model_id","model_route_id","provider_id","reasoning_effort","native_attribution","turn_id","signal_availability","updated_at"].contains(&column) { values[column] = existing[column].clone(); } }
            }
            for column in ["project_id","chat_id","model_id","model_route_id","provider_id","provider_account_id","worker_id","turn_id","execution_attempt_id","attempt_kind","attempt_status","reasoning_effort","worker_version","server_version","codex_version"] { values[column] = column_text(&values[column]); }
            let updates = values.as_object().unwrap().keys().map(|key|format!("{key}=EXCLUDED.{key}")).collect::<Vec<_>>().join(",");
            values["id"] = json!(uuid::Uuid::new_v4().to_string());values["owner_id"] = json!(owner);values["source_key"] = json!(source);values["started_at"] = fallback(input.get("startedAt"),&at);
            let columns = values.as_object().unwrap().keys().map(|key|key.as_str().unwrap()).collect::<Vec<_>>();
            let selected = columns.iter().map(|column|format!("incoming.{column}")).collect::<Vec<_>>().join(",");
            let sql = format!("INSERT INTO model_behavior_observations({}) SELECT {selected} FROM jsonb_populate_record(NULL::model_behavior_observations,$1::jsonb) incoming ON CONFLICT(owner_id,source_key) DO UPDATE SET {updates}",columns.join(","));
            tx.query(&sql,&[&postgres_types::Json(values)]).await?;
            Ok(())
        })).await
    }
}
