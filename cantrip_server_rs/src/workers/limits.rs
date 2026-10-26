use indexmap::IndexMap;

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
