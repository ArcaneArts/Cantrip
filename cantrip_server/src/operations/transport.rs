use crate::wire::Value;
use indexmap::IndexMap;
use std::sync::Mutex;
#[derive(Default)]
struct State {
    direct_bytes: IndexMap<(String, String), f64>,
    direct_connections: IndexMap<(String, String), f64>,
    link_bytes: IndexMap<(String, String, String), f64>,
    link_events: IndexMap<(String, String, String, String), f64>,
    latency: IndexMap<String, (f64, f64)>,
}
#[derive(Default)]
pub struct TransportMetrics(Mutex<State>);
fn number(v: &Value, key: &str) -> f64 {
    v[key].as_f64().expect("Validated transport measurement")
}
fn optional(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("none").to_owned()
}
fn add<K: Eq + std::hash::Hash>(map: &mut IndexMap<K, f64>, key: K, value: f64) {
    *map.entry(key).or_default() += value;
}
fn line(name: &str, value: f64, labels: &[(&str, &str)]) -> String {
    let labels = labels
        .iter()
        .map(|(k, v)| {
            format!(
                "{k}=\"{}\"",
                v.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\n', "\\n")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let suffix = if labels.is_empty() {
        String::new()
    } else {
        format!("{{{labels}}}")
    };
    format!(
        "{name}{suffix} {}",
        Value::Number(if value.is_finite() { value } else { 0.0 }).stringify()
    )
}
impl TransportMetrics {
    pub fn direct(&self, kind: &str, delta: &Value) {
        let mut state = self.0.lock().unwrap();
        for (direction, field) in [
            ("source_to_destination", "bytesFromLocal"),
            ("destination_to_source", "bytesToLocal"),
        ] {
            add(
                &mut state.direct_bytes,
                (kind.into(), direction.into()),
                number(delta, field),
            );
        }
        for (event, field) in [
            ("opened", "connectionsOpened"),
            ("closed", "connectionsClosed"),
        ] {
            add(
                &mut state.direct_connections,
                (kind.into(), event.into()),
                number(delta, field),
            );
        }
    }
    pub fn worker_link(&self, samples: &Value) {
        let mut state = self.0.lock().unwrap();
        for sample in samples.as_array().expect("Validated WorkerLink samples") {
            let route = optional(sample, "route");
            let lane = optional(sample, "lane");
            let event = sample["event"].as_str().unwrap();
            let value = number(sample, "value");
            if event == "bytes-sent" || event == "bytes-received" {
                add(
                    &mut state.link_bytes,
                    (
                        if event == "bytes-sent" {
                            "client_to_worker"
                        } else {
                            "worker_to_client"
                        }
                        .into(),
                        route.clone(),
                        lane,
                    ),
                    value,
                );
            } else {
                add(
                    &mut state.link_events,
                    (
                        event.into(),
                        route.clone(),
                        lane,
                        sample["reason"].as_str().unwrap().into(),
                    ),
                    value,
                );
            }
            if event == "route-selected" && !sample["latencyMs"].is_null() {
                let metric = state.latency.entry(route).or_default();
                metric.0 += 1.0;
                metric.1 += number(sample, "latencyMs") / 1000.0;
            }
        }
    }
    /// Transport series compose with the remaining operational collectors.
    pub fn prometheus_series(&self) -> Vec<String> {
        let state = self.0.lock().unwrap();
        let mut lines = Vec::new();
        for ((kind, direction), value) in &state.direct_bytes {
            lines.push(line(
                "cantrip_data_plane_bytes_total",
                *value,
                &[
                    ("direction", direction),
                    ("resource_kind", kind),
                    ("transport", "local-direct"),
                ],
            ));
        }
        for ((kind, event), value) in &state.direct_connections {
            lines.push(line(
                "cantrip_data_plane_connections_total",
                *value,
                &[
                    ("event", event),
                    ("resource_kind", kind),
                    ("transport", "local-direct"),
                ],
            ));
        }
        for ((event, route, lane, reason), value) in &state.link_events {
            lines.push(line(
                "cantrip_worker_link_events_total",
                *value,
                &[
                    ("event", event),
                    ("route", route),
                    ("lane", lane),
                    ("reason", reason),
                ],
            ));
        }
        for ((direction, route, lane), value) in &state.link_bytes {
            lines.push(line(
                "cantrip_worker_link_bytes_total",
                *value,
                &[("direction", direction), ("route", route), ("lane", lane)],
            ));
        }
        for (route, (count, sum)) in &state.latency {
            lines.push(line(
                "cantrip_worker_link_route_latency_seconds_sum",
                *sum,
                &[("route", route)],
            ));
            lines.push(line(
                "cantrip_worker_link_route_latency_seconds_count",
                *count,
                &[("route", route)],
            ));
        }
        lines
    }
}
