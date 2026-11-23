use indexmap::IndexMap;
use std::collections::HashMap;

// The shared API/pairing limiter differs from the authentication limiter's
// 10,000-key retention policy. Preserve the existing 20,000-key policy here.
pub struct SlidingWindow {
    attempts: IndexMap<String, Vec<i64>>,
    consumed: u64,
    limit: usize,
}
impl SlidingWindow {
    pub fn new(limit: usize) -> Self {
        Self {
            attempts: IndexMap::new(),
            consumed: 0,
            limit,
        }
    }
    pub fn consume(&mut self, key: &str, now: i64) -> Option<u64> {
        let cutoff = now - 60000;
        self.consumed = self.consumed.wrapping_add(1);
        if self.consumed.is_multiple_of(256) {
            self.attempts
                .retain(|_, times| times.last().is_some_and(|t| *t > cutoff));
            while self.attempts.len() > 20000 {
                if self.attempts.first().is_none_or(|(key, _)| key.is_empty()) {
                    break;
                }
                self.attempts.shift_remove_index(0);
            }
        }
        let times = self.attempts.entry(key.into()).or_default();
        times.retain(|t| *t > cutoff);
        if times.len() >= self.limit {
            return Some((((times[0] + 60000 - now) as f64 / 1000.0).ceil().max(1.0)) as u64);
        }
        times.push(now);
        None
    }
}

pub struct ByteWindow {
    buckets: IndexMap<String, Vec<(i64, u64)>>,
    consumed: u64,
    limit: u64,
}
impl ByteWindow {
    pub fn new(limit: u64) -> Self {
        Self {
            buckets: IndexMap::new(),
            consumed: 0,
            limit,
        }
    }
    pub fn retry_after(&self, key: &str, bytes: u64, now: i64) -> Option<u64> {
        if bytes == 0 {
            return None;
        }
        let mut live = self
            .buckets
            .get(key)
            .into_iter()
            .flatten()
            .filter(|(at, _)| *at > now - 60000);
        let first = live.next();
        let total = first
            .into_iter()
            .chain(live)
            .try_fold(0_u64, |sum, (_, bytes)| sum.checked_add(*bytes));
        if bytes <= self.limit
            && total
                .and_then(|total| total.checked_add(bytes))
                .is_some_and(|total| total <= self.limit)
        {
            return None;
        }
        Some(
            (((first.map_or(now, |(at, _)| *at) + 60000 - now) as f64 / 1000.0)
                .ceil()
                .max(1.0)) as u64,
        )
    }
    pub fn consume(&mut self, key: &str, bytes: u64, now: i64) -> Option<u64> {
        if bytes == 0 {
            return None;
        }
        if let Some(retry) = self.retry_after(key, bytes, now) {
            return Some(retry);
        }
        let cutoff = now - 60000;
        self.consumed = self.consumed.wrapping_add(1);
        if self.consumed.is_multiple_of(256) {
            self.buckets
                .retain(|_, buckets| buckets.last().is_some_and(|(at, _)| *at > cutoff));
            while self.buckets.len() > 20000 {
                if self.buckets.first().is_none_or(|(key, _)| key.is_empty()) {
                    break;
                }
                self.buckets.shift_remove_index(0);
            }
        }
        let buckets = self.buckets.entry(key.into()).or_default();
        buckets.retain(|(at, _)| *at > cutoff);
        if let Some((at, total)) = buckets.last_mut()
            && *at == now
        {
            *total += bytes;
        } else {
            buckets.push((now, bytes));
        }
        None
    }
}

pub struct ActiveLimit {
    counts: HashMap<String, usize>,
    limit: usize,
}
impl ActiveLimit {
    pub fn new(limit: usize) -> Self {
        Self {
            counts: HashMap::new(),
            limit,
        }
    }
    pub fn acquire(&mut self, key: &str) -> bool {
        let count = self.counts.get(key).copied().unwrap_or(0);
        if count >= self.limit {
            return false;
        }
        self.counts.insert(key.into(), count + 1);
        true
    }
    pub fn release(&mut self, key: &str) {
        if self.counts.get(key).copied().unwrap_or(1) <= 1 {
            self.counts.remove(key);
        } else {
            *self.counts.get_mut(key).unwrap() -= 1;
        }
    }
    pub fn count(&self, key: &str) -> usize {
        self.counts.get(key).copied().unwrap_or(0)
    }
    pub fn total(&self) -> usize {
        self.counts.values().sum()
    }
}
