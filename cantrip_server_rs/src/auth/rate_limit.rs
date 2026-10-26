use std::collections::{HashMap, VecDeque};

pub struct AuthRateLimiter {
    attempts: HashMap<String, Vec<i64>>,
    order: VecDeque<String>,
    consumed: u64,
    limit: usize,
    window_ms: i64,
}

impl AuthRateLimiter {
    pub fn new(limit: usize) -> Self {
        Self {
            attempts: HashMap::new(),
            order: VecDeque::new(),
            consumed: 0,
            limit,
            window_ms: 60000,
        }
    }
    pub fn consume(&mut self, key: &str, now: i64) -> Option<u64> {
        let cutoff = now - self.window_ms;
        self.consumed = self.consumed.wrapping_add(1);
        if self.consumed.is_multiple_of(256) {
            self.attempts
                .retain(|_, values| values.last().copied().unwrap_or(0) > cutoff);
            self.order.retain(|key| self.attempts.contains_key(key));
            while self.attempts.len() > 10000 {
                if self.order.front().is_none_or(|key| key.is_empty()) {
                    break;
                }
                self.attempts.remove(&self.order.pop_front().unwrap());
            }
        }
        if !self.attempts.contains_key(key) {
            self.attempts.insert(key.into(), Vec::new());
            self.order.push_back(key.into());
        }
        let attempts = self.attempts.get_mut(key).unwrap();
        attempts.retain(|timestamp| *timestamp > cutoff);
        if attempts.len() >= self.limit {
            return Some(
                (((attempts[0] + self.window_ms - now) as f64 / 1000.0)
                    .ceil()
                    .max(1.0)) as u64,
            );
        }
        attempts.push(now);
        None
    }
}
