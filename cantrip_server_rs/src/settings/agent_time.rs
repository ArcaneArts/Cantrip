use crate::wire::JsString;
use indexmap::IndexMap;
use serde::Serialize;

const MAX_OPEN_INTERVAL_MS: f64 = 86_400_000.0;

#[derive(Clone, Debug)]
pub struct Interval {
    pub attempt_status: String,
    pub started_at: Option<f64>,
    pub completed_at: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub active_agent_count: usize,
    pub agent_time_ms: f64,
    pub wall_time_ms: f64,
    pub average_concurrency: f64,
}

fn normalized(interval: &Interval, now: f64) -> Option<(f64, f64, bool)> {
    let start = interval.started_at?;
    if !start.is_finite() || start > now {
        return None;
    }
    let open = interval.attempt_status == "running" && interval.completed_at.is_none();
    let active = open && now - start <= MAX_OPEN_INTERVAL_MS;
    let end = if open {
        // f64::min discards NaN, whereas Math.min propagates it.
        if now.is_nan() {
            f64::NAN
        } else {
            now.min(start + MAX_OPEN_INTERVAL_MS)
        }
    } else {
        interval.completed_at?
    };
    (end.is_finite() && end > start).then_some((start, end, active))
}

pub fn summarize(intervals: &[Interval], now: f64) -> Summary {
    let mut intervals: Vec<_> = intervals
        .iter()
        .filter_map(|v| normalized(v, now))
        .collect();
    intervals.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut summary = Summary::default();
    let mut merged: Option<(f64, f64)> = None;
    for (start, end, active) in intervals {
        summary.active_agent_count += usize::from(active);
        summary.agent_time_ms += end - start;
        match merged.as_mut() {
            Some((_, merged_end)) if start <= *merged_end => *merged_end = merged_end.max(end),
            Some((merged_start, merged_end)) => {
                summary.wall_time_ms += *merged_end - *merged_start;
                merged = Some((start, end));
            }
            None => merged = Some((start, end)),
        }
    }
    if let Some((start, end)) = merged {
        summary.wall_time_ms += end - start;
    }
    // Dates contain integral milliseconds. Round the ratio before rounding the
    // totals, matching the source's evaluation order and Math.round for >= 0.
    summary.average_concurrency = if summary.wall_time_ms > 0.0 {
        let value = (summary.agent_time_ms / summary.wall_time_ms) * 100.0;
        js_round(value) / 100.0
    } else {
        0.0
    };
    summary.agent_time_ms = js_round(summary.agent_time_ms);
    summary.wall_time_ms = js_round(summary.wall_time_ms);
    summary
}

fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

pub fn group<'a>(
    intervals: impl IntoIterator<Item = (&'a Interval, Option<&'a JsString>)>,
    now: f64,
) -> IndexMap<JsString, Summary> {
    let mut groups: IndexMap<JsString, Vec<Interval>> = IndexMap::new();
    for (interval, key) in intervals {
        if let Some(key) = key.filter(|key| !key.is_empty()) {
            groups
                .entry(key.clone())
                .or_default()
                .push(interval.clone());
        }
    }
    groups
        .into_iter()
        .map(|(key, rows)| (key, summarize(&rows, now)))
        .collect()
}
