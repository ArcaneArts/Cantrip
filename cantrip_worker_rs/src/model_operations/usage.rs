use super::{MAX_SAFE_COUNT, count};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use std::time::Instant;

const METRICS: [&str; 6] = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
];

pub(super) fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Default)]
struct Counter {
    observed: Option<u64>,
    reported: usize,
    overflowed: bool,
}
impl Counter {
    fn add(&mut self, value: u64) {
        self.reported += 1;
        if !self.overflowed {
            self.observed = Some(self.observed.unwrap_or_default() + value)
                .filter(|sum| *sum <= MAX_SAFE_COUNT);
            self.overflowed = self.observed.is_none();
        }
    }
}

#[derive(Default)]
pub(super) struct Usage {
    metrics: [Counter; 6],
    total: Counter,
    start: Option<String>,
    duration: f64,
    succeeded: usize,
    failed: usize,
    cancelled: usize,
}

impl Usage {
    pub fn begin(&mut self) -> Instant {
        self.start.get_or_insert_with(timestamp);
        Instant::now()
    }

    pub fn end(&mut self, start: Instant, status: &str, counts: [Option<u64>; 6]) {
        self.duration += start.elapsed().as_secs_f64() * 1000.0;
        match status {
            "succeeded" => self.succeeded += 1,
            "cancelled" => self.cancelled += 1,
            _ => self.failed += 1,
        }
        let total = counts[2].or_else(|| {
            (counts[0].is_some() || counts[1].is_some())
                .then_some(counts[0].unwrap_or_default() + counts[1].unwrap_or_default())
        });
        if let Some(total) = total {
            self.total.add(total);
        }
        for (metric, value) in self.metrics.iter_mut().zip(counts) {
            if let Some(value) = value {
                metric.add(value);
            }
        }
    }

    pub fn receipt(&self, operation: &str, route: &Value, status: &str) -> Result<Value> {
        let metrics = Value::object(METRICS.into_iter().zip(self.metrics.iter().map(|metric| {
            json!({"observed":metric.observed,"reportedRequests":metric.reported,"overflowed":metric.overflowed})
        })));
        crate::http::checked(
            "modelOperationUsageSchema",
            &json!({
                "operation":operation,"modelId":route["modelId"],"routeId":route["routeId"],
                "providerId":route["provider"]["id"],"workerVersion":crate::version::value()["version"],
                "status":status,"requests":self.succeeded+self.failed+self.cancelled,
                "succeededRequests":self.succeeded,"failedRequests":self.failed,"cancelledRequests":self.cancelled,
                "startedAt":self.start,"completedAt":timestamp(),"durationMs":self.duration,
                "observedTotalTokens":self.total.observed,"observedTotalOverflowed":self.total.overflowed,
                "metrics":metrics,
            }),
        )
    }
}

pub(super) fn embedding_counts(raw: &Value) -> [&Value; 6] {
    let usage = &raw["usage"];
    use super::either;
    let input = either(
        &usage["input_tokens_details"],
        &usage["prompt_tokens_details"],
    );
    let output = either(
        &usage["output_tokens_details"],
        &usage["completion_tokens_details"],
    );
    [
        either(
            &usage["prompt_tokens"],
            either(
                &usage["input_tokens"],
                either(
                    &raw["prompt_eval_count"],
                    &raw["meta"]["billed_units"]["input_tokens"],
                ),
            ),
        ),
        either(&usage["output_tokens"], &usage["completion_tokens"]),
        either(&usage["total_tokens"], &raw["prompt_eval_count"]),
        &input["cached_tokens"],
        &input["cache_write_tokens"],
        &output["reasoning_tokens"],
    ]
}

pub(super) fn observed(counts: [&Value; 6]) -> [Option<u64>; 6] {
    counts.map(count)
}
