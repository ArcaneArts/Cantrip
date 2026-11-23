//! Leased worker diagnostics over the existing command socket.
use crate::{connection::Outbound, logging::Logs};
use anyhow::{Context, Result, ensure};
use cantrip_logging::log_records::level_weight;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};
use tokio::time::Instant;

const START: &str = "diagnostics.logs.stream.start";
const RENEW: &str = "diagnostics.logs.stream.renew";
const STOP: &str = "diagnostics.logs.stream.stop";
const MAX_STREAMS: usize = 32;
const MAX_RECORDS: usize = 200;
const MAX_PENDING_BYTES: usize = 256 * 1024;
const BATCH_DELAY: Duration = Duration::from_millis(75);
const RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(crate) struct Streams(HashMap<JsString, Lease>);

struct Lease {
    expires: Instant,
    flush: Option<Instant>,
    latest: u64,
    seen: u64,
    level: Value,
    minimum: u8,
    pending: VecDeque<(Value, usize)>,
    bytes: usize,
    truncated: bool,
}

fn cursor(value: &Value, field: &str) -> Result<u64> {
    value[field]
        .as_u64()
        .with_context(|| format!("Invalid diagnostic log {field}."))
}

impl Lease {
    fn new(
        initial: &Value,
        level: Value,
        after: u64,
        expires: Instant,
        now: Instant,
    ) -> Result<Self> {
        let minimum = level_weight(&level).context("Invalid diagnostic log level.")?;
        let mut stream = Self {
            expires,
            flush: None,
            latest: cursor(initial, "nextCursor")?,
            seen: cursor(initial, "latestCursor")?,
            level,
            minimum,
            pending: VecDeque::new(),
            bytes: 0,
            truncated: initial["truncated"] == true,
        };
        for record in initial["records"]
            .as_array()
            .context("Missing diagnostic log records.")?
        {
            stream.append(record);
        }
        if !stream.pending.is_empty() || stream.truncated || stream.latest > after {
            stream.flush = Some(now);
        }
        Ok(stream)
    }

    fn append(&mut self, record: &Value) {
        let bytes = record.stringify().len();
        self.bytes += bytes;
        self.pending.push_back((record.clone(), bytes));
        while self.pending.len() > MAX_RECORDS || self.bytes > MAX_PENDING_BYTES {
            let (_, removed) = self.pending.pop_front().expect("bounded diagnostic batch");
            self.bytes -= removed;
            self.truncated = true;
        }
    }

    fn observe(&mut self, record: &Value, cursor: u64, gap: bool, now: Instant) {
        if cursor <= self.seen {
            return;
        }
        if gap && cursor > self.seen + 1 {
            self.truncated = true;
        }
        self.seen = cursor;
        self.latest = self.latest.max(cursor);
        if level_weight(&record["level"]).is_some_and(|weight| weight >= self.minimum) {
            self.append(record);
        }
        self.flush.get_or_insert(now + BATCH_DELAY);
    }

    fn send(
        &mut self,
        id: &JsString,
        logs: &Logs,
        outbound: &Outbound,
        now: Instant,
    ) -> Result<()> {
        let latest =
            logs.read(&json!({"afterCursor":self.latest,"limit":1,"minimumLevel":self.level}))?;
        let records: Vec<_> = self
            .pending
            .iter()
            .map(|(record, _)| record.clone())
            .collect();
        let delivered = outbound.notification(json!({
            "type":"diagnostics.logs.observed","subscriptionId":id,"records":records,
            "nextCursor":self.latest,"oldestCursor":latest["oldestCursor"],"latestCursor":latest["latestCursor"],
            "truncated":self.truncated || latest["truncated"] == true
        }))?;
        if delivered {
            self.pending.clear();
            self.bytes = 0;
            self.truncated = false;
            self.flush = None;
        } else {
            self.flush = Some(now + RETRY_DELAY);
        }
        Ok(())
    }
}

impl Streams {
    pub fn supports(kind: &str) -> bool {
        matches!(kind, START | RENEW | STOP)
    }

