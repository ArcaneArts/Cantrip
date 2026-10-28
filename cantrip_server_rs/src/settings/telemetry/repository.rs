use super::{
    changes, iso, json_rows, max_zero, milliseconds, number, object, quota, statistics, stored_date,
};
use crate::{
    auth,
    settings::repository::SettingsRepository,
    wire::{JsString, Value, coercion::truthy},
};
use anyhow::{Context, Result};
use indexmap::IndexMap;
use postgres_types::ToSql;

#[derive(Clone, Default)]
pub struct TelemetryQuery {
    pub filters: Value,
    pub from: Option<i64>,
    pub to: Option<i64>,
}
impl TelemetryQuery {
    pub fn from_value(input: &Value) -> Result<Self> {
        let time = |key: &str| -> Result<Option<i64>> {
            if input[key].is_null() {
                return Ok(None);
            }
            let time = milliseconds(&input[key]);
            anyhow::ensure!(time.is_finite(), "Invalid time value");
            Ok(Some(time as i64))
        };
        Ok(Self {
            filters: input.clone(),
            from: time("from")?,
            to: time("to")?,
        })
    }
}
fn runtime_row(row: &Value) -> Result<Value> {
    let mut result = crate::wire::value::Object::new();
    for (key, value) in row.as_object().context("stored telemetry row")? {
        let key = key.as_str().context("stored telemetry column")?;
        let mut camel = String::new();
        let mut upper = false;
        for ch in key.chars() {
            if ch == '_' {
                upper = true;
            } else {
                camel.push(if upper { ch.to_ascii_uppercase() } else { ch });
                upper = false;
            }
        }
        result.insert(
            camel.into(),
            if key.ends_with("_at") {
                stored_date(value)?
            } else {
                value.clone()
            },
        );
    }
    Ok(Value::Object(result))
}
async fn rows(
    repo: &SettingsRepository,
    table: &str,
    owner: &str,
    query: &TelemetryQuery,
    is_quota: bool,
) -> Result<Vec<Value>> {
    let mut values = vec![owner.to_owned()];
    let mut filters = vec!["owner_id=$1".to_owned()];
    for (field, column) in [
        ("providerId", "provider_id"),
        ("providerAccountId", "provider_account_id"),
        ("modelId", "model_id"),
        ("reasoningEffort", "reasoning_effort"),
        ("projectId", "project_id"),
    ]
    .into_iter()
    .take(if is_quota { 2 } else { 5 })
    {
        if truthy(query.filters.get(field)) {
            values.push(crate::settings::raw_identifiers::text(
                &query.filters[field],
            )?);
            filters.push(format!("{column}=${}", values.len()));
        }
    }
    let at = if is_quota {
        "observed_at"
    } else {
        "started_at"
    };
    for (time, operator) in [(query.from.filter(|_| !is_quota), ">="), (query.to, "<=")] {
        if let Some(time) = time {
            values.push(iso(time as f64)?);
            filters.push(format!(
                "{at}{operator}${}::text::timestamptz",
                values.len()
            ));
        }
    }
    let parameters = values
        .iter()
        .map(|value| value as &(dyn ToSql + Sync))
        .collect::<Vec<_>>();
    let sql = format!(
        "SELECT to_jsonb(q)::text FROM {table} q WHERE {} ORDER BY {at} ASC",
        filters.join(" AND ")
    );
    json_rows(repo, &sql, &parameters)
        .await?
        .iter()
        .map(runtime_row)
        .collect()
}
fn pick(row: &Value, fields: &[&str]) -> Value {
    Value::object(fields.iter().map(|key| (*key, row[*key].clone())))
}
fn readings(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            let mut result = pick(
                &row,
                &[
                    "id",
                    "providerId",
                    "providerAccountId",
                    "limitId",
                    "windowKind",
                    "windowDurationMinutes",
                    "resetsAt",
                    "observedAt",
                    "receivedAt",
                ],
            );
            result["limitName"] = quota::nullish(&row["limitId"], &row["windowKind"]);
            result["usedPercent"] = Value::Number(number(&row, "usedPercentMicros") / 1_000_000.0);
            result
        })
        .collect()
}
fn ranged(readings: Vec<Value>, from: Option<i64>) -> Vec<Value> {
    let Some(from) = from else { return readings };
    let mut selected: IndexMap<JsString, Value> = IndexMap::new();
    for row in readings
        .iter()
        .filter(|row| milliseconds(&row["observedAt"]) >= from as f64)
    {
        let prior = readings.iter().rfind(|candidate| {
            ["providerAccountId", "limitId", "windowKind"]
                .iter()
                .all(|key| candidate[*key] == row[*key])
                && ((candidate["resetsAt"].is_null() && row["resetsAt"].is_null())
                    || milliseconds(&candidate["resetsAt"]) == milliseconds(&row["resetsAt"]))
                && milliseconds(&candidate["observedAt"]) < from as f64
        });
        for candidate in prior.into_iter().chain(std::iter::once(row)) {
            selected.insert(
                candidate["id"].as_js_string().unwrap().clone(),
                candidate.clone(),
            );
        }
    }
    selected.into_values().collect()
}
fn attempts(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .map(|mut row| {
            row["modelName"] = quota::nullish(
                &row["modelId"],
                quota::nullish(&row["modelRouteId"], "unattributed"),
            );
            row
        })
        .collect()
}
fn detailed_breakdown(entries: &Value) -> Value {
    Value::Array(
        entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let mut result = pick(
                    entry,
                    &[
                        "key",
                        "sampleCount",
                        "highConfidenceSamples",
                        "unattributedSamples",
                        "effectiveTokensPer100Percent",
                    ],
                );
                let mut tokens = pick(
                    &entry["totals"],
                    &[
                        "inputTokens",
                        "outputTokens",
                        "cachedInputTokens",
                        "cacheWriteInputTokens",
                        "reasoningOutputTokens",
                    ],
                );
                tokens["totalTokens"] =
                    Value::Number(number(&tokens, "inputTokens") + number(&tokens, "outputTokens"));
                result["tokens"] = tokens;
                result
            })
            .collect(),
    )
}
fn behavior_breakdown(rows: &[Value], key: impl Fn(&Value) -> JsString) -> Vec<Value> {
    let mut summaries = statistics::group_model_behavior(rows, key)
        .into_iter()
        .map(|(key, mut value)| {
            value["key"] = Value::String(key);
            value
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|a, b| {
        number(b, "attemptCount")
            .partial_cmp(&number(a, "attemptCount"))
            .unwrap()
    });
    summaries
}
fn estimates(samples: &[Value]) -> Value {
    let eligible = samples
        .iter()
        .filter(|sample| !truthy(sample.get("unattributed")))
        .collect::<Vec<_>>();
    object!({"sampleCount":samples.len(),"highConfidenceSamples":samples.iter().filter(|sample|sample["confidence"]=="high").count(),"unattributedSamples":samples.iter().filter(|sample|truthy(sample.get("unattributed"))).count(),"tokensPerPercent":statistics::quota_value_statistics(&eligible.iter().map(|sample|number(&sample["tokensPerPercent"],"comparableTokens")).collect::<Vec<_>>()),"effectiveTokensPer100Percent":statistics::quota_value_statistics(&eligible.iter().map(|sample|number(sample,"effectiveTokensPer100Percent")).collect::<Vec<_>>())})
}
impl SettingsRepository {
    pub async fn get_quota_token_analytics(
        &self,
        owner: &str,
        query: &TelemetryQuery,
    ) -> Result<Value> {
        let (quota_rows, token_rows) = tokio::try_join!(
            rows(self, "provider_quota_observations", owner, query, true),
            rows(self, "token_usage_records", owner, query, false)
        )?;
        quota::derive(
            &ranged(readings(quota_rows), query.from),
            &attempts(token_rows),
            query.to.unwrap_or_else(|| auth::now().timestamp_millis()) as f64,
        )
    }
    async fn telemetry_accounts(&self, owner: &str, query: &TelemetryQuery) -> Result<Vec<Value>> {
        let provider = query
            .filters
            .get("providerId")
            .filter(|v| truthy(Some(v)))
            .map(crate::settings::raw_identifiers::text)
            .transpose()?;
        let mut parameters: Vec<&(dyn ToSql + Sync)> = vec![&owner];
        let filter = if let Some(provider) = &provider {
            parameters.push(provider);
            " AND p.id=$2"
        } else {
            ""
        };
        self.json_rows(&format!("SELECT jsonb_build_object('id',a.id,'providerId',a.provider_id) FROM model_provider_accounts a INNER JOIN model_providers p ON p.id=a.provider_id WHERE p.owner_id=$1{filter}"),&parameters).await.map(|rows|rows.iter().map(Value::from_serialize).collect())
    }
    pub async fn get_provider_telemetry_analytics(
        &self,
        owner: &str,
        query: &TelemetryQuery,
    ) -> Result<Value> {
        let from = query
            .from
            .unwrap_or_else(|| auth::now().timestamp_millis() - 364 * 86_400_000);
        let to = query.to.unwrap_or_else(|| auth::now().timestamp_millis());
        let scoped = TelemetryQuery {
            filters: query.filters.clone(),
            from: Some(from),
            to: Some(to),
        };
        let (quota, tokens, behavior, accounts) = tokio::try_join!(
            self.get_quota_token_analytics(owner, &scoped),
            rows(self, "token_usage_records", owner, &scoped, false),
            rows(self, "model_behavior_observations", owner, &scoped, false),
            self.telemetry_accounts(owner, &scoped),
        )?;
        let mut accounts = accounts
            .into_iter()
            .map(|row| (row["id"].as_js_string().unwrap().clone(), row))
            .collect::<IndexMap<_, _>>();
        let mut history = vec![];
        let mut current = IndexMap::new();
        let mut resets: IndexMap<JsString, Value> = IndexMap::new();
        for reading in quota["readings"].as_array().unwrap() {
            accounts.entry(reading["providerAccountId"].as_js_string().unwrap().clone()).or_insert_with(||object!({"id":reading["providerAccountId"],"providerId":reading["providerId"]}));
            let mut row = pick(
                reading,
                &[
                    "id",
                    "providerId",
                    "providerAccountId",
                    "limitId",
                    "windowKind",
                    "usedPercent",
                    "resetsAt",
                    "observedAt",
                ],
            );
            row["remainingPercent"] =
                Value::Number(max_zero(100.0 - number(reading, "usedPercent")));
            let key = quota::joined(&[
                row["providerId"].clone(),
                row["providerAccountId"].clone(),
                quota::nullish(&row["limitId"], "unidentified-limit"),
                row["windowKind"].clone(),
            ])?;
            current.insert(key, row.clone());
            if truthy(row.get("resetsAt")) {
                let key =
                    quota::joined(&[row["providerAccountId"].clone(), row["resetsAt"].clone()])?;
                if resets.get(&key).is_none_or(|previous| {
                    row["observedAt"].as_js_string().unwrap().units()
                        < previous["firstObservedAt"].as_js_string().unwrap().units()
                }) {
                    resets.insert(key,object!({"providerAccountId":row["providerAccountId"],"resetsAt":row["resetsAt"],"firstObservedAt":row["observedAt"]}));
                }
            }
            history.push(row);
        }
        let mut accounts = accounts.into_values().collect::<Vec<_>>();
        quota::locale_sort(&mut accounts, "id", false)?;
        let mut current = current.into_values().collect::<Vec<_>>();
        quota::locale_sort(&mut current, "observedAt", true)?;
        let mut resets = resets.into_values().collect::<Vec<_>>();
        quota::locale_sort(&mut resets, "resetsAt", false)?;
        let mut daily: IndexMap<JsString, Vec<Value>> = IndexMap::new();
        for row in &tokens {
            if let Some(start) = row["startedAt"].as_str() {
                daily
                    .entry(start[..10].into())
                    .or_default()
                    .push(row.clone());
            }
        }
        let mut daily = daily
            .into_iter()
            .map(|(date, rows)| {
                let mut total = statistics::sum_detailed_token_usage(&rows);
                total["date"] = Value::String(date);
                total
            })
            .collect::<Vec<_>>();
        quota::locale_sort(&mut daily, "date", false)?;
        let mut daily_behavior = behavior_breakdown(&behavior, |row| {
            row["startedAt"].as_str().unwrap()[..10].into()
        });
        for row in &mut daily_behavior {
            let Value::Object(fields) = row else {
                unreachable!()
            };
            let key = fields.shift_remove("key").unwrap();
            fields.insert("date".into(), key);
        }
        let samples = quota["movementSamples"].as_array().unwrap();
        Ok(
            object!({"generatedAt":auth::iso(auth::now()),"range":object!({"from":iso(from as f64)?,"to":iso(to as f64)?}),"accounts":accounts,"currentQuota":current,"quotaHistory":statistics::sample_quota_history(&history,800.0)?,"resetBoundaries":resets,"tokens":object!({"total":statistics::sum_detailed_token_usage(&tokens),"daily":daily}),"estimates":estimates(samples),"comparisons":pick(&quota,&["rolling7Days","rolling30Days","monthOverMonth"]),"breakdowns":object!({"accounts":detailed_breakdown(&quota["breakdowns"]["account"]),"models":detailed_breakdown(&quota["breakdowns"]["model"]),"reasoningEfforts":detailed_breakdown(&quota["breakdowns"]["reasoningEffort"]),"months":detailed_breakdown(&quota["breakdowns"]["month"])}),"behavior":object!({"total":statistics::summarize_model_behavior(&behavior),"daily":daily_behavior,"accounts":behavior_breakdown(&behavior,|row|quota::nullish(&row["providerAccountId"],"unattributed").as_js_string().unwrap().clone()),"models":behavior_breakdown(&behavior,|row|quota::nullish(&row["modelId"],quota::nullish(&row["modelRouteId"],"unattributed")).as_js_string().unwrap().clone()),"reasoningEfforts":behavior_breakdown(&behavior,|row|if truthy(row.get("nativeAttribution")) && row["signalAvailability"]["nativeReasoningKnown"]!=true{"unattributed".into()}else{quota::nullish(&row["reasoningEffort"],"provider-default").as_js_string().unwrap().clone()})}),"changePoints":changes::detect(samples,&behavior)?}),
        )
    }
}
