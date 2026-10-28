use super::{max_zero, milliseconds, number};
use crate::wire::{JsString, Value};
use anyhow::{Context, Result};
use indexmap::IndexMap;

pub fn quota_value_statistics(values: &[f64]) -> Value {
    let mut sorted = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap());
    let quantile = |fraction: f64| {
        if sorted.is_empty() {
            return Value::Null;
        }
        if sorted.len() == 1 {
            return Value::Number(sorted[0]);
        }
        let position = (sorted.len() - 1) as f64 * fraction;
        let lower = position.floor() as usize;
        let upper = position.ceil() as usize;
        Value::Number(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower as f64))
    };
    Value::object([
        ("sampleCount", Value::Number(sorted.len() as f64)),
        (
            "mean",
            if sorted.is_empty() {
                Value::Null
            } else {
                Value::Number(
                    sorted.iter().fold(0.0, |sum, value| sum + value) / sorted.len() as f64,
                )
            },
        ),
        ("median", quantile(0.5)),
        (
            "min",
            sorted
                .first()
                .map_or(Value::Null, |value| Value::Number(*value)),
        ),
        ("p10", quantile(0.1)),
        ("p25", quantile(0.25)),
        ("p75", quantile(0.75)),
        ("p90", quantile(0.9)),
        (
            "max",
            sorted
                .last()
                .map_or(Value::Null, |value| Value::Number(*value)),
        ),
    ])
}
pub fn sum_detailed_token_usage(rows: &[Value]) -> Value {
    let mut total = Value::object([
        ("inputTokens", Value::Number(0.0)),
        ("cachedInputTokens", Value::Number(0.0)),
        ("cacheWriteInputTokens", Value::Number(0.0)),
        ("outputTokens", Value::Number(0.0)),
        ("reasoningOutputTokens", Value::Number(0.0)),
        ("totalTokens", Value::Number(0.0)),
    ]);
    for row in rows {
        for key in [
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
            "reasoningOutputTokens",
        ] {
            total[key] = Value::Number(number(&total, key) + number(row, key));
        }
        // Preserve the source's two successive additions, including f64 loss
        // of precision; summing each row first is observably different.
        total["totalTokens"] = Value::Number(
            number(&total, "totalTokens")
                + number(row, "inputTokens")
                + number(row, "outputTokens"),
        );
    }
    total
}
pub fn summarize_model_behavior(rows: &[Value]) -> Value {
    let terminal = rows
        .iter()
        .filter(|row| row["attemptStatus"] != "running")
        .collect::<Vec<_>>();
    let count = |status: &str| {
        terminal
            .iter()
            .filter(|row| row["attemptStatus"] == status)
            .count() as f64
    };
    let completed = count("completed");
    let sum = |key: &str| rows.iter().fold(0.0, |sum, row| sum + number(row, key));
    let tool_calls = sum("toolCallCount");
    let invalid_tools = sum("invalidToolCallCount");
    let fraction = |value: f64| {
        if terminal.is_empty() {
            Value::Null
        } else {
            Value::Number(value / terminal.len() as f64)
        }
    };
    let mut result = Value::object([
        ("attemptCount", Value::Number(rows.len() as f64)),
        ("completedCount", Value::Number(completed)),
        ("failedCount", Value::Number(count("failed"))),
        (
            "interruptedCount",
            Value::Number(count("cancelled") + count("interrupted")),
        ),
        ("completionRate", fraction(completed)),
        (
            "finalAnswerRate",
            fraction(
                terminal
                    .iter()
                    .filter(|row| crate::wire::coercion::truthy(row.get("finalAnswerAppeared")))
                    .count() as f64,
            ),
        ),
        ("toolCallCount", Value::Number(tool_calls)),
        ("invalidToolCallCount", Value::Number(invalid_tools)),
        (
            "toolErrorRate",
            if tool_calls == 0.0 || tool_calls.is_nan() {
                Value::Null
            } else {
                Value::Number(invalid_tools / tool_calls)
            },
        ),
    ]);
    for key in [
        "retryFailoverCount",
        "compactionCount",
        "approvalRequestCount",
        "filesChangedCount",
        "testCommandCount",
        "testFailureCount",
    ] {
        result[key] = Value::Number(sum(key));
    }
    result["immediateCorrectiveFollowupCount"] = Value::Number(
        rows.iter()
            .filter(|row| crate::wire::coercion::truthy(row.get("immediateCorrectiveFollowup")))
            .count() as f64,
    );
    result["durationMs"] = quota_value_statistics(
        &rows
            .iter()
            .filter(|row| !row["durationMs"].is_null())
            .map(|row| number(row, "durationMs"))
            .collect::<Vec<_>>(),
    );
    for (source, target) in [
        ("firstActivityAt", "timeToFirstActivityMs"),
        ("firstVisibleResponseAt", "timeToVisibleResponseMs"),
    ] {
        result[target] = quota_value_statistics(
            &rows
                .iter()
                .filter(|row| !row[source].is_null())
                .map(|row| max_zero(milliseconds(&row[source]) - milliseconds(&row["startedAt"])))
                .collect::<Vec<_>>(),
        );
    }
    result
}
pub fn group_model_behavior(
    rows: &[Value],
    key: impl Fn(&Value) -> JsString,
) -> Vec<(JsString, Value)> {
    let mut groups: IndexMap<JsString, Vec<Value>> = IndexMap::new();
    for row in rows {
        groups.entry(key(row)).or_default().push(row.clone());
    }
    groups
        .into_iter()
        .map(|(key, rows)| (key, summarize_model_behavior(&rows)))
        .collect()
}
pub fn sample_quota_history(readings: &[Value], maximum: f64) -> Result<Vec<Value>> {
    if maximum <= 0.0 || readings.is_empty() {
        return Ok(vec![]);
    }
    let mut groups: IndexMap<JsString, Vec<usize>> = IndexMap::new();
    for (index, row) in readings.iter().enumerate() {
        groups
            .entry(
                row["providerAccountId"]
                    .as_js_string()
                    .context("quota history account ID")?
                    .clone(),
            )
            .or_default()
            .push(index);
    }
    let mut selected = vec![false; readings.len()];
    for entries in groups.values() {
        if entries.len() as f64 <= maximum {
            for index in entries {
                selected[*index] = true;
            }
        } else if maximum == 1.0 {
            selected[*entries.last().unwrap()] = true;
        } else {
            let mut index = 0;
            while (index as f64) < maximum {
                let position = super::super::round_nonnegative(
                    (index * (entries.len() - 1)) as f64 / (maximum - 1.0),
                );
                if position >= 0.0
                    && let Some(entry) = entries.get(position as usize)
                {
                    selected[*entry] = true;
                }
                index += 1;
            }
        }
    }
    Ok(readings
        .iter()
        .zip(selected)
        .filter(|(_, keep)| *keep)
        .map(|(row, _)| row.clone())
        .collect())
}
