//! Source-compatible operational observations. Domain services own their actual
//! collectors; these counters observe HTTP/probes rather than admitting work.
mod prometheus;
#[cfg(test)]
mod tests;
use crate::wire::{Value, value::json};
use indexmap::IndexMap;
use std::sync::Mutex;

pub const LEGACY_ENDPOINTS: [&str; 6] = [
    "remote-surface-transport",
    "terminal-direct",
    "terminal-relay",
    "tunnel-direct",
    "tunnel-direct-activate",
    "tunnel-relay",
];

#[derive(Default)]
struct HttpMetric {
    requests: f64,
    duration_seconds: f64,
}
struct State {
    active_requests: f64,
    http: IndexMap<(String, u16), HttpMetric>,
    legacy: IndexMap<String, f64>,
    database: Value,
    scheduler: Value,
}
impl Default for State {
    fn default() -> Self {
        Self {
            active_requests: 0.0,
            http: IndexMap::new(),
            legacy: IndexMap::new(),
            database: json!({"ready":false,"latencySeconds":0,"probeFailures":0}),
            // The current Source exposes this recorder but has no production
            // call site. Do not invent scheduler observations in the port.
            scheduler: json!({"dispatchFailures":0,"dispatches":0,"dueOccurrences":0,"lastScanAt":Value::Null,"lastScanDurationSeconds":0,"leaseContentions":0,"leaseRecoveries":0,"maximumLagSeconds":0,"scanFailures":0,"scans":0}),
        }
    }
}
pub struct OperationalMetrics {
    started_at: i64,
    state: Mutex<State>,
}
impl Default for OperationalMetrics {
    fn default() -> Self {
        Self::new(crate::auth::now().timestamp_millis())
    }
}
impl OperationalMetrics {
    pub fn new(started_at: i64) -> Self {
        Self {
            started_at,
            state: Mutex::new(State::default()),
        }
    }
    pub fn begin_http(&self) {
        self.state.lock().unwrap().active_requests += 1.0;
    }
    /// The response observer invokes this once, preserving insertion order of
    /// method/status series and excluding an unfinished abandoned response.
    pub fn finish_http(&self, method: &str, status: u16, duration_ms: f64) {
        let mut state = self.state.lock().unwrap();
        state.active_requests = (state.active_requests - 1.0).max(0.0);
        let metric = state
            .http
            .entry((method.to_ascii_uppercase(), status / 100))
            .or_default();
        metric.requests += 1.0;
        metric.duration_seconds += duration_ms.max(0.0) / 1000.0;
    }
    pub fn database_probe(&self, ready: bool, duration_ms: f64) {
        let mut state = self.state.lock().unwrap();
        state.database["ready"] = json!(ready);
        state.database["latencySeconds"] = json!(duration_ms.max(0.0) / 1000.0);
        if !ready {
            let count = state.database["probeFailures"].as_f64().unwrap();
            state.database["probeFailures"] = json!(count + 1.0);
        }
    }
    pub fn legacy_request(&self, endpoint: &str) {
        *self
            .state
            .lock()
            .unwrap()
            .legacy
            .entry(endpoint.to_owned())
            .or_default() += 1.0;
    }
    pub fn scheduler_scan(&self, input: &Value, now: i64) {
        let mut state = self.state.lock().unwrap();
        for key in [
            "dispatchFailures",
            "dispatches",
            "dueOccurrences",
            "leaseContentions",
            "leaseRecoveries",
        ] {
            let next = state.scheduler[key].as_f64().unwrap()
                + input[key].as_f64().expect("scheduler observation counter");
            state.scheduler[key] = json!(next);
        }
        for (key, increment) in [
            ("scans", 1.0),
            (
                "scanFailures",
                if input["failed"] == true { 1.0 } else { 0.0 },
            ),
        ] {
            let next = state.scheduler[key].as_f64().unwrap() + increment;
            state.scheduler[key] = json!(next);
        }
        state.scheduler["lastScanAt"] = json!(
            chrono::DateTime::from_timestamp_millis(now)
                .expect("scheduler clock")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
        state.scheduler["lastScanDurationSeconds"] =
            json!(input["durationMs"].as_f64().unwrap().max(0.0) / 1000.0);
        state.scheduler["maximumLagSeconds"] = json!(
            state.scheduler["maximumLagSeconds"]
                .as_f64()
                .unwrap()
                .max(input["maximumLagMs"].as_f64().unwrap().max(0.0) / 1000.0)
        );
    }
    pub fn snapshot(&self) -> Value {
        self.snapshot_at(crate::auth::now().timestamp_millis())
    }
    pub fn snapshot_at(&self, now: i64) -> Value {
        let state = self.state.lock().unwrap();
        let legacy = LEGACY_ENDPOINTS
            .into_iter()
            .map(|endpoint| {
                (
                    endpoint.into(),
                    json!(state.legacy.get(endpoint).copied().unwrap_or(0.0)),
                )
            })
            .collect();
        json!({
            "database":state.database,
            "http":json!({"activeRequests":state.active_requests,"requestCount":state.http.values().map(|m| m.requests).sum::<f64>()}),
            "legacyFeatureTransports":json!({"requestsByEndpoint":Value::Object(legacy)}),
            "scheduler":state.scheduler,
            "uptimeSeconds":(now-self.started_at).max(0) as f64/1000.0
        })
    }
    pub fn render_prometheus(&self, input: &Value, transport: &super::TransportMetrics) -> String {
        self.render_at(input, transport, crate::auth::now().timestamp_millis())
    }
    pub fn render_at(
        &self,
        input: &Value,
        transport: &super::TransportMetrics,
        now: i64,
    ) -> String {
        prometheus::render(self, input, transport, now)
    }
}
