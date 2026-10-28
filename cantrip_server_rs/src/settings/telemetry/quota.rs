//! Quota movement attribution and period projections. Inputs retain native
//! JavaScript number and UTF-16 semantics until the response is serialized.
use super::{
    Datum, iso, max_zero, milliseconds, number, object as json, statistics::quota_value_statistics,
    text,
};
use crate::wire::{JsString, Value};
use anyhow::{Context, Result};
use indexmap::IndexMap;
use std::cmp::Ordering;

const TOTAL_KEYS: [&str; 8] = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "visibleOutputTokens",
    "reportedTotalTokens",
    "comparableTokens",
];
const DIMENSIONS: [&str; 9] = [
    "provider",
    "account",
    "model",
    "reasoningEffort",
    "project",
    "day",
    "week",
    "month",
    "quotaWindow",
];

pub(super) fn joined(values: &[Value]) -> Result<JsString> {
    let mut units = vec![];
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            units.push(58);
        }
        if !value.is_null() {
            units.extend(
                crate::wire::coercion::string(value)
                    .map_err(|()| anyhow::anyhow!("Invalid telemetry dimension"))?
                    .units(),
            );
        }
    }
    Ok(JsString::new(units))
}
pub(super) fn nullish(value: &Value, fallback: impl Datum) -> Value {
    if value.is_null() {
        fallback.datum()
    } else {
        value.clone()
    }
}
pub(super) fn locale_sort(rows: &mut [Value], key: &str, descending: bool) -> Result<()> {
    let collator = super::super::catalog_hash::collator()?;
    rows.sort_by(|a, b| {
        let order = collator.compare_utf16_icu4c(
            a[key].as_js_string().unwrap().units(),
            b[key].as_js_string().unwrap().units(),
        );
        if descending { order.reverse() } else { order }
    });
    Ok(())
}
fn total(attempts: &[&Value]) -> Value {
    let mut result = Value::object(TOTAL_KEYS.map(|key| {
        (
            key,
            if matches!(key, "visibleOutputTokens" | "reportedTotalTokens") {
                Value::Null
            } else {
                Value::Number(0.0)
            },
        )
    }));
    let (mut visible, mut reported) = (true, true);
    for row in attempts {
        for key in TOTAL_KEYS.into_iter().take(5) {
            result[key] = Value::Number(number(&result, key) + number(row, key));
        }
        // This helper groups the row's two token counters before adding. The
        // dashboard's totalTokens helper deliberately has a different order.
        result["comparableTokens"] = Value::Number(
            number(&result, "comparableTokens")
                + (number(row, "inputTokens") + number(row, "outputTokens")),
        );
        for (key, known) in [
            ("visibleOutputTokens", &mut visible),
            ("reportedTotalTokens", &mut reported),
        ] {
            if row[key].is_null() {
                *known = false;
            } else {
                result[key] = Value::Number(result[key].as_f64().unwrap_or(0.0) + number(row, key));
            }
        }
    }
    if !visible {
        result["visibleOutputTokens"] = Value::Null;
    }
    if !reported {
        result["reportedTotalTokens"] = Value::Null;
    }
    result
}
fn combine(left: &Value, right: &Value) -> Value {
    Value::object(TOTAL_KEYS.map(|key| {
        (
            key,
            if left[key].is_null() || right[key].is_null() {
                Value::Null
            } else {
                Value::Number(number(left, key) + number(right, key))
            },
        )
    }))
}
fn divide(total: &Value, divisor: f64) -> Value {
    Value::object(TOTAL_KEYS.map(|key| {
        (
            key,
            if total[key].is_null() {
                Value::Null
            } else {
                Value::Number(number(total, key) / divisor)
            },
        )
    }))
}
fn bucket(row: &Value) -> Result<JsString> {
    joined(&[
        row["providerId"].clone(),
        row["providerAccountId"].clone(),
        nullish(&row["limitId"], nullish(&row["limitName"], "unnamed")),
        row["windowKind"].clone(),
        nullish(&row["windowDurationMinutes"], "unknown-duration"),
    ])
}
fn reset_window(row: &Value) -> Result<JsString> {
    joined(&[
        Value::String(bucket(row)?),
        if row["resetsAt"].is_null() {
            text("unknown-reset")
        } else {
            text(iso(milliseconds(&row["resetsAt"]))?)
        },
    ])
}
fn attempts_between<'a>(
    attempts: &'a [Value],
    account: &Value,
    after: f64,
    through: f64,
) -> Vec<&'a Value> {
    attempts
        .iter()
        .filter(|row| {
            let time = ["finalizedAt", "completedAt", "startedAt"]
                .into_iter()
                .find_map(|key| (!row[key].is_null()).then(|| milliseconds(&row[key])))
                .unwrap_or(f64::NAN);
            row["providerAccountId"] == *account
                && row["attemptStatus"] != "running"
                && time > after
                && time <= through
        })
        .collect()
}
fn unique(attempts: &[&Value], key: &str) -> Vec<Value> {
    let mut values: IndexMap<JsString, ()> = IndexMap::new();
    for row in attempts {
        if let Some(value) = row[key].as_js_string() {
            values.insert(value.clone(), ());
        }
    }
    let mut values = values.into_keys().collect::<Vec<_>>();
    values.sort_by(|a, b| a.units().cmp(b.units()));
    values.into_iter().map(Value::String).collect()
}
fn confidence(attempts: &[&Value], tokens: &Value, lag: f64) -> (&'static str, Vec<&'static str>) {
    let mut reasons = vec![];
    if number(tokens, "comparableTokens") == 0.0 {
        reasons.push("meter-movement-without-tokens");
    }
    for (key, reason) in [
        ("modelId", "multiple-models"),
        ("reasoningEffort", "multiple-reasoning-efforts"),
        ("projectId", "multiple-projects"),
    ] {
        if unique(attempts, key).len() > 1 {
            reasons.push(reason);
        }
    }
    if lag > 5000.0 {
        reasons.push("delayed-observation");
    }
    if attempts
        .iter()
        .any(|row| row["attemptStatus"] != "completed")
    {
        reasons.push("non-completed-attempts");
    }
    (
        if number(tokens, "comparableTokens") == 0.0 {
            "low"
        } else if reasons.is_empty() {
            "high"
        } else {
            "medium"
        },
        reasons,
    )
}

