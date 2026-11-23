//! Bounded, process-local traffic samples. This is an observer of the durable
//! meter, including measurements rejected by its capacity or bigint limit.
use super::meter::{Counter, MAX_SAFE_INTEGER, Measurement};
use anyhow::{Result, ensure};
use indexmap::IndexMap;
use num_bigint::BigInt;
use serde_json::{Value, json};

pub const ROUTE: &str = "/api/account/live-traffic";
#[derive(Clone)]
pub struct Options {
    pub epoch: String,
    pub instance_id: String,
    pub max_owners: usize,
    pub owner_retention_seconds: u64,
}
impl Options {
    pub fn new(instance_id: String) -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            instance_id,
            max_owners: 2048,
            owner_retention_seconds: 600,
        }
    }
}
#[derive(Default)]
pub struct Query {
    pub after: Option<String>,
    pub epoch: Option<String>,
}
#[derive(Default)]
struct Bucket {
    download: u64,
    http: u64,
    revision: u64,
    upload: u64,
    websocket_download: u64,
    websocket_upload: u64,
}
struct Owner {
    // JS Map keys are Number values. Store their bits so injectable clocks
    // retain their semantics even outside the Date range accepted by snapshots.
    buckets: IndexMap<u64, Bucket>,
    last_access_second: f64,
    last_pruned_sample_index: f64,
    revision: u64,
}
pub struct LiveTrafficMeter {
    pub epoch: String,
    pub instance_id: String,
    owners: IndexMap<String, Owner>,
    max_owners: usize,
    retention: u64,
    last_eviction_second: f64,
    interval_seconds: f64,
    max_samples: usize,
    window_seconds: u64,
}
fn add(current: u64, increment: u64) -> u64 {
    (current + increment).min(MAX_SAFE_INTEGER)
}
fn safe(value: &Counter) -> Option<u64> {
    match value {
        Counter::Integer(value) if value >= &BigInt::default() => {
            if value > &BigInt::from(MAX_SAFE_INTEGER) {
                Some(MAX_SAFE_INTEGER)
            } else {
                u64::try_from(value).ok()
            }
        }
        Counter::Number(value)
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= 0.0
                && *value <= MAX_SAFE_INTEGER as f64 =>
        {
            Some(*value as u64)
        }
        _ => None,
    }
}
fn valid_owner(owner: &str) -> bool {
    !owner.is_empty() && owner.encode_utf16().count() <= 200
}
fn number(value: f64) -> String {
    ryu_js::Buffer::new().format_finite(value).to_owned()
}
fn cursor(value: &str) -> Option<(f64, u64)> {
    // ECMAScript's non-multiline '$' also accepts one final line terminator.
    let value = value
        .strip_suffix(['\n', '\r', '\u{2028}', '\u{2029}'])
        .unwrap_or(value);
    let (sample, revision) = value.split_once(':')?;
    if [sample, revision]
        .iter()
        .any(|v| v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let sample: f64 = sample.parse().ok()?;
    let revision: f64 = revision.parse().ok()?;
    (sample <= MAX_SAFE_INTEGER as f64 && revision <= MAX_SAFE_INTEGER as f64)
        .then_some((sample, revision as u64))
}
/// Date's TimeClip and proleptic Gregorian formatting, including the signed
/// six-digit years at both ends of JavaScript's supported Date range.
fn iso_millis(value: f64) -> Result<String> {
    ensure!(
        value.is_finite() && value.abs() <= 8_640_000_000_000_000.0,
        "Invalid time value"
    );
    let millis = value as i64;
    let days = millis.div_euclid(86_400_000);
    let time = millis.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let day_of_era = z - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = shifted_month + if shifted_month < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Ok(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        (time / 60_000) % 60,
        (time / 1000) % 60,
        time % 1000
    ))
}
impl LiveTrafficMeter {
    pub fn new(options: Options) -> Result<Self> {
        let config = &super::CONTRACT["liveTraffic"];
        let window_seconds = config["windowSeconds"].as_u64().expect("traffic window");
        let instance_id = options
            .instance_id
            .trim_matches(crate::text::whitespace)
            .to_owned();
        ensure!(
            valid_owner(&instance_id)
                && instance_id.encode_utf16().count() <= 100
                && options.max_owners > 0
                && options.max_owners as u128 <= u128::from(MAX_SAFE_INTEGER)
                && options.owner_retention_seconds >= window_seconds
                && options.owner_retention_seconds <= MAX_SAFE_INTEGER,
            "Live traffic meter options are invalid."
        );
        Ok(Self {
            epoch: options.epoch,
            instance_id,
            owners: IndexMap::new(),
            max_owners: options.max_owners,
            retention: options.owner_retention_seconds,
            last_eviction_second: -1.0,
            interval_seconds: config["sampleIntervalSeconds"]
                .as_f64()
                .expect("traffic interval"),
            max_samples: config["maxSamples"].as_u64().expect("traffic samples") as usize,
            window_seconds,
        })
    }
    fn now(value: f64) -> Result<f64> {
        ensure!(
            value.is_finite() && value >= 0.0,
            "Live traffic clock returned an invalid value."
        );
        Ok(value)
    }
    pub fn record(&mut self, input: &Measurement, now: f64) -> Result<bool> {
        let owner = input.owner_id.trim_matches(crate::text::whitespace);
        let (Some(bytes), Some(operations)) = (
            safe(&input.bytes),
            input.operation_count.as_ref().map_or(Some(1), safe),
        ) else {
            return Ok(false);
        };
        if !valid_owner(owner) || !["ingress", "egress"].contains(&input.direction.as_str()) {
            return Ok(false);
        }
        if bytes == 0 && operations == 0 {
            return Ok(true);
        }
        let index = (Self::now(now)? / (self.interval_seconds * 1000.0)).floor();
        let max = self.max_samples;
        let owner = self.owner(owner, index)?;
        owner.revision = add(owner.revision, 1);
        let revision = owner.revision;
        let bucket = Self::bucket(owner, index, max);
        bucket.revision = revision;
        let websocket =
            ["client-live-websocket", "worker-control-websocket"].contains(&input.channel.as_str());
        if input.direction == "ingress" {
            bucket.upload = add(bucket.upload, bytes);
            if websocket {
                bucket.websocket_upload = add(bucket.websocket_upload, operations);
            }
        } else {
            bucket.download = add(bucket.download, bytes);
            if websocket {
                bucket.websocket_download = add(bucket.websocket_download, operations);
            }
        }
        Ok(true)
    }
    pub fn record_http_request(&mut self, owner: &str, route: &str, now: f64) -> Result<bool> {
        let owner = owner.trim_matches(crate::text::whitespace);
        if !valid_owner(owner) || route == ROUTE {
            return Ok(false);
        }
        let index = (Self::now(now)? / (self.interval_seconds * 1000.0)).floor();
        let max = self.max_samples;
        let owner = self.owner(owner, index)?;
        owner.revision = add(owner.revision, 1);
        let revision = owner.revision;
        let bucket = Self::bucket(owner, index, max);
        bucket.revision = revision;
        bucket.http = add(bucket.http, 1);
        Ok(true)
    }
    pub fn owner_count(&mut self, now: f64) -> Result<usize> {
        self.evict((Self::now(now)? / 1000.0).floor());
        Ok(self.owners.len())
    }
    pub fn snapshot(&mut self, owner: &str, query: &Query, now: f64) -> Result<Value> {
        let now = Self::now(now)?;
        let index = (now / (self.interval_seconds * 1000.0)).floor();
        let max = self.max_samples;
        let interval = self.interval_seconds * 1000.0;
        let same_epoch = query.epoch.as_ref() == Some(&self.epoch);
        let mut reset = query
            .epoch
            .as_ref()
            .is_some_and(|v| !v.is_empty() && v != &self.epoch);
        let owner = self.owner(owner.trim_matches(crate::text::whitespace), index)?;
        let window_start = index - max as f64 + 1.0;
        let after = query.after.as_ref().filter(|v| !v.is_empty());
        let requested = after.and_then(|v| cursor(v));
        if after.is_some()
            && requested.is_none_or(|(sample, revision)| {
                sample < window_start - 1.0 || sample > index || revision > owner.revision
            })
        {
            reset = true;
        }
        let incremental = after.is_some() && same_epoch && requested.is_some() && !reset;
        let start = if incremental {
            window_start.max(requested.unwrap().0)
        } else {
            window_start
        };
        // Validate Date at the point the reference first materializes samples.
        let _ = iso_millis(start * interval)?;
        let mut samples = vec![];
        let mut sample = start;
        while sample <= index {
            let bucket = owner.buckets.get(&sample.to_bits());
            if !(incremental
                && sample == requested.unwrap().0
                && bucket.map_or(0, |b| b.revision) <= requested.unwrap().1)
            {
                samples.push(Self::sample(sample, bucket, interval)?);
            }
            sample += 1.0;
        }
        let current = Self::sample(index, owner.buckets.get(&index.to_bits()), interval)?;
        let cursor = format!("{}:{}", number(index), owner.revision);
        Ok(
            json!({"schemaVersion":1,"epoch":self.epoch,"cursor":cursor,"instanceId":self.instance_id,"scope":"current-server-instance","sampleIntervalSeconds":self.interval_seconds,"windowSeconds":self.window_seconds,"generatedAt":iso_millis(now)?,"reset":reset,"current":current,"samples":samples,"measurement":{"basis":"application-payload","directTrafficIncluded":false,"transportOverheadIncluded":false}}),
        )
    }
    fn evict(&mut self, second: f64) {
        if self.last_eviction_second == second {
            return;
        }
        self.last_eviction_second = second;
        let stale_before = second - self.retention as f64;
        self.owners
            .retain(|_, owner| owner.last_access_second >= stale_before);
    }
    fn owner(&mut self, owner: &str, index: f64) -> Result<&mut Owner> {
        ensure!(valid_owner(owner), "Live traffic owner is invalid.");
        let second = (index * self.interval_seconds).floor();
        self.evict(second);
        if !self.owners.contains_key(owner) {
            if self.owners.len() >= self.max_owners {
                let mut oldest = 0;
                let mut oldest_second = f64::INFINITY;
                for (i, (_, candidate)) in self.owners.iter().enumerate() {
                    if candidate.last_access_second < oldest_second {
                        oldest = i;
                        oldest_second = candidate.last_access_second;
                    }
                }
                self.owners.shift_remove_index(oldest);
            }
            self.owners.insert(
                owner.to_owned(),
                Owner {
                    buckets: IndexMap::new(),
                    last_access_second: second,
                    last_pruned_sample_index: -1.0,
                    revision: 0,
                },
            );
        }
        let owner = self.owners.get_mut(owner).expect("traffic owner");
        owner.last_access_second = second;
        Ok(owner)
    }
    fn bucket(owner: &mut Owner, index: f64, max: usize) -> &mut Bucket {
        if owner.last_pruned_sample_index != index {
            let minimum = index - max as f64 + 1.0;
            owner.buckets.retain(|i, _| {
                let i = f64::from_bits(*i);
                i >= minimum && i <= index
            });
            owner.last_pruned_sample_index = index;
        }
        owner.buckets.entry(index.to_bits()).or_default()
    }
    fn sample(index: f64, bucket: Option<&Bucket>, interval: f64) -> Result<Value> {
        let empty = Bucket::default();
        let b = bucket.unwrap_or(&empty);
        Ok(
            json!({"timestamp":iso_millis(index * interval)?,"uploadBytes":b.upload,"downloadBytes":b.download,"httpRequests":b.http,"websocketMessages":{"upload":b.websocket_upload,"download":b.websocket_download,"total":add(b.websocket_upload,b.websocket_download)}}),
        )
    }
}
