//! Account-scoped wire projections. Preserve decimal counters, row/series order,
//! null measurement dates and the reference's intentionally disabled limits.
use super::{
    BandwidthHistory, CurrentStorage, StorageHistory, basis_version, repository::calendar_bucket,
    types::iso,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use num_bigint::BigInt;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Deserialize)]
pub struct HistoryQuery {
    pub metric: String,
    pub resolution: String,
    pub from: String,
    pub to: String,
}
pub fn bandwidth_period(now: DateTime<Utc>) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let start = calendar_bucket(now, true)?;
    Ok((
        start,
        start
            .checked_add_signed(chrono::Duration::days(1))
            .context("invalid bandwidth period")?,
    ))
}
pub fn current(
    rows: &[CurrentStorage],
    bandwidth: &[BandwidthHistory],
    now: DateTime<Utc>,
) -> Result<Value> {
    let measured = rows.iter().map(|r| r.measured_at).max();
    let reconciled = rows.iter().map(|r| r.reconciled_at).max();
    let status = match reconciled {
        None => "unavailable",
        Some(at) if now.timestamp_millis() - at.timestamp_millis() > 2 * 60 * 60_000 => "stale",
        _ => "current",
    };
    let server: Vec<_> = rows
        .iter()
        .filter(|r| r.measurement.storage_class == "server")
        .collect();
    let worker: Vec<_> = rows
        .iter()
        .filter(|r| r.measurement.storage_class == "worker-managed")
        .collect();
    let worker_storage = |category: &str| {
        let row = worker.iter().find(|r| r.measurement.category == category);
        json!({"logicalBytes":row.map_or_else(|| "0".into(), |r| r.measurement.logical_bytes.to_string()),"objectCount":row.map_or_else(|| "0".into(), |r| r.measurement.row_count.to_string())})
    };
    let server_bytes: BigInt = server.iter().map(|r| &r.measurement.logical_bytes).sum();
    let server_rows: BigInt = server.iter().map(|r| &r.measurement.row_count).sum();
    let worker_bytes: BigInt = worker.iter().map(|r| &r.measurement.logical_bytes).sum();
    let ingress: BigInt = bandwidth
        .iter()
        .filter(|r| r.direction == "ingress")
        .map(|r| &r.bytes)
        .sum();
    let egress: BigInt = bandwidth
        .iter()
        .filter(|r| r.direction == "egress")
        .map(|r| &r.bytes)
        .sum();
    let operations: BigInt = bandwidth.iter().map(|r| &r.operation_count).sum();
    let (start, end) = bandwidth_period(now)?;
    Ok(json!({
        "measurement":{"basisVersion":rows.first().map_or(basis_version(),|r|r.basis_version.as_str()),"measuredAt":measured.as_ref().map(iso),"reconciledAt":reconciled.as_ref().map(iso),"status":status},
        "storage":{
            "server":{"accuracy":match status {"unavailable"=>"unavailable","stale"=>"stale",_=>"logical-reconciled"},"logicalBytes":server_bytes.to_string(),"rowCount":server_rows.to_string(),"categories":server.iter().map(|r|json!({"category":r.measurement.category,"logicalBytes":r.measurement.logical_bytes.to_string(),"rowCount":r.measurement.row_count.to_string()})).collect::<Vec<_>>()},
            "workerManaged":{"accuracy":match status {"unavailable"=>"unavailable","stale"=>"stale",_=>"server-known-estimate"},"attachmentSources":worker_storage("attachments"),"readyReplicas":worker_storage("attachment-replicas"),"logicalBytes":worker_bytes.to_string()}
        },
        "bandwidth":{"accuracy":"metered","measuredAt":bandwidth.iter().map(|r|r.updated_at).max().as_ref().map(iso),"periodStart":iso(&start),"periodEnd":iso(&end),"ingressBytes":ingress.to_string(),"egressBytes":egress.to_string(),"operationCount":operations.to_string(),"breakdown":bandwidth.iter().map(|r|json!({"channel":r.channel,"direction":r.direction,"bytes":r.bytes.to_string(),"operationCount":r.operation_count.to_string()})).collect::<Vec<_>>()},
        "limits":null,"enforcement":"disabled"
    }))
}
pub fn storage_history(query: &HistoryQuery, rows: &[StorageHistory]) -> Value {
    let mut grouped: IndexMap<String, Vec<&StorageHistory>> = IndexMap::new();
    for row in rows {
        grouped
            .entry(format!("{}:{}", row.storage_class, row.category))
            .or_default()
            .push(row);
    }
    json!({"metric":"storage","resolution":query.resolution,"from":query.from,"to":query.to,"status":if rows.is_empty(){"unavailable"}else{"current"},"series":grouped.into_values().map(|points|{
        let first = points[0];
        json!({"storageClass":first.storage_class,"category":first.category,"accuracy":if first.storage_class=="server"{"logical-reconciled"}else{"server-known-estimate"},"points":points.iter().map(|p|json!({"bucketStart":iso(&p.bucket_start),"logicalBytes":p.logical_bytes.to_string(),"rowCount":p.row_count.to_string()})).collect::<Vec<_>>()})
    }).collect::<Vec<_>>(),"limits":null,"enforcement":"disabled"})
}
pub fn bandwidth_history(query: &HistoryQuery, rows: &[BandwidthHistory]) -> Value {
    let mut grouped: IndexMap<String, Vec<&BandwidthHistory>> = IndexMap::new();
    for row in rows {
        grouped
            .entry(format!("{}:{}", row.channel, row.direction))
            .or_default()
            .push(row);
    }
    json!({"metric":"bandwidth","resolution":query.resolution,"from":query.from,"to":query.to,"status":"current","series":grouped.into_values().map(|points|{
        let first = points[0];
        json!({"channel":first.channel,"direction":first.direction,"accuracy":"metered","points":points.iter().map(|p|json!({"bucketStart":iso(&p.bucket_start),"bytes":p.bytes.to_string(),"operationCount":p.operation_count.to_string()})).collect::<Vec<_>>()})
    }).collect::<Vec<_>>(),"limits":null,"enforcement":"disabled"})
}
