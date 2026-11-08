//! Persisted logs deliberately contain less information than console diagnostics.
use super::log_sanitize;
use crate::wire::{JsString, Value, coercion, value::json};
use anyhow::{Result, bail};
use std::collections::VecDeque;

const STRINGS: &[&str] = &[
    "architecture",
    "attemptKind",
    "connectionScope",
    "errorClass",
    "errorCode",
    "event",
    "method",
    "mode",
    "observationTrigger",
    "operation",
    "path",
    "platform",
    "providerKind",
    "reasonCode",
    "status",
    "subsystem",
    "transportKind",
    "windowKind",
];
const ENUMS: &[&str] = &[
    "actionKind",
    "launchKind",
    "lifecycleKind",
    "ownershipKind",
    "phase",
    "retirementKind",
    "transitionKind",
];
const BOOLEANS: &[&str] = &[
    "active",
    "attachmentReadyAtRequest",
    "closing",
    "codeEditorVisible",
    "dirty",
    "enabled",
    "handoffDestination",
    "handoffSource",
    "hasAttachment",
    "keepInlineCodeWarm",
    "openOwner",
    "pathChanged",
    "pathPresent",
    "prewarm",
    "ready",
    "retained",
    "retainedPathPresent",
    "samePath",
    "sharedTransport",
    "success",
    "transient",
    "visible",
    "workbenchReadyAtRequest",
    "workerOnlineAtRequest",
];
const REJECTIONS: &[&str] = &[
    "target-unavailable",
    "target-rejected",
    "limit-exceeded",
    "unauthorized",
    "protocol-error",
    "congested",
    "protected-target-invalid",
    "protected-record-unavailable",
    "protected-endpoint-unavailable",
];
fn clip(value: &JsString, maximum: usize) -> JsString {
    if value.units().len() <= maximum {
        return value.clone();
    }
    let mut units = value.units()[..maximum.saturating_sub(1)].to_vec();
    units.push(0x2026);
    JsString::new(units)
}
fn enum_value(value: &JsString, plus: bool) -> bool {
    let units = value.units();
    !units.is_empty()
        && units.len() <= 100
        && units.iter().enumerate().all(|(i, &c)| {
            (48..=57).contains(&c)
                || (97..=122).contains(&c)
                || (i > 0
                    && i + 1 < units.len()
                    && (c == 45 || (plus && c == 43))
                    && units[i - 1] != 45
                    && units[i - 1] != 43)
        })
}
fn put(output: &mut Value, key: JsString, value: Value) {
    if let Value::Object(fields) = output {
        fields.insert(key, value);
    }
}
fn minimized_context(value: &Value) -> Option<Value> {
    let source = log_sanitize::context(value);
    let Value::Object(fields) = &source else {
        return None;
    };
    let mut output = Value::object([] as [(&str, Value); 0]);
    for (key, value) in fields {
        let key_text = key.lossy();
        let key_text = key_text.as_ref();
        if key_text == "failureStage" {
            if let Some(text) = value.as_js_string().filter(|text| enum_value(text, false)) {
                output["failureStage"] = Value::String(text.clone());
            }
            continue;
        }
        if key_text == "lastDestinationRejectionCode" {
            if let Some(text) = value
                .as_js_string()
                .filter(|text| REJECTIONS.contains(&text.lossy().as_ref()))
            {
                output["lastDestinationRejectionCode"] = Value::String(text.clone());
            }
            continue;
        }
        if key_text == "path" {
            if let Some(text) = value
                .as_js_string()
                .filter(|text| text.units().starts_with(&[47, 97, 112, 105, 47]))
            {
                put(&mut output, key.clone(), Value::String(clip(text, 512)));
            }
            continue;
        }
        if ENUMS.contains(&key_text)
            && let Some(text) = value.as_js_string()
        {
            if enum_value(text, true) {
                put(&mut output, key.clone(), value.clone());
            }
            continue;
        }
        if let Some(text) = value.as_js_string()
            && (STRINGS.contains(&key_text)
                || key_text.ends_with("Id")
                || key_text.ends_with("Ids")
                || key_text.ends_with("Version"))
        {
            put(&mut output, key.clone(), Value::String(clip(text, 512)));
            continue;
        }
        if value.as_f64().is_some_and(f64::is_finite)
            && (["attempt", "durationMs", "errorStatus", "statusCode"].contains(&key_text)
                || ["Count", "Bytes", "Ms", "Percent", "BasisPoints"]
                    .iter()
                    .any(|suffix| key_text.ends_with(suffix)))
        {
            put(&mut output, key.clone(), value.clone());
            continue;
        }
        if matches!(value, Value::Bool(_)) && BOOLEANS.contains(&key_text) {
            put(&mut output, key.clone(), value.clone());
        }
    }
    if let Value::Object(_) = &source["error"] {
        for (field, target) in [("name", "errorClass"), ("code", "errorCode")] {
            if let Some(text) = source["error"][field].as_js_string() {
                output[target] = Value::String(clip(text, 128));
            }
        }
    }
    match &output {
        Value::Object(fields) if !fields.is_empty() => Some(output),
        _ => None,
    }
}
pub fn minimize(input: &Value) -> Value {
    let system = log_sanitize::text(input["system"].as_js_string().expect("service log system"));
    let context = input.get("context").and_then(minimized_context);
    let message = context
        .as_ref()
        .and_then(|v| v["event"].as_js_string())
        .cloned()
        .unwrap_or_else(|| {
            let mut units = system.units().to_vec();
            units.extend(".diagnostic".encode_utf16());
            JsString::new(units)
        });
    let mut record = json!({"timestamp":input["timestamp"],"system":system,"level":input["level"],"message":message});
    if let Some(context) = context {
        record["context"] = context;
    }
    record
}
fn positive(value: Option<&Value>, fallback: usize) -> Result<usize> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    if let Some(n) = value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
    {
        return Ok(n as usize);
    }
    bail!("Log buffer limits must be positive safe integers.")
}
fn weight(value: &Value) -> Option<u8> {
    match value.as_str() {
        Some("trace") => Some(10),
        Some("debug") => Some(20),
        Some("info") => Some(30),
        Some("warn") => Some(40),
        Some("error") => Some(50),
        Some("fatal") => Some(60),
        _ => None,
    }
}
fn bytes(value: &Value) -> usize {
    value.stringify().len()
}
fn fit(mut record: Value, maximum: usize) -> (Value, usize) {
    let size = bytes(&record);
    if size <= maximum {
        return (record, size);
    }
    if let Value::Object(fields) = &mut record {
        fields.shift_remove(&JsString::from("context"));
    }
    let size = bytes(&record);
    if size <= maximum {
        return (record, size);
    }
    let message = record["message"]
        .as_js_string()
        .expect("minimized log message")
        .clone();
    let (mut low, mut high) = (
        0,
        isize::try_from(message.units().len()).unwrap_or(isize::MAX),
    );
    let mut fitted = record.clone();
    fitted["message"] = json!("");
    while low <= high {
        let middle = (low + high) / 2;
        let mut units = message.units()[..middle as usize].to_vec();
        units.push(0x2026);
        let mut candidate = record.clone();
        candidate["message"] = Value::String(JsString::new(units));
        if bytes(&candidate) <= maximum {
            fitted = candidate;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    let size = bytes(&fitted);
    (fitted, size)
}
pub struct Buffer {
    max_bytes: usize,
    max_entries: usize,
    max_record: usize,
    bytes: usize,
    cursor: f64,
    entries: VecDeque<(Value, usize)>,
}
impl Buffer {
    pub fn new(options: &Value) -> Result<Self> {
        let max_bytes = positive(options.get("maxBytes"), 5 * 1024 * 1024)?;
        Ok(Self {
            max_bytes,
            max_entries: positive(options.get("maxEntries"), 10_000)?,
            max_record: positive(options.get("maxRecordBytes"), 16 * 1024)?.min(max_bytes),
            bytes: 0,
            cursor: 0.0,
            entries: VecDeque::new(),
        })
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
    pub fn append(&mut self, input: &Value) -> Value {
        self.cursor += 1.0;
        let mut candidate = minimize(input);
        candidate["cursor"] = json!(self.cursor);
        let (record, size) = fit(candidate, self.max_record);
        self.entries.push_back((record.clone(), size));
        self.bytes += size;
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            if let Some((_, size)) = self.entries.pop_front() {
                self.bytes -= size
            } else {
                break;
            }
        }
        record
    }
    pub fn stats(&self) -> Value {
        json!({"byteSize":self.bytes,"size":self.entries.len(),"latestCursor":self.cursor})
    }
    pub fn read(&self, options: &Value) -> Result<Value> {
        let numeric = |name: &str, default: f64| {
            options
                .get(name)
                .filter(|v| !v.is_null())
                .map_or(default, |v| {
                    coercion::number(Some(v)).unwrap_or(f64::NAN).floor()
                })
        };
        let maximum = |value: f64, lower: f64| {
            if value.is_nan() {
                value
            } else {
                value.max(lower)
            }
        };
        let after = maximum(numeric("afterCursor", 0.0), 0.0);
        let before = options
            .get("beforeCursor")
            .map(|_| maximum(numeric("beforeCursor", 0.0), 1.0));
        let limit = positive(options.get("limit"), 200)?.min(500);
        let minimum = options
            .get("minimumLevel")
            .filter(|v| !v.is_null())
            .map_or(Some(10), weight);
        let matches = |v: &Value| {
            weight(&v["level"])
                .zip(minimum)
                .is_some_and(|(a, b)| a >= b)
        };
        let oldest = self.entries.front().and_then(|(r, _)| r["cursor"].as_f64());
        let (mut records, mut next, mut more) = (Vec::new(), after, false);
        let truncated = if let Some(before) = before {
            for (record, _) in self.entries.iter().rev() {
                if record["cursor"].as_f64().unwrap() >= before
                    || weight(&record["level"])
                        .zip(minimum)
                        .is_some_and(|(a, b)| a < b)
                {
                    continue;
                }
                if records.len() >= limit {
                    more = true;
                    break;
                }
                records.push(record.clone());
            }
            records.reverse();
            next = self.cursor;
            !more && oldest.is_some_and(|oldest| oldest > 1.0)
        } else {
            for (index, (record, _)) in self.entries.iter().enumerate() {
                let cursor = record["cursor"].as_f64().unwrap();
                if cursor <= after {
                    continue;
                }
                next = cursor;
                if matches(record) {
                    records.push(record.clone())
                }
                if records.len() >= limit {
                    more = index + 1 < self.entries.len();
                    break;
                }
            }
            if !more && next < self.cursor {
                next = self.cursor;
            }
            oldest.is_some_and(|oldest| after > 0.0 && after < oldest - 1.0)
        };
        Ok(
            json!({"records":records,"nextCursor":next,"oldestCursor":oldest,"latestCursor":self.cursor,"hasMore":more,"truncated":truncated}),
        )
    }
}
