use chrono::{DateTime, Utc};
use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

pub(super) fn iso(value: &DateTime<Utc>) -> String {
    use chrono::{Datelike, Timelike};
    let year = value.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.month(),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.timestamp_subsec_millis()
    )
}

pub(super) mod decimal {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &BigInt,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BigInt, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}
mod date {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &DateTime<Utc>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&super::iso(value))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<DateTime<Utc>, D::Error> {
        DateTime::<Utc>::deserialize(deserializer)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMeasurement {
    pub category: String,
    #[serde(with = "decimal")]
    pub logical_bytes: BigInt,
    pub owner_id: String,
    #[serde(with = "decimal")]
    pub row_count: BigInt,
    pub storage_class: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentStorage {
    #[serde(flatten)]
    pub measurement: StorageMeasurement,
    pub basis_version: String,
    #[serde(with = "date")]
    pub measured_at: DateTime<Utc>,
    #[serde(with = "date")]
    pub reconciled_at: DateTime<Utc>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHistory {
    #[serde(with = "date")]
    pub bucket_start: DateTime<Utc>,
    pub category: String,
    #[serde(with = "decimal")]
    pub logical_bytes: BigInt,
    #[serde(with = "decimal")]
    pub row_count: BigInt,
    pub storage_class: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BandwidthEntry {
    #[serde(with = "date")]
    pub bucket_start: DateTime<Utc>,
    #[serde(with = "decimal")]
    pub bytes: BigInt,
    pub channel: String,
    pub direction: String,
    #[serde(with = "decimal")]
    pub operation_count: BigInt,
    pub owner_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BandwidthHistory {
    #[serde(with = "date")]
    pub bucket_start: DateTime<Utc>,
    #[serde(with = "decimal")]
    pub bytes: BigInt,
    pub channel: String,
    pub direction: String,
    #[serde(with = "decimal")]
    pub operation_count: BigInt,
    #[serde(with = "date")]
    pub updated_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushBatch {
    pub entries: Vec<BandwidthEntry>,
    #[serde(with = "date")]
    pub flushed_at: DateTime<Utc>,
    pub meter_id: String,
    #[serde(with = "decimal")]
    pub sequence: BigInt,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushResult {
    pub applied: bool,
    pub owner_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationResult {
    pub acquired: bool,
    pub account_count: usize,
    pub category_count: usize,
    #[serde(with = "decimal")]
    pub logical_bytes: BigInt,
    #[serde(with = "date")]
    pub measured_at: DateTime<Utc>,
    pub owner_ids: Vec<String>,
    #[serde(with = "decimal")]
    pub row_count: BigInt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOptions {
    pub daily_retention_days: i64,
    pub flush_retention_days: i64,
    pub hourly_retention_days: i64,
    #[serde(default = "default_lease")]
    pub lease_ms: i64,
}
fn default_lease() -> i64 {
    30 * 60_000
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub acquired: bool,
    pub bandwidth_daily_rows_deleted: usize,
    pub bandwidth_days_rolled: usize,
    pub bandwidth_hourly_rows_deleted: usize,
    pub flush_rows_deleted: usize,
    pub storage_daily_rows_deleted: usize,
    pub storage_days_rolled: usize,
    pub storage_hourly_rows_deleted: usize,
}
fn optional_decimal<S: serde::Serializer>(
    value: &Option<BigInt>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value
        .as_ref()
        .map(ToString::to_string)
        .serialize(serializer)
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationalTotals {
    pub account_count: u64,
    #[serde(with = "decimal")]
    pub logical_server_bytes: BigInt,
    #[serde(with = "decimal")]
    pub logical_worker_managed_bytes: BigInt,
    #[serde(serialize_with = "optional_decimal")]
    pub physical_database_bytes: Option<BigInt>,
}
