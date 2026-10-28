//! Change-point detection over attributed quota and terminal behavior records.
use super::{
    iso, milliseconds, number, object,
    quota::{joined, locale_sort, nullish},
    text,
};
use crate::wire::{JsString, Value, coercion::truthy};
use anyhow::Result;
use indexmap::IndexMap;
use std::{cmp::Ordering, sync::OnceLock};

struct Spec {
    metric: &'static str,
    unit: &'static str,
    minimum: usize,
    high: usize,
    relative: f64,
    absolute: f64,
    median: bool,
    increased: &'static str,
}
const SPECS: [Spec; 8] = [
    Spec {
        metric: "tokens-per-percent",
        unit: "tokens",
        minimum: 5,
        high: 10,
        relative: 0.25,
        absolute: 0.0,
        median: true,
        increased: "improvement",
    },
    Spec {
        metric: "effective-weekly-allowance",
        unit: "tokens",
        minimum: 5,
        high: 10,
        relative: 0.25,
        absolute: 0.0,
        median: true,
        increased: "improvement",
    },
    Spec {
        metric: "failure-rate",
        unit: "ratio",
        minimum: 8,
        high: 16,
        relative: 0.4,
        absolute: 0.1,
        median: false,
        increased: "degradation",
    },
    Spec {
        metric: "tool-error-rate",
        unit: "ratio",
        minimum: 8,
        high: 16,
        relative: 0.4,
        absolute: 0.1,
        median: false,
        increased: "degradation",
    },
    Spec {
        metric: "latency",
        unit: "milliseconds",
        minimum: 8,
        high: 16,
        relative: 0.3,
        absolute: 500.0,
        median: true,
        increased: "degradation",
    },
    Spec {
        metric: "compaction-frequency",
        unit: "ratio",
        minimum: 8,
        high: 16,
        relative: 0.5,
        absolute: 0.12,
        median: false,
        increased: "degradation",
    },
    Spec {
        metric: "completion-rate",
        unit: "ratio",
        minimum: 8,
        high: 16,
        relative: 0.25,
        absolute: 0.1,
        median: false,
        increased: "improvement",
    },
    Spec {
        metric: "output-reasoning-mix",
        unit: "ratio",
        minimum: 8,
        high: 16,
        relative: 0.35,
        absolute: 0.12,
        median: true,
        increased: "neutral",
    },
];
#[derive(Clone, Copy)]
struct Point {
    at: f64,
    value: f64,
    reliable: bool,
}
fn aggregate(points: &[Point], median: bool) -> f64 {
    if !median {
        return points.iter().fold(0.0, |sum, p| sum + p.value) / points.len() as f64;
    }
    let mut values = points.iter().map(|p| p.value).collect::<Vec<_>>();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let middle = values.len() / 2;
    // This metric median uses (a+b)/2, unlike quota's interpolated quantile.
    if values.len() % 2 == 1 {
        values[middle]
    } else {
        (values[middle - 1] + values[middle]) / 2.0
    }
}
struct Candidate {
    split: usize,
    before_start: usize,
    after_end: usize,
    before: f64,
    after: f64,
    strength: f64,
    score: f64,
}
fn detect_one(identity: &Value, mut points: Vec<Point>, spec: &Spec) -> Result<Option<Value>> {
    points.retain(|p| p.value.is_finite());
    points.sort_by(|a, b| (a.at - b.at).partial_cmp(&0.0).unwrap_or(Ordering::Equal));
    if points.len() < spec.minimum * 2 {
        return Ok(None);
    }
    let mut best: Option<Candidate> = None;
    for split in spec.minimum..=points.len() - spec.minimum {
        let start = split.saturating_sub(40);
        let end = points.len().min(split + 40);
        let (before, after) = (&points[start..split], &points[split..end]);
        let before_value = aggregate(before, spec.median);
        let after_value = aggregate(after, spec.median);
        let delta = (after_value - before_value).abs();
        let relative = if before_value.abs() < f64::EPSILON {
            if after_value == 0.0 {
                0.0
            } else {
                f64::INFINITY
            }
        } else {
            delta / before_value.abs()
        };
        if !(delta >= spec.absolute && relative >= spec.relative) {
            continue;
        }
        let relative_strength = if relative.is_finite() {
            relative / spec.relative
        } else {
            2.0
        };
        let absolute_strength = if spec.absolute != 0.0 {
            delta / spec.absolute
        } else {
            relative_strength
        };
        let balance = before.len().min(after.len()) as f64 / before.len().max(after.len()) as f64;
        let reliability = points[start..end].iter().filter(|p| p.reliable).count() as f64
            / (before.len() + after.len()) as f64;
        let strength = relative_strength.min(absolute_strength);
        let score = strength * balance * (0.75 + reliability * 0.25);
        if best.as_ref().is_none_or(|best| score > best.score) {
            best = Some(Candidate {
                split,
                before_start: start,
                after_end: end,
                before: before_value,
                after: after_value,
                strength,
                score,
            });
        }
    }
    let Some(best) = best else { return Ok(None) };
    let before_count = best.split - best.before_start;
    let after_count = best.after_end - best.split;
    let reliable = points[best.before_start..best.after_end]
        .iter()
        .filter(|p| p.reliable)
        .count() as f64
        / (before_count + after_count) as f64;
    let confidence =
        if before_count.min(after_count) >= spec.high && best.strength >= 1.5 && reliable >= 0.75 {
            "high"
        } else {
            "medium"
        };
    let increased = best.after >= best.before;
    let impact = if increased || spec.increased == "neutral" {
        spec.increased
    } else if spec.increased == "improvement" {
        "degradation"
    } else {
        "improvement"
    };
    let detected = iso(points[best.split].at)?;
    let scope_parts = [
        identity["providerAccountId"].clone(),
        identity["modelId"].clone(),
    ]
    .into_iter()
    .filter(|v| truthy(Some(v)))
    .collect::<Vec<_>>();
    let id = joined(&[
        text(spec.metric),
        identity["scope"].clone(),
        Value::String(joined(&scope_parts)?),
        text(detected.clone()),
    ])?;
    let relative = if best.before.abs() < f64::EPSILON {
        if best.after == 0.0 {
            Value::Number(0.0)
        } else {
            Value::Null
        }
    } else {
        Value::Number(((best.after - best.before) / best.before.abs()) * 100.0)
    };
    Ok(Some(
        object!({"id":id,"metric":spec.metric,"scope":identity["scope"],"providerAccountId":identity["providerAccountId"],"modelId":identity["modelId"],"detectedAt":detected,"beforeStart":iso(points[best.before_start].at)?,"beforeEnd":iso(points[best.split-1].at)?,"afterStart":iso(points[best.split].at)?,"afterEnd":iso(points[best.after_end-1].at)?,"beforeValue":best.before,"afterValue":best.after,"relativeChangePercent":relative,"beforeSampleCount":before_count,"afterSampleCount":after_count,"confidence":confidence,"direction":if increased{"increased"}else{"decreased"},"impact":impact,"unit":spec.unit}),
    ))
}
struct Group<'a> {
    identity: Value,
    rows: Vec<&'a Value>,
}
fn groups<'a>(
    rows: impl Iterator<Item = &'a Value>,
    account_for: impl Fn(&Value) -> Value,
    model_for: impl Fn(&Value) -> Value,
) -> Result<Vec<Group<'a>>> {
    let mut groups: IndexMap<JsString, Group<'a>> = IndexMap::new();
    for row in rows {
        let account = account_for(row);
        let model = model_for(row);
        let has_account = truthy(Some(&account));
        let has_model = truthy(Some(&model));
        for (scope, account, model, enabled) in [
            ("account", account.clone(), Value::Null, has_account),
            ("model", Value::Null, model.clone(), has_model),
            ("account-model", account, model, has_account && has_model),
        ] {
            if !enabled {
                continue;
            }
            let key = joined(&[text(scope), nullish(&account, ""), nullish(&model, "")])?;
            groups
                .entry(key)
                .or_insert_with(|| Group {
                    identity: object!({"scope":scope,"providerAccountId":account,"modelId":model}),
                    rows: vec![],
                })
                .rows
                .push(row);
        }
    }
    Ok(groups.into_values().collect())
}
fn behavior_points(rows: &[&Value], metric: &str) -> Vec<Point> {
    rows.iter()
        .filter_map(|row| {
            if row["attemptStatus"] == "running" {
                return None;
            }
            let value = match metric {
                "failure-rate" => {
                    if row["attemptStatus"] == "failed" {
                        1.0
                    } else {
                        0.0
                    }
                }
                "tool-error-rate" => {
                    if truthy(row.get("toolCallCount")) {
                        number(row, "invalidToolCallCount") / number(row, "toolCallCount")
                    } else {
                        f64::NAN
                    }
                }
                "latency" => number(row, "durationMs"),
                "compaction-frequency" => number(row, "compactionCount"),
                "completion-rate" => {
                    if row["attemptStatus"] == "completed" {
                        1.0
                    } else {
                        0.0
                    }
                }
                "output-reasoning-mix" => {
                    if truthy(row.get("outputTokens")) {
                        number(row, "reasoningOutputTokens") / number(row, "outputTokens")
                    } else {
                        f64::NAN
                    }
                }
                _ => f64::NAN,
            };
            value.is_finite().then(|| Point {
                at: milliseconds(&row["startedAt"]),
                value,
                reliable: true,
            })
        })
        .collect()
}
pub fn detect(quota_samples: &[Value], behavior_rows: &[Value]) -> Result<Value> {
    let mut changes = vec![];
    static WEEKLY: OnceLock<regress::Regex> = OnceLock::new();
    let weekly = WEEKLY.get_or_init(|| {
        regress::Regex::with_flags("(^|:)(weekly|week|7d|10080)(:|$)", "iu").unwrap()
    });
    for group in groups(
        quota_samples
            .iter()
            .filter(|row| !truthy(row.get("unattributed"))),
        |row| row["accountId"].clone(),
        |row| {
            let ids = row["modelIds"].as_array().unwrap();
            if ids.len() == 1 {
                ids[0].clone()
            } else {
                Value::Null
            }
        },
    )? {
        for (index, spec) in SPECS.iter().take(2).enumerate() {
            let points = group
                .rows
                .iter()
                .filter(|row| {
                    index == 0
                        || weekly
                            .find_from_utf16(row["bucketKey"].as_js_string().unwrap().units(), 0)
                            .next()
                            .is_some()
                })
                .map(|row| Point {
                    at: milliseconds(&row["toObservedAt"]),
                    value: if index == 0 {
                        number(&row["tokensPerPercent"], "comparableTokens")
                    } else {
                        number(row, "effectiveTokensPer100Percent")
                    },
                    reliable: row["confidence"] == "high",
                })
                .collect();
            if let Some(change) = detect_one(&group.identity, points, spec)? {
                changes.push(change);
            }
        }
    }
    for group in groups(
        behavior_rows.iter(),
        |row| row["providerAccountId"].clone(),
        |row| row["modelId"].clone(),
    )? {
        for spec in &SPECS[2..] {
            if let Some(change) = detect_one(
                &group.identity,
                behavior_points(&group.rows, spec.metric),
                spec,
            )? {
                changes.push(change);
            }
        }
    }
    // Stable sorting retains metric and group insertion order for equal dates.
    locale_sort(&mut changes, "detectedAt", true)?;
    changes.sort_by_key(|row| if row["confidence"] == "high" { 0 } else { 1 });
    changes.truncate(100);
    Ok(Value::Array(changes))
}
