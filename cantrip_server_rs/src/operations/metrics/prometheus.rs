use super::*;
use num_bigint::BigInt;

fn line(name: &str, value: &Value, labels: &[(&str, &str)]) -> String {
    let suffix = if labels.is_empty() {
        String::new()
    } else {
        format!(
            "{{{}}}",
            labels
                .iter()
                .map(|(key, value)| format!(
                    "{key}=\"{}\"",
                    value
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"")
                        .replace('\n', "\\n")
                ))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    // BigInt usage counters arrive as their decimal representation. Keep them
    // exact; converting them through f64 would silently lose accounting bytes.
    let value = match value {
        Value::String(value) => value.as_str().expect("decimal usage counter").to_owned(),
        Value::Number(value) if value.is_finite() => Value::Number(*value).stringify(),
        _ => "0".to_owned(),
    };
    format!("{name}{suffix} {value}")
}
fn num(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
fn integer(value: &Value) -> BigInt {
    value
        .as_str()
        .expect("decimal usage counter")
        .parse()
        .expect("valid usage counter")
}
fn seconds_since(value: &Value, now: i64) -> Value {
    let elapsed = value
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map_or(0, |v| (now - v.timestamp_millis()).max(0));
    json!(elapsed as f64 / 1000.0)
}
fn append_transport(lines: &mut Vec<String>, series: &[String], prefix: &str) {
    lines.extend(series.iter().filter(|v| v.starts_with(prefix)).cloned());
}

pub(super) fn render(
    metrics: &OperationalMetrics,
    input: &Value,
    transport: &crate::operations::TransportMetrics,
    now: i64,
) -> String {
    let state = metrics.state.lock().unwrap();
    let mut lines = vec![
        "# HELP cantrip_process_uptime_seconds Server process uptime.".to_owned(),
        "# TYPE cantrip_process_uptime_seconds gauge".to_owned(),
        line(
            "cantrip_process_uptime_seconds",
            &json!((now - metrics.started_at) as f64 / 1000.0),
            &[],
        ),
        "# HELP cantrip_http_active_requests Requests currently executing.".to_owned(),
        "# TYPE cantrip_http_active_requests gauge".to_owned(),
        line(
            "cantrip_http_active_requests",
            &json!(state.active_requests),
            &[],
        ),
    ];
    for ((method, class), metric) in &state.http {
        let class = format!("{class}xx");
        let labels = [
            ("method", method.as_str()),
            ("status_class", class.as_str()),
        ];
        lines.push(line(
            "cantrip_http_requests_total",
            &json!(metric.requests),
            &labels,
        ));
        lines.push(line(
            "cantrip_http_request_duration_seconds_sum",
            &json!(metric.duration_seconds),
            &labels,
        ));
    }
    lines.push("# HELP cantrip_legacy_feature_transport_requests_total Requests to deprecated feature-owned direct or relay endpoints.".to_owned());
    lines.push("# TYPE cantrip_legacy_feature_transport_requests_total counter".to_owned());
    for endpoint in LEGACY_ENDPOINTS {
        lines.push(line(
            "cantrip_legacy_feature_transport_requests_total",
            &json!(state.legacy.get(endpoint).copied().unwrap_or(0.0)),
            &[("endpoint", endpoint)],
        ));
    }
    let tunnels = &input["tunnels"];
    lines.push("# HELP cantrip_data_plane_bytes_total Bytes carried by direct or server-relayed tunnel data planes.".to_owned());
    lines.push("# TYPE cantrip_data_plane_bytes_total counter".to_owned());
    for (direction, key) in [
        ("source_to_destination", "bytesFromSource"),
        ("destination_to_source", "bytesToSource"),
    ] {
        lines.push(line(
            "cantrip_data_plane_bytes_total",
            &tunnels[key],
            &[
                ("direction", direction),
                ("resource_kind", "tunnel"),
                ("transport", "server-relay"),
            ],
        ));
    }
    lines.push("# HELP cantrip_data_plane_connections_total Connections opened or closed by direct or server-relayed tunnel data planes.".to_owned());
    lines.push("# TYPE cantrip_data_plane_connections_total counter".to_owned());
    for (event, key) in [
        ("opened", "openedConnections"),
        ("closed", "closedConnections"),
    ] {
        lines.push(line(
            "cantrip_data_plane_connections_total",
            &tunnels[key],
            &[
                ("event", event),
                ("resource_kind", "tunnel"),
                ("transport", "server-relay"),
            ],
        ));
    }
    let transport = transport.prometheus_series();
    append_transport(&mut lines, &transport, "cantrip_data_plane_");
    lines.push("# HELP cantrip_worker_link_events_total WorkerLink lifecycle, route, fallback, reconnect, rejection, revocation, and pressure events.".to_owned());
    lines.push("# TYPE cantrip_worker_link_events_total counter".to_owned());
    append_transport(&mut lines, &transport, "cantrip_worker_link_events_");
    lines.push(
        "# HELP cantrip_worker_link_bytes_total Payload bytes carried by WorkerLink.".to_owned(),
    );
    lines.push("# TYPE cantrip_worker_link_bytes_total counter".to_owned());
    append_transport(&mut lines, &transport, "cantrip_worker_link_bytes_");
    lines.push(
        "# HELP cantrip_worker_link_route_latency_seconds WorkerLink carrier selection latency."
            .to_owned(),
    );
    lines.push("# TYPE cantrip_worker_link_route_latency_seconds summary".to_owned());
    append_transport(&mut lines, &transport, "cantrip_worker_link_route_latency_");
    if let Some(usage) = input.get("accountUsage") {
        let (storage, maintenance, meter) = (
            &usage["storageReconciliation"],
            &usage["historyMaintenance"],
            &usage["bandwidthMeter"],
        );
        let totals = &maintenance["totals"];
        let physical = &totals["physicalDatabaseBytes"];
        for (name, help, collector) in [(
            "cantrip_account_usage_storage_reconciliations_total",
            "Storage projection reconciliation outcomes.",
            storage,
        )] {
            lines.push(format!("# HELP {name} {help}"));
            lines.push(format!("# TYPE {name} counter"));
            for (outcome, key) in [
                ("completed", "completionCount"),
                ("failed", "failureCount"),
                ("lease_unavailable", "leaseContentionCount"),
            ] {
                lines.push(line(name, &collector[key], &[("outcome", outcome)]));
            }
        }
        lines.push(line(
            "cantrip_account_usage_storage_reconciliation_duration_seconds",
            &json!(num(&storage["lastDurationMs"]) / 1000.0),
            &[],
        ));
        lines.push(line(
            "cantrip_account_usage_storage_reconciliation_seconds_since_success",
            &seconds_since(&storage["lastSuccessfulAt"], now),
            &[],
        ));
        for (name, key) in [
            ("accounts", "accountCount"),
            ("categories", "categoryCount"),
            ("logical_bytes", "logicalBytes"),
            ("rows", "rowCount"),
        ] {
            lines.push(line(
                &format!("cantrip_account_usage_storage_reconciliation_{name}"),
                &storage["lastResult"][key],
                &[],
            ));
        }
        lines.push("# HELP cantrip_account_usage_bandwidth_buffered_bytes Bandwidth bytes waiting for a durable flush.".to_owned());
        lines.push("# TYPE cantrip_account_usage_bandwidth_buffered_bytes gauge".to_owned());
        lines.push(line(
            "cantrip_account_usage_bandwidth_buffered_bytes",
            &meter["bufferedBytes"],
            &[],
        ));
        lines.push(line(
            "cantrip_account_usage_bandwidth_buffered_entries",
            &meter["bufferedEntries"],
            &[],
        ));
        for (outcome, key) in [("completed", "flushCount"), ("failed", "flushFailureCount")] {
            lines.push(line(
                "cantrip_account_usage_bandwidth_flushes_total",
                &meter[key],
                &[("outcome", outcome)],
            ));
        }
        lines.push(line(
            "cantrip_account_usage_bandwidth_flush_duration_seconds",
            &json!(num(&meter["lastFlushDurationMs"]) / 1000.0),
            &[],
        ));
        lines.push(line(
            "cantrip_account_usage_bandwidth_dropped_bytes_total",
            &meter["droppedBytes"],
            &[],
        ));
        lines.push(line(
            "cantrip_account_usage_bandwidth_dropped_measurements_total",
            &meter["droppedMeasurements"],
            &[],
        ));
        lines.push("# HELP cantrip_account_usage_history_maintenance_total Usage rollup and retention outcomes.".to_owned());
        lines.push("# TYPE cantrip_account_usage_history_maintenance_total counter".to_owned());
        for (outcome, key) in [
            ("completed", "completionCount"),
            ("failed", "failureCount"),
            ("lease_unavailable", "leaseContentionCount"),
        ] {
            lines.push(line(
                "cantrip_account_usage_history_maintenance_total",
                &maintenance[key],
                &[("outcome", outcome)],
            ));
        }
        lines.push(line(
            "cantrip_account_usage_history_maintenance_duration_seconds",
            &json!(num(&maintenance["lastDurationMs"]) / 1000.0),
            &[],
        ));
        lines.push(line(
            "cantrip_account_usage_history_maintenance_seconds_since_success",
            &seconds_since(&maintenance["lastSuccessfulAt"], now),
            &[],
        ));
        let result = &maintenance["lastResult"];
        for (resource, rollup) in [
            ("bandwidth", "bandwidthDaysRolled"),
            ("storage", "storageDaysRolled"),
        ] {
            lines.push(line(
                "cantrip_account_usage_history_rollup_rows",
                &result[rollup],
                &[("resource", resource)],
            ));
        }
        for (resource, hourly, daily) in [
            (
                "bandwidth",
                "bandwidthHourlyRowsDeleted",
                "bandwidthDailyRowsDeleted",
            ),
            (
                "storage",
                "storageHourlyRowsDeleted",
                "storageDailyRowsDeleted",
            ),
        ] {
            lines.push(line(
                "cantrip_account_usage_history_retained_rows_deleted",
                &json!(num(&result[hourly]) + num(&result[daily])),
                &[("resource", resource)],
            ));
        }
        lines.push(line(
            "cantrip_account_usage_history_retained_rows_deleted",
            &result["flushRowsDeleted"],
            &[("resource", "flush_ledger")],
        ));
        lines.push(line(
            "cantrip_account_usage_accounts",
            &totals["accountCount"],
            &[],
        ));
        for (kind, key) in [
            ("server", "logicalServerBytes"),
            ("worker_managed", "logicalWorkerManagedBytes"),
        ] {
            lines.push(line(
                "cantrip_account_usage_logical_bytes",
                &totals[key],
                &[("storage_class", kind)],
            ));
        }
        lines.push(line(
            "cantrip_database_physical_size_available",
            &json!(if physical.is_null() { 0 } else { 1 }),
            &[],
        ));
        if !physical.is_null() {
            lines.push(line("cantrip_database_physical_bytes", physical, &[]));
            lines.push(line(
                "cantrip_account_usage_physical_logical_drift_bytes",
                &Value::String(
                    (integer(physical) - integer(&totals["logicalServerBytes"]))
                        .to_string()
                        .into(),
                ),
                &[],
            ));
        }
    }
    let (coordination, workers, live, quotas) = (
        &input["coordination"],
        &input["workers"],
        &input["live"],
        &input["quotas"],
    );
    lines.push(line(
        "cantrip_database_ready",
        &json!(if state.database["ready"] == true {
            1
        } else {
            0
        }),
        &[],
    ));
    lines.push(line(
        "cantrip_coordination_shared",
        &json!(if coordination["shared"] == true { 1 } else { 0 }),
        &[],
    ));
    for (name, key) in [
        ("instances", "instanceCount"),
        ("maximum_instances", "maximumInstances"),
        ("messages_sent_total", "sentMessages"),
        ("messages_received_total", "receivedMessages"),
        ("messages_rejected_total", "rejectedMessages"),
    ] {
        lines.push(line(
            &format!("cantrip_coordination_{name}"),
            &coordination[key],
            &[],
        ));
    }
    lines.push(line(
        "cantrip_database_probe_latency_seconds",
        &state.database["latencySeconds"],
        &[],
    ));
    lines.push(line(
        "cantrip_database_probe_failures_total",
        &state.database["probeFailures"],
        &[],
    ));
    for (name, key) in [
        ("cantrip_workers_connected", "connectedWorkers"),
        ("cantrip_worker_commands_active", "activeRequests"),
        ("cantrip_worker_commands_routed_total", "routedRequests"),
        ("cantrip_worker_command_failures_total", "failedRequests"),
    ] {
        lines.push(line(name, &workers[key], &[]));
    }
    for (name, key) in [
        ("connections", "connectionCount"),
        ("events_delivered_total", "deliveredEventCount"),
        ("protocol_violations_total", "protocolViolationCount"),
    ] {
        lines.push(line(&format!("cantrip_live_{name}"), &live[key], &[]));
    }
    for (name, key) in [
        ("connections", "activeConnections"),
        ("routes", "activeRoutes"),
        ("connections_opened_total", "openedConnections"),
        ("connections_closed_total", "closedConnections"),
        ("connections_rejected_total", "rejectedConnections"),
    ] {
        lines.push(line(&format!("cantrip_tunnel_{name}"), &tunnels[key], &[]));
    }
    lines.push(line(
        "cantrip_tunnel_bytes_total",
        &json!(num(&tunnels["bytesFromSource"]) + num(&tunnels["bytesToSource"])),
        &[],
    ));
    for (direction, key) in [
        ("source_to_destination", "bytesFromSource"),
        ("destination_to_source", "bytesToSource"),
    ] {
        lines.push(line(
            "cantrip_tunnel_bytes_total",
            &tunnels[key],
            &[("direction", direction)],
        ));
    }
    if let Some(reasons) = tunnels["terminationsByReason"].as_object() {
        for (reason, count) in reasons {
            lines.push(line(
                "cantrip_tunnel_terminations_total",
                count,
                &[("reason", reason.as_str().unwrap())],
            ));
        }
    }
    lines.push(line(
        "cantrip_relay_bytes_total",
        &json!(num(&quotas["relayBytes"]) + num(&quotas["uploadBytes"])),
        &[],
    ));
    lines.push(line(
        "cantrip_remote_surfaces_active",
        &quotas["activeRemoteSurfaces"],
        &[],
    ));
    for (quota, key) in [
        ("relay_bandwidth", "rejectedRelayBandwidth"),
        ("remote_surface", "rejectedRemoteSurfaces"),
        ("upload", "rejectedUploads"),
    ] {
        lines.push(line(
            "cantrip_quota_rejections_total",
            &quotas[key],
            &[("quota", quota)],
        ));
    }
    for (name, key) in [
        ("scans_total", "scans"),
        ("scan_failures_total", "scanFailures"),
        ("due_occurrences_total", "dueOccurrences"),
        ("dispatches_total", "dispatches"),
        ("dispatch_failures_total", "dispatchFailures"),
        ("lease_contentions_total", "leaseContentions"),
        ("lease_recoveries_total", "leaseRecoveries"),
        ("maximum_lag_seconds", "maximumLagSeconds"),
    ] {
        lines.push(line(
            &format!("cantrip_scheduler_{name}"),
            &state.scheduler[key],
            &[],
        ));
    }
    lines.join("\n") + "\n"
}
