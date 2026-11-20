//! Heartbeat and command preferences share the same monotonic account state.
use super::{Helper, process::NativeError, retire};
use crate::http::checked;
use cantrip_wire::{Value, value::json};
use std::time::Duration;
use tokio::{sync::watch, time::timeout};

const DEADLINE: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub(crate) struct Updates(watch::Sender<Value>);

impl Updates {
    pub(super) fn channel() -> (Self, watch::Receiver<Value>) {
        let (send, changes) = watch::channel(json!({
            "revision":0,"configuration":json!({"effect":"off","parameters":json!({})}),
        }));
        (Self(send), changes)
    }

    pub(crate) fn publish(&self, desired: Value) {
        self.0.send_if_modified(|current| {
            if revision(&desired) <= revision(current) {
                return false;
            }
            *current = desired;
            true
        });
    }

    pub(super) async fn status(&self, helper: &mut Option<Helper>) -> Value {
        loop {
            let desired = self.0.borrow().clone();
            let status = synchronize(helper, &desired).await;
            if revision(&desired) == revision(&self.0.borrow()) {
                return status;
            }
        }
    }
}

#[derive(Default)]
pub(super) struct NativeState {
    attempted: u64,
    applied: u64,
}

pub(super) fn needs_update(helper: &Option<Helper>, desired: &Value) -> bool {
    helper
        .as_ref()
        .is_some_and(|helper| helper.effects.attempted < revision(desired))
}

fn revision(value: &Value) -> u64 {
    value["revision"]
        .as_u64()
        .expect("Validated desktop effect revision")
}

pub(super) async fn synchronize(helper: &mut Option<Helper>, desired: &Value) -> Value {
    let revision = revision(desired);
    let status = |state: &str, native: Value, error: Option<&str>| {
        json!({"revision":revision,"configuration":desired["configuration"],
            "state":state,"native":native,"error":error})
    };
    if helper.as_mut().is_some_and(|child| child.process.exited()) {
        retire(helper).await;
    }
    let Some(child) = helper else {
        return status("idle", Value::Null, None);
    };
    child.effects.attempted = revision;
    let operation = if child.effects.applied == revision {
        json!({"operation":"effects.get"})
    } else {
        json!({"operation":"effects.configure","configuration":desired["configuration"]})
    };
    match timeout(DEADLINE, child.process.request(operation)).await {
        Ok(Ok(result)) => match checked(
            "cuaEffectWorkerStatusSchema",
            &status("running", result, None),
        ) {
            Ok(result) => {
                child.effects.applied = revision;
                result
            }
            Err(_) => {
                child.effects.applied = 0;
                status(
                    "failed",
                    Value::Null,
                    Some("Invalid native window effects status."),
                )
            }
        },
        Ok(Err(error)) if error.is::<NativeError>() => {
            child.effects.applied = 0;
            status(
                "failed",
                Value::Null,
                Some("The native helper could not configure window effects."),
            )
        }
        _ => {
            // An incomplete frame invalidates this pipe. A subsequent capture
            // can start its normal helper and reapply the desired revision.
            retire(helper).await;
            status("idle", Value::Null, None)
        }
    }
}