fn week_key(time: f64) -> Result<String> {
    let (year, month, day) =
        crate::wire::date_utc_fields(time as i64).context("Invalid time value")?;
    let Some(target) = crate::wire::date_utc_milliseconds(year, month - 1, day) else {
        return Ok("NaN-WNaN".into());
    };
    let weekday = (target.div_euclid(86_400_000) + 4).rem_euclid(7);
    let thursday = target + (4 - if weekday == 0 { 7 } else { weekday }) * 86_400_000;
    let Some((year, _, _)) = crate::wire::date_utc_fields(thursday) else {
        return Ok("NaN-WNaN".into());
    };
    // setUTCDate does not reapply Date.UTC's 0..99 year adjustment.
    let week = crate::wire::date_utc_milliseconds(year, 0, 1).map_or(f64::NAN, |start| {
        (((thursday - start) as f64 / 86_400_000.0 + 1.0) / 7.0).ceil()
    });
    Ok(format!(
        "{year}-W{}",
        if week.is_nan() {
            "NaN".into()
        } else {
            format!("{week:02}")
        }
    ))
}
fn breakdown_keys(sample: &Value) -> Result<[Value; 9]> {
    let ended = milliseconds(&sample["toObservedAt"]);
    let ended_iso = iso(ended)?;
    let single = |key: &str, default: &str| {
        let values = sample[key].as_array().unwrap();
        if values.len() == 1 {
            values[0].clone()
        } else {
            text(default)
        }
    };
    Ok([
        sample["providerId"].clone(),
        sample["accountId"].clone(),
        single("modelIds", "mixed-or-unknown"),
        single("reasoningEfforts", "mixed-or-default"),
        single("projectIds", "mixed-or-none"),
        text(&ended_iso[..10]),
        text(week_key(ended)?),
        text(&ended_iso[..7]),
        sample["resetWindowKey"].clone(),
    ])
}
fn breakdowns(samples: &[Value]) -> Result<Value> {
    let keys = samples
        .iter()
        .map(breakdown_keys)
        .collect::<Result<Vec<_>>>()?;
    let mut result = Value::object([] as [(&str, Value); 0]);
    for (dimension_index, dimension) in DIMENSIONS.iter().enumerate() {
        let mut groups: IndexMap<JsString, Vec<&Value>> = IndexMap::new();
        for (sample, keys) in samples.iter().zip(&keys) {
            groups
                .entry(keys[dimension_index].as_js_string().unwrap().clone())
                .or_default()
                .push(sample);
        }
        let mut rows=groups.into_iter().map(|(key,entries)|{
            let totals=entries.iter().skip(1).fold(entries[0]["tokens"].clone(),|total,row|combine(&total,&row["tokens"]));
            let eligible=entries.iter().filter(|row|row["unattributed"]!=true).collect::<Vec<_>>();
            json!({"dimension":dimension,"key":key,"sampleCount":entries.len(),"highConfidenceSamples":entries.iter().filter(|row|row["confidence"]=="high").count(),"unattributedSamples":entries.iter().filter(|row|row["unattributed"]==true).count(),"totals":totals,"tokensPerPercent":quota_value_statistics(&eligible.iter().map(|row|number(&row["tokensPerPercent"],"comparableTokens")).collect::<Vec<_>>()),"effectiveTokensPer100Percent":quota_value_statistics(&eligible.iter().map(|row|number(row,"effectiveTokensPer100Percent")).collect::<Vec<_>>())})
        }).collect::<Vec<_>>();
        locale_sort(&mut rows, "key", false)?;
        result[*dimension] = Value::Array(rows);
    }
    Ok(result)
}
fn comparison(
    samples: &[Value],
    current_start: f64,
    current_end: f64,
    previous_start: f64,
) -> Value {
    let values = |from, through| {
        samples
            .iter()
            .filter(|row| {
                let time = milliseconds(&row["toObservedAt"]);
                row["unattributed"] != true && time > from && time <= through
            })
            .map(|row| number(row, "effectiveTokensPer100Percent"))
            .collect::<Vec<_>>()
    };
    let current = quota_value_statistics(&values(current_start, current_end));
    let previous = quota_value_statistics(&values(previous_start, current_start));
    let change = if current["median"].is_null()
        || previous["median"].is_null()
        || number(&previous, "median") == 0.0
    {
        Value::Null
    } else {
        Value::Number(
            ((number(&current, "median") - number(&previous, "median"))
                / number(&previous, "median"))
                * 100.0,
        )
    };
    json!({"current":current,"previous":previous,"changePercent":change})
}

