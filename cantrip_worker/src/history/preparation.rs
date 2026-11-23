//! Worker locale policy over the shared canonical history implementation.
use anyhow::{Result, anyhow};
use cantrip_history::{canonical, content::Encryption};
use cantrip_wire::Value;
use icu_collator::{Collator, options::CollatorOptions};
fn collator() -> Result<icu_collator::CollatorBorrowed<'static>> {
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|error| anyhow!("Native history usage sorting locale: {error}"))
}
pub fn usage(thread: &Value, turn: &Value, metadata: &Value) -> Result<Option<Value>> {
    let collator = collator()?;
    canonical::usage_for_turn(thread, turn, metadata, |a, b| {
        collator.compare_utf16_icu4c(a.units(), b.units())
    })
}
pub fn reconcile_usage(
    previous: Option<&Value>,
    incoming: &Value,
) -> Result<(Value, Option<Value>)> {
    let collator = collator()?;
    cantrip_protocol::history::reconcile_usage(previous, incoming, |a, b| {
        collator.compare_utf16_icu4c(a.units(), b.units())
    })
}
pub fn turn(
    service: &dyn Encryption,
    binding: &Value,
    snapshot: &Value,
    turn_id: &Value,
    revision: &Value,
) -> Result<Value> {
    let collator = collator()?;
    canonical::prepare_turn(service, binding, snapshot, turn_id, revision, |a, b| {
        collator.compare_utf16_icu4c(a.units(), b.units())
    })
}
