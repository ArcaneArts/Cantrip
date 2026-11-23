//! Durable native Goal reconstruction. Original input stays in native history
//! and the canonical queue; provider capacity and FIFO remain worker-owned.
mod admission;
mod fence;
mod receipts;
mod reconcile;
mod retire;
use super::{
    Repository,
    admit::{raw_one, reject, text},
    context,
    managed_queue::deep_equal,
    queue,
    settings_persistence::parse,
};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
pub(super) use admission::{assert_admission, dispatch, record_admission};
use anyhow::Result;
pub(super) use receipts::{confirm_receipt, settle_before_dispatch};

pub(super) async fn read(tx: &Transaction<'_>, chat: &str) -> Result<Option<Value>> {
    let state = raw_one(
        tx,
        "SELECT to_jsonb(s)::text FROM managed_queue_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    state
        .and_then(|s| s.get("goal_recovery").cloned())
        .filter(|v| !v.is_null())
        .map(|v| parse("nativeGoalRecoverySchema", &v))
        .transpose()
}

fn recovered(row: &Value) -> Option<&Value> {
    row.get("goal_recovery_source")
        .filter(|v| !v.is_null())
        .or_else(|| {
            (row["terminal_evidence"]["recoveryKind"] == "managed-goal")
                .then(|| row["terminal_evidence"].get("goalRecovery"))
                .flatten()
        })
}