pub fn derive(readings: &[Value], attempts: &[Value], now: f64) -> Result<Value> {
    let now = milliseconds(&Value::Number(now));
    let mut ordered = readings.to_vec();
    ordered.sort_by(|a, b| {
        (milliseconds(&a["observedAt"]) - milliseconds(&b["observedAt"]))
            .partial_cmp(&0.0)
            .unwrap_or(Ordering::Equal)
    });
    let mut groups: IndexMap<JsString, Vec<&Value>> = IndexMap::new();
    for row in &ordered {
        groups.entry(reset_window(row)?).or_default().push(row);
    }
    let (mut intervals, mut samples, mut pending) = (vec![], vec![], vec![]);
    for (reset_key, group) in groups {
        let mut anchor = group[0];
        let mut stationary = 0;
        for index in 1..group.len() {
            let (previous, current) = (group[index - 1], group[index]);
            let delta = number(current, "usedPercent") - number(previous, "usedPercent");
            let direct = attempts_between(
                attempts,
                &current["providerAccountId"],
                milliseconds(&previous["observedAt"]),
                milliseconds(&current["observedAt"]),
            );
            let kind = if delta < 0.0 {
                "rebaseline"
            } else if delta == 0.0 {
                "stationary"
            } else if direct.is_empty() {
                "unattributed-movement"
            } else {
                "movement"
            };
            intervals.push(json!({"accountId":current["providerAccountId"],"providerId":current["providerId"],"bucketKey":bucket(current)?,"resetWindowKey":reset_key,"fromReadingId":previous["id"],"toReadingId":current["id"],"fromObservedAt":iso(milliseconds(&previous["observedAt"]))?,"toObservedAt":iso(milliseconds(&current["observedAt"]))?,"usedPercentBefore":previous["usedPercent"],"usedPercentAfter":current["usedPercent"],"usedPercentDelta":delta,"kind":kind,"intervalTokens":total(&direct),"attemptCount":direct.len()}));
            if delta == 0.0 {
                stationary += 1;
                continue;
            }
            if delta < 0.0 {
                anchor = current;
                stationary = 0;
                continue;
            }
            let accumulated = attempts_between(
                attempts,
                &current["providerAccountId"],
                milliseconds(&anchor["observedAt"]),
                milliseconds(&current["observedAt"]),
            );
            let tokens = total(&accumulated);
            let lag = max_zero(
                milliseconds(&current["receivedAt"]) - milliseconds(&current["observedAt"]),
            );
            let (confidence, reasons) = confidence(&accumulated, &tokens, lag);
            let per_percent = divide(&tokens, delta);
            samples.push(json!({"accountId":current["providerAccountId"],"providerId":current["providerId"],"bucketKey":bucket(current)?,"resetWindowKey":reset_key,"fromObservedAt":iso(milliseconds(&anchor["observedAt"]))?,"toObservedAt":iso(milliseconds(&current["observedAt"]))?,"usedPercentDelta":delta,"stationaryReadingCount":stationary,"attemptCount":accumulated.len(),"tokens":tokens,"tokensPerPercent":per_percent,"effectiveTokensPer100Percent":number(&per_percent,"comparableTokens")*100.0,"modelIds":unique(&accumulated,"modelId"),"modelNames":unique(&accumulated,"modelName"),"reasoningEfforts":unique(&accumulated,"reasoningEffort"),"projectIds":unique(&accumulated,"projectId"),"observationLagMs":lag,"confidence":confidence,"confidenceReasons":reasons,"unattributed":number(&tokens,"comparableTokens")==0.0}));
            anchor = current;
            stationary = 0;
        }
        let last = group.last().unwrap();
        let attempts = attempts_between(
            attempts,
            &last["providerAccountId"],
            milliseconds(&anchor["observedAt"]),
            now,
        );
        let tokens = total(&attempts);
        if number(&tokens, "comparableTokens") > 0.0 {
            pending.push(json!({"accountId":last["providerAccountId"],"providerId":last["providerId"],"bucketKey":bucket(last)?,"resetWindowKey":reset_key,"sinceObservedAt":iso(milliseconds(&anchor["observedAt"]))?,"attemptCount":attempts.len(),"tokens":tokens}));
        }
    }
    let (year, month, _) =
        crate::wire::date_utc_fields(now as i64).context("Invalid time value")?;
    let month_start = |month| {
        crate::wire::date_utc_milliseconds(year, month, 1).map_or(f64::NAN, |time| time as f64)
    };
    let result = json!({"generatedAt":iso(now)?,"readings":ordered,"intervals":intervals,"movementSamples":samples,"pendingConsumption":pending,"breakdowns":breakdowns(&samples)?,"rolling7Days":comparison(&samples,now-7.0*86_400_000.0,now,now-14.0*86_400_000.0),"rolling30Days":comparison(&samples,now-30.0*86_400_000.0,now,now-60.0*86_400_000.0),"monthOverMonth":comparison(&samples,month_start(month-1),now,month_start(month-2))});
    // Date instances serialize as ISO strings in the source result.
    let mut result = result;
    let Value::Array(rows) = &mut result["readings"] else {
        unreachable!()
    };
    for row in rows {
        for key in ["observedAt", "receivedAt", "resetsAt"] {
            if !row[key].is_null() {
                row[key] = text(iso(milliseconds(&row[key]))?);
            }
        }
    }
    Ok(result)
}
