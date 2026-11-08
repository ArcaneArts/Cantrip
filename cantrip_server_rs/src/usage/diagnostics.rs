//! Account-usage producers share the server's capture, minimization and noise
//! policy. Accounting state remains owned by the meter and background jobs.
use crate::{
    operations::logging::{self, LogCall, Logger},
    wire::{Value, value::json},
};

pub(super) fn started(logger: &Logger, name: &str) {
    if name == "storage-reconciliation" {
        logger(LogCall::event(
            "debug",
            "Account storage reconciliation started",
            json!({"event":"account-usage.storage-reconciliation.started","subsystem":"account-usage","operation":"reconcile-storage","status":"started"}),
        ));
    }
}
fn operation(name: &str) -> &'static str {
    if name == "storage-reconciliation" {
        "reconcile-storage"
    } else {
        "maintain-history"
    }
}
pub(super) fn completed(
    logger: &Logger,
    name: &str,
    acquired: bool,
    result: &serde_json::Value,
    duration: i64,
) {
    let mut context = json!({"event":format!("account-usage.{name}.{}",if acquired {"completed"} else {"lease-unavailable"}),"subsystem":"account-usage","operation":operation(name),"status":if acquired {"completed"} else {"skipped"},"durationMs":duration});
    let message = if name == "storage-reconciliation" {
        context["counts"] = Value::from_serialize(
            &serde_json::json!({"accounts":result["accountCount"],"categories":result["categoryCount"]}),
        );
        context["logicalBytes"] = Value::from_serialize(&result["logicalBytes"]);
        context["rowCount"] = Value::from_serialize(&result["rowCount"]);
        if acquired {
            "Account storage reconciliation completed"
        } else {
            "Account storage reconciliation skipped"
        }
    } else {
        context["counts"] = Value::from_serialize(&serde_json::json!({
            "bandwidthDaysRolled":result["bandwidthDaysRolled"],
            "bandwidthRowsDeleted":result["bandwidthHourlyRowsDeleted"].as_u64().unwrap_or(0)+result["bandwidthDailyRowsDeleted"].as_u64().unwrap_or(0),
            "flushRowsDeleted":result["flushRowsDeleted"],
            "storageDaysRolled":result["storageDaysRolled"],
            "storageRowsDeleted":result["storageHourlyRowsDeleted"].as_u64().unwrap_or(0)+result["storageDailyRowsDeleted"].as_u64().unwrap_or(0)
        }));
        if acquired {
            "Account usage history maintenance completed"
        } else {
            "Account usage history maintenance skipped"
        }
    };
    logger(LogCall::event(
        if acquired { "info" } else { "debug" },
        message,
        context,
    ));
}
pub(super) fn failed(logger: &Logger, name: &str, duration: i64, error: &anyhow::Error) {
    logger(LogCall::event(
        "error",
        if name == "storage-reconciliation" {
            "Account storage reconciliation failed"
        } else {
            "Account usage history maintenance failed"
        },
        json!({"event":format!("account-usage.{name}.failed"),"subsystem":"account-usage","operation":operation(name),"status":"failed","reasonCode":"database-error","durationMs":duration,"error":logging::error_details(error)}),
    ));
}
pub(super) fn observer_failed(logger: &Logger) {
    logger(LogCall::repeated(
        "account-usage-meter-observer-failed".into(),
        "warn",
        "Account bandwidth observer rejected a measurement",
        json!({"event":"account-usage.observer.failed","subsystem":"account-usage","operation":"observe-bandwidth","reasonCode":"observer-failed","status":"degraded"}),
        None,
    ));
}
pub(super) fn capacity_reached(logger: &Logger, entries: usize) {
    logger(LogCall::repeated(
        "account-usage-meter-buffer-full".into(),
        "error",
        "Account usage meter dropped a measurement",
        json!({"event":"account-usage.meter.dropped","subsystem":"account-usage","operation":"record-bandwidth","reasonCode":"buffer-capacity-reached","status":"degraded","bufferedEntries":entries}),
        None,
    ));
}
pub(super) fn flush_failed(logger: &Logger, duration: i64, error: &anyhow::Error) {
    logger(LogCall::repeated(
        "account-usage-bandwidth-flush-failed".into(),
        "error",
        "Account bandwidth usage flush failed",
        json!({"event":"account-usage.bandwidth-flush.failed","subsystem":"account-usage","operation":"flush-bandwidth","reasonCode":"database-write-failed","status":"retrying","durationMs":duration,"error":logging::error_details(error)}),
        None,
    ));
}
pub(super) fn publication_failed(logger: &Logger, error: &anyhow::Error) {
    logger(LogCall::event(
        "warn",
        "Usage live invalidation callback failed",
        json!({"event":"account-usage.live-invalidation.failed","subsystem":"account-usage","operation":"publish-usage-change","reasonCode":"callback-failed","status":"degraded","error":logging::error_details(error)}),
    ));
}
pub(super) fn flushed(
    logger: &Logger,
    applied: bool,
    entries: usize,
    owners: usize,
    duration: i64,
) {
    logger(LogCall::event(
        "debug",
        "Account bandwidth usage flushed",
        json!({"event":"account-usage.bandwidth-flush.completed","subsystem":"account-usage","operation":"flush-bandwidth","status":if applied {"completed"} else {"idempotent-replay"},"durationMs":duration,"counts":json!({"entries":entries,"owners":owners})}),
    ));
}
