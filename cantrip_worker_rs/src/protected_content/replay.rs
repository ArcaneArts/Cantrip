use anyhow::{Result, bail};
use cantrip_wire::{Value, coercion, value::json};
use indexmap::IndexMap;

const MAX_ACTIVE_STREAMS: usize = 10_000;
const MAX_REPLAY_RECORDS: usize = 10_000;

/// Mirrors the existing reserve/accept/release contract. Reserve consumes a
/// sequence before asynchronous opening; a failed open never rolls it back.
/// Owners must scope/drop this guard with the authorized resource lifetime.
#[derive(Default)]
pub struct SurfaceStreamReplayGuard {
    completed: IndexMap<String, ()>,
    next: IndexMap<String, f64>,
}
fn key(context: &Value) -> String {
    Value::Array(vec![
        context["serverId"].clone(),
        context["surfaceKind"].clone(),
        context["surfaceId"].clone(),
        context["operationId"].clone(),
        context["direction"].clone(),
    ])
    .stringify()
}
impl SurfaceStreamReplayGuard {
    pub fn reserve(&mut self, context: &Value) -> Result<()> {
        let key = key(context);
        if self.completed.contains_key(&key) {
            bail!("Protected surface operation was already completed.");
        }
        let active = self.next.get(&key).copied();
        if active.is_none() && self.next.len() >= MAX_ACTIVE_STREAMS {
            bail!("Too many protected surface operations are active.");
        }
        let expected = active.unwrap_or(0.0);
        if context.get("sequence") != Some(&json!(expected)) {
            let received = match context.get("sequence") {
                Some(value) => coercion::string(value)
                    .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?,
                None => "undefined".into(),
            };
            bail!(
                "Expected protected surface sequence {}, received {}.",
                coercion::string(&json!(expected)).unwrap(),
                received
            );
        }
        self.next.insert(key, expected + 1.0);
        Ok(())
    }
    pub fn accept(&mut self, context: &Value, complete: bool) -> Result<()> {
        let key = key(context);
        let after = context["sequence"].as_f64().unwrap_or(f64::NAN) + 1.0;
        if self.next.get(&key) != Some(&after) {
            bail!("Protected surface sequence was not reserved.");
        }
        if complete {
            self.next.shift_remove(&key);
            self.completed.shift_remove(&key);
            self.completed.insert(key, ());
            while self.completed.len() > MAX_REPLAY_RECORDS {
                self.completed.shift_remove_index(0);
            }
        }
        Ok(())
    }
    pub fn release(&mut self, context: &Value) {
        let key = key(context);
        self.next.shift_remove(&key);
        self.completed.shift_remove(&key);
    }
}