    pub fn execute(&mut self, kind: &str, command: &Value, logs: &Logs) -> Result<Value> {
        let id = command["subscriptionId"]
            .as_js_string()
            .context("Missing worker log subscription ID.")?;
        let now = Instant::now();
        self.expire(now);
        if kind == STOP {
            return Ok(json!({"stopped":self.0.remove(id).is_some()}));
        }

        let duration = command["leaseMs"]
            .as_u64()
            .context("Missing worker log stream lease.")?;
        let expires = now + Duration::from_millis(duration);
        if kind == RENEW {
            let stream = self.0.get_mut(id);
            let accepted = stream.is_some();
            if let Some(stream) = stream {
                stream.expires = expires;
            }
            return Ok(json!({"accepted":accepted}));
        }

        ensure!(
            self.0.contains_key(id) || self.0.len() < MAX_STREAMS,
            "The worker log stream limit has been reached."
        );
        let after = cursor(command, "afterCursor")?;
        let level = &command["minimumLevel"];
        let initial = logs.read(&json!({"afterCursor":after,"limit":500,"minimumLevel":level}))?;
        let stream = Lease::new(&initial, level.clone(), after, expires, now)?;
        let latest = stream.seen;
        self.0.insert(id.clone(), stream);
        Ok(json!({"accepted":true,"latestCursor":latest}))
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.0
            .values()
            .map(|stream| {
                stream
                    .flush
                    .map_or(stream.expires, |at| at.min(stream.expires))
            })
            .min()
    }

    pub fn observe(&mut self, record: &Value, gap: bool) {
        if let Some(cursor) = record["cursor"].as_u64() {
            let now = Instant::now();
            for stream in self.0.values_mut().filter(|stream| now < stream.expires) {
                stream.observe(record, cursor, gap, now);
            }
        }
    }

    pub fn flush(&mut self, logs: &Logs, outbound: &Outbound) {
        let now = Instant::now();
        self.expire(now);
        for (id, stream) in self
            .0
            .iter_mut()
            .filter(|(_, stream)| stream.flush.is_some_and(|at| at <= now))
        {
            if let Err(error) = stream.send(id, logs, outbound, now) {
                stream.flush = Some(now + RETRY_DELAY);
                logs.repeated("worker-log-stream-delivery".into(), "warn", "Worker log stream delivery failed",
                    json!({"event":"worker.logs.stream-delivery-failed","subsystem":"worker-logging","error":crate::logging::error(&error)}));
            }
        }
    }

    fn expire(&mut self, now: Instant) {
        self.0.retain(|_, stream| now < stream.expires);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_are_bounded_and_include_the_cursor_of_filtered_logs() -> Result<()> {
        let now = Instant::now();
        let initial = json!({"nextCursor":1,"latestCursor":1,"records":Vec::<Value>::new(),"truncated":false});
        let mut stream = Lease::new(
            &initial,
            json!("info"),
            1,
            now + Duration::from_secs(10),
            now,
        )?;
        let content = "x".repeat(4096);
        for cursor in 2..=210 {
            stream.observe(
                &json!({"level":"info","cursor":cursor,"message":content}),
                cursor,
                false,
                now,
            );
        }
        assert!(stream.bytes <= MAX_PENDING_BYTES);
        assert!(stream.pending.len() <= MAX_RECORDS);
        assert!(stream.truncated);
        assert_eq!(
            stream.pending.back().unwrap().0["cursor"].as_u64(),
            Some(210)
        );

        stream.observe(&json!({"level":"debug","cursor":211}), 211, false, now);
        assert_eq!(stream.latest, 211);
        assert_eq!(
            stream.pending.back().unwrap().0["cursor"].as_u64(),
            Some(210)
        );
        Ok(())
    }

    #[test]
    fn replay_watermark_does_not_duplicate_records_or_report_old_lag() -> Result<()> {
        let now = Instant::now();
        let initial = json!({"nextCursor":8,"latestCursor":900,"records":Vec::<Value>::new(),"truncated":false});
        let mut streams = Streams::default();
        let id: JsString = "fixture".into();
        let expires = now + Duration::from_secs(10);
        let mut stream = Lease::new(&initial, json!("info"), 8, expires, now)?;
        stream.observe(&json!({"level":"info","cursor":800}), 800, true, now);
        assert_eq!(stream.latest, 8);
        assert!(!stream.truncated);
        stream.observe(&json!({"level":"info","cursor":903}), 903, true, now);
        assert!(stream.truncated);
        assert_eq!(stream.latest, 903);
        assert_eq!(stream.pending.len(), 1);
        streams.0.insert(id, stream);
        assert_eq!(streams.deadline(), Some(now + BATCH_DELAY));
        streams.expire(expires);
        assert_eq!(streams.deadline(), None);
        Ok(())
    }
}
