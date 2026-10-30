//! Synchronous, bounded accounting state; database I/O is performed by the service.
use super::{BandwidthEntry, FlushBatch, FlushResult};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use num_bigint::BigInt;
use serde::Serialize;
use std::collections::HashSet;

pub const CHANNELS: &[&str] = &[
    "http",
    "client-live-websocket",
    "worker-control-websocket",
    "worker-log-stream",
    "terminal-relay",
    "remote-surface-relay",
    "tunnel-relay",
    "attachment-transfer",
    "code-relay",
    "project-share-relay",
    "other",
];
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub enum Counter {
    Number(f64),
    Integer(BigInt),
}
impl Counter {
    pub fn checked(&self) -> Option<BigInt> {
        match self {
            Self::Number(value)
                if value.is_finite()
                    && *value >= 0.0
                    && value.fract() == 0.0
                    && *value <= MAX_SAFE_INTEGER as f64 =>
            {
                Some(BigInt::from(*value as u64))
            }
            Self::Integer(value)
                if value >= &BigInt::default() && value <= &BigInt::from(i64::MAX) =>
            {
                Some(value.clone())
            }
            _ => None,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Measurement {
    pub owner_id: String,
    pub bytes: Counter,
    pub operation_count: Option<Counter>,
    pub channel: String,
    pub direction: String,
    pub notify_change: Option<bool>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMeasurement {
    pub owner_id: String,
    #[serde(with = "super::types::decimal")]
    pub bytes: BigInt,
    #[serde(with = "super::types::decimal")]
    pub operation_count: BigInt,
    pub channel: String,
    pub direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_change: Option<bool>,
}
#[derive(Clone, Debug)]
pub struct Options {
    pub meter_id: String,
    pub max_buffered_entries: usize,
    pub flush_threshold_bytes: BigInt,
    pub flush_interval_ms: u64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            meter_id: uuid::Uuid::new_v4().to_string(),
            max_buffered_entries: 4096,
            flush_threshold_bytes: BigInt::from(1024 * 1024),
            flush_interval_ms: 60000,
        }
    }
}
#[derive(Clone)]
struct BufferedEntry {
    entry: BandwidthEntry,
    notify_measurements: BigInt,
}
#[derive(Clone)]
struct Pending {
    batch: FlushBatch,
    entries: Vec<(String, BufferedEntry)>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(with = "super::types::decimal")]
    pub buffered_bytes: BigInt,
    pub buffered_entries: usize,
    #[serde(with = "super::types::decimal")]
    pub dropped_bytes: BigInt,
    #[serde(with = "super::types::decimal")]
    pub dropped_measurements: BigInt,
    pub flush_count: f64,
    pub flush_failure_count: f64,
    pub last_flush_duration_ms: Option<i64>,
    pub last_flushed_at: Option<String>,
    pub pending_sequence: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordOutcome {
    Rejected,
    Noop,
    Recorded,
}
impl RecordOutcome {
    pub fn accepted(self) -> bool {
        self != Self::Rejected
    }
}
pub struct State {
    pub options: Options,
    buffer: IndexMap<String, BufferedEntry>,
    pending: Option<Pending>,
    sequence: BigInt,
    pub closed: bool,
    stats: Stats,
}
impl State {
    pub fn new(options: Options) -> Result<Self> {
        anyhow::ensure!(
            !options
                .meter_id
                .trim_matches(crate::text::whitespace)
                .is_empty()
                && options.max_buffered_entries > 0
                && options.max_buffered_entries as u128 <= u128::from(MAX_SAFE_INTEGER)
                && options.flush_threshold_bytes > BigInt::default()
                && options.flush_interval_ms > 0
                && options.flush_interval_ms <= MAX_SAFE_INTEGER,
            "Account usage meter options are invalid."
        );
        Ok(Self {
            options,
            buffer: IndexMap::new(),
            pending: None,
            sequence: BigInt::default(),
            closed: false,
            stats: Stats {
                buffered_bytes: BigInt::default(),
                buffered_entries: 0,
                dropped_bytes: BigInt::default(),
                dropped_measurements: BigInt::default(),
                flush_count: 0.0,
                flush_failure_count: 0.0,
                last_flush_duration_ms: None,
                last_flushed_at: None,
                pending_sequence: None,
            },
        })
    }
    /// Observation precedes capacity/overflow rejection, matching live traffic.
    pub fn record(
        &mut self,
        input: Measurement,
        now: Option<DateTime<Utc>>,
        observe: impl FnMut(&NormalizedMeasurement),
    ) -> bool {
        self.record_with_hooks(input, now, observe, |_| {})
            .accepted()
    }
    pub fn record_with_hooks(
        &mut self,
        input: Measurement,
        now: Option<DateTime<Utc>>,
        mut observe: impl FnMut(&NormalizedMeasurement),
        mut capacity_reached: impl FnMut(usize),
    ) -> RecordOutcome {
        if self.closed {
            return RecordOutcome::Rejected;
        }
        let owner = input.owner_id.trim_matches(crate::text::whitespace);
        let (Some(bytes), Some(operations), Some(now)) = (
            input.bytes.checked(),
            input
                .operation_count
                .as_ref()
                .map_or_else(|| Some(BigInt::from(1)), Counter::checked),
            now,
        ) else {
            return RecordOutcome::Rejected;
        };
        if owner.is_empty()
            || owner.encode_utf16().count() > 200
            || !CHANNELS.contains(&input.channel.as_str())
            || !["ingress", "egress"].contains(&input.direction.as_str())
        {
            return RecordOutcome::Rejected;
        }
        if bytes == BigInt::default() && operations == BigInt::default() {
            return RecordOutcome::Noop;
        }
        let normalized = NormalizedMeasurement {
            owner_id: owner.into(),
            bytes,
            operation_count: operations,
            channel: input.channel,
            direction: input.direction,
            notify_change: input.notify_change,
        };
        observe(&normalized);
        let Some(bucket_start) = DateTime::from_timestamp_millis(
            now.timestamp_millis().div_euclid(3_600_000) * 3_600_000,
        ) else {
            return RecordOutcome::Rejected;
        };
        let key = format!(
            "{}\0{}\0{}\0{}",
            normalized.owner_id,
            super::types::iso(&bucket_start),
            normalized.channel,
            normalized.direction
        );
        let current = self.buffer.get_mut(&key);
        if current.is_none() && self.buffer.len() >= self.options.max_buffered_entries {
            self.stats.dropped_bytes += &normalized.bytes;
            self.stats.dropped_measurements += 1;
            capacity_reached(self.buffer.len());
            return RecordOutcome::Rejected;
        }
        if let Some(current) = self.buffer.get_mut(&key) {
            let max = BigInt::from(i64::MAX);
            if &current.entry.bytes + &normalized.bytes > max
                || &current.entry.operation_count + &normalized.operation_count > max
            {
                self.stats.dropped_bytes += &normalized.bytes;
                self.stats.dropped_measurements += 1;
                return RecordOutcome::Rejected;
            }
            current.entry.bytes += &normalized.bytes;
            current.entry.operation_count += &normalized.operation_count;
            if normalized.notify_change != Some(false) {
                current.notify_measurements += 1;
            }
        } else {
            self.buffer.insert(
                key,
                BufferedEntry {
                    entry: BandwidthEntry {
                        bucket_start,
                        bytes: normalized.bytes.clone(),
                        channel: normalized.channel,
                        direction: normalized.direction,
                        operation_count: normalized.operation_count,
                        owner_id: normalized.owner_id,
                    },
                    notify_measurements: BigInt::from(u8::from(
                        normalized.notify_change != Some(false),
                    )),
                },
            );
        }
        self.stats.buffered_bytes += normalized.bytes;
        RecordOutcome::Recorded
    }
    pub fn flush_due(&self) -> bool {
        self.stats.buffered_bytes >= self.options.flush_threshold_bytes
    }
    pub fn has_work(&self) -> bool {
        self.pending.is_some() || !self.buffer.is_empty()
    }
    pub fn pending_batch(&self) -> Option<FlushBatch> {
        self.pending.as_ref().map(|pending| pending.batch.clone())
    }
    /// Failed attempts keep exactly the same durable receipt and captured rows.
    pub fn capture(&mut self, at: DateTime<Utc>) -> Option<FlushBatch> {
        if let Some(pending) = &self.pending {
            return Some(pending.batch.clone());
        }
        if self.buffer.is_empty() {
            return None;
        }
        self.sequence += 1;
        let entries: Vec<_> = self
            .buffer
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let batch = FlushBatch {
            entries: entries
                .iter()
                .map(|(_, value)| value.entry.clone())
                .collect(),
            flushed_at: at,
            meter_id: self.options.meter_id.clone(),
            sequence: self.sequence.clone(),
        };
        self.pending = Some(Pending {
            batch: batch.clone(),
            entries,
        });
        Some(batch)
    }
    pub fn failed(&mut self, duration_ms: i64) {
        self.stats.flush_failure_count += 1.0;
        self.stats.last_flush_duration_ms = Some(duration_ms);
    }
    pub fn committed(
        &mut self,
        result: FlushResult,
        at: DateTime<Utc>,
        duration_ms: i64,
    ) -> Result<Vec<String>> {
        let pending = self
            .pending
            .take()
            .context("usage flush completion without a pending batch")?;
        let mut notifying = HashSet::new();
        for (key, flushed) in pending.entries {
            if flushed.notify_measurements > BigInt::default() {
                notifying.insert(flushed.entry.owner_id.clone());
            }
            if let Some(current) = self.buffer.get_mut(&key) {
                current.entry.bytes -= &flushed.entry.bytes;
                current.entry.operation_count -= &flushed.entry.operation_count;
                current.notify_measurements -= &flushed.notify_measurements;
                self.stats.buffered_bytes -= &flushed.entry.bytes;
                if current.entry.bytes == BigInt::default()
                    && current.entry.operation_count == BigInt::default()
                    && current.notify_measurements == BigInt::default()
                {
                    self.buffer.shift_remove(&key);
                }
            }
        }
        self.stats.flush_count += 1.0;
        self.stats.last_flush_duration_ms = Some(duration_ms);
        self.stats.last_flushed_at = Some(super::types::iso(&at));
        Ok(result
            .owner_ids
            .into_iter()
            .filter(|owner| notifying.contains(owner))
            .collect())
    }
    pub fn stats(&self) -> Stats {
        Stats {
            buffered_entries: self.buffer.len(),
            pending_sequence: self.pending.as_ref().map(|p| p.batch.sequence.to_string()),
            ..self.stats.clone()
        }
    }
}
