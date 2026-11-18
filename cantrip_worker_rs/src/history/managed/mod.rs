//! Worker-owned capture/binding and receipt-backed projection pumps. Native
//! transport retirement does not retire durable history delivery.
pub mod canonical;
mod completion;
pub mod coordinator;
pub mod descendants;
pub mod projection;
pub mod runtime;
pub mod sources;
#[cfg(test)]
mod tests;
use crate::{
    history::live::{
        Failure,
        observation::{Runtime, RuntimeHub},
    },
    native_items::{obj, s},
};
use cantrip_wire::{JsString, Value};
use std::sync::Arc;
pub type Diagnostic = Arc<dyn Fn(Failure, Value) -> anyhow::Result<()> + Send + Sync>;
pub trait ManagedRuntime: Runtime {
    fn generation(&self) -> Option<JsString>;
    fn read_history(&self, thread: JsString) -> cantrip_history::projection::Work<Value>;
}
impl ManagedRuntime for RuntimeHub {
    fn generation(&self) -> Option<JsString> {
        self.hub.generation()
    }
    fn read_history(&self, thread: JsString) -> cantrip_history::projection::Work<Value> {
        (self.read)(thread)
    }
}
#[derive(Clone)]
pub struct Scope {
    pub chat_id: JsString,
    pub thread_id: JsString,
    pub binding_id: JsString,
}
impl Scope {
    pub fn value(&self) -> Value {
        obj([
            ("chatId", s(self.chat_id.clone())),
            ("threadId", s(self.thread_id.clone())),
            ("bindingId", s(self.binding_id.clone())),
        ])
    }
}
#[derive(Clone, Copy)]
pub struct Retry {
    initial: u64,
    maximum: u64,
}
impl Default for Retry {
    fn default() -> Self {
        Self {
            initial: 500,
            maximum: 30_000,
        }
    }
}
impl Retry {
    pub fn new(initial: Option<f64>, maximum: Option<f64>) -> anyhow::Result<Self> {
        let initial = initial.unwrap_or(500.);
        let maximum = maximum.unwrap_or(30_000.);
        if [initial, maximum]
            .iter()
            .any(|v| !v.is_finite() || v.fract() != 0. || *v < 1. || *v > 2147483647.)
            || maximum < initial
        {
            anyhow::bail!("Invalid native history projection retry interval.");
        }
        Ok(Self {
            initial: initial as u64,
            maximum: maximum as u64,
        })
    }
    fn delay(&self, failures: u32) -> u64 {
        self.maximum
            .min(self.initial.saturating_mul(1u64 << failures.min(32)))
    }
}
