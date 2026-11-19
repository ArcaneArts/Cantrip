//! One revisioned Task admission control per authenticated chat.
use super::preparation::native::LoadedThread;
use crate::metadata::Signal;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value};
use tokio::sync::{Mutex as AsyncMutex, watch};

#[derive(Clone, Default)]
pub(in crate::codex) struct Desired {
    pub intent: Option<Value>,
    pub blocked: bool,
    order_epoch: u64,
}

pub(in crate::codex) struct Latch {
    desired: watch::Sender<Desired>,
    pub applied: AsyncMutex<Option<Applied>>,
}

pub(super) struct Applied {
    pub intent: Value,
    pub thread: LoadedThread,
    pub runner: JsString,
    pub binding: Value,
}

impl Default for Latch {
    fn default() -> Self {
        Self {
            desired: watch::channel(Desired::default()).0,
            applied: AsyncMutex::new(None),
        }
    }
}

impl Latch {
    pub fn record(&self, input: Value) -> Result<()> {
        let mut conflict = false;
        self.desired.send_if_modified(|current| {
            let scope = &input["scope"];
            let epoch = scope["orderEpoch"].as_u64();
            let mut order_epoch = epoch.unwrap_or(0);
            if let Some(prior) = &current.intent {
                let prior_scope = &prior["scope"];
                if prior_scope["revision"].as_u64() > scope["revision"].as_u64()
                    || (prior_scope["revision"] == scope["revision"]
                        && prior_scope["orderEpoch"].as_u64() > epoch)
                {
                    return false;
                }
                if prior_scope["revision"] == scope["revision"]
                    && prior["paused"] != input["paused"]
                {
                    conflict = true;
                    return false;
                }
                if prior == &input {
                    return false;
                }
                if same_placement(scope, prior_scope)
                    && ["cycleId", "modelRouteId", "providerAccountId"]
                        .iter()
                        .all(|key| scope[*key] == prior_scope[*key])
                {
                    order_epoch = order_epoch.max(current.order_epoch);
                }
            }
            current.blocked |= input["paused"] == true;
            current.order_epoch = order_epoch;
            current.intent = Some(input);
            true
        });
        if conflict {
            bail!("The Task pause revision changed its intent.");
        }
        Ok(())
    }

    pub fn current(&self) -> Desired {
        self.desired.borrow().clone()
    }

    pub fn applied(&self, intent: &Value) -> bool {
        let mut current_intent = false;
        self.desired.send_if_modified(|desired| {
            current_intent = desired.intent.as_ref() == Some(intent);
            let blocked = intent["paused"] == true;
            if current_intent && desired.blocked != blocked {
                desired.blocked = blocked;
                true
            } else {
                false
            }
        });
        current_intent
    }

    pub fn order_epoch(&self, binding: &Value, cycle: &Value) -> u64 {
        let desired = self.desired.borrow();
        desired
            .intent
            .as_ref()
            .filter(|intent| {
                same_placement(binding, &intent["scope"])
                    && intent["scope"]["cycleId"] == *cycle
                    && (intent["scope"]["threadId"].is_null()
                        || binding["threadId"] == intent["scope"]["threadId"])
                    && binding["modelRouteId"] == intent["scope"]["modelRouteId"]
                    && binding["providerAccountId"] == intent["scope"]["providerAccountId"]
            })
            .map_or(0, |_| desired.order_epoch)
    }

    pub async fn wait(&self, signal: &Signal) -> Result<()> {
        let mut desired = self.desired.subscribe();
        while desired.borrow_and_update().blocked {
            tokio::select! {
                update = desired.changed() => update?,
                error = signal.cancelled() => return Err(error.into()),
            }
        }
        signal.check()
    }
}

fn same_placement(left: &Value, right: &Value) -> bool {
    ["workerId", "projectId", "worktreeId"]
        .iter()
        .all(|key| left[*key] == right[*key])
}

#[derive(Clone)]
pub(super) struct Root {
    pub runner: JsString,
    pub binding: Value,
    pub latch: std::sync::Arc<Latch>,
}

impl Root {
    pub fn matches_placement(&self, scope: &Value) -> bool {
        same_placement(&self.binding, scope)
    }

    pub fn matches(&self, scope: &Value) -> bool {
        let binding = &self.binding;
        same_placement(binding, scope)
            && (scope["threadId"].is_null() || scope["threadId"] == binding["threadId"])
            && (binding["cycleId"].is_null()
                || (binding["cycleId"] == scope["cycleId"]
                    && binding["modelRouteId"] == scope["modelRouteId"]
                    && binding["providerAccountId"] == scope["providerAccountId"]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::Abort;
    use cantrip_wire::value::json;
    use futures::FutureExt;

    fn intent(revision: u64, paused: bool, epoch: Option<u64>) -> Value {
        let mut scope = json!({
            "revision":revision, "workerId":"worker", "projectId":"project", "worktreeId":"tree",
            "threadId":"thread", "cycleId":"cycle", "modelRouteId":"route", "providerAccountId":Value::Null,
        });
        if let Some(epoch) = epoch {
            scope["orderEpoch"] = json!(epoch);
        }
        json!({"paused":paused,"scope":scope})
    }

    #[tokio::test]
    async fn resume_waits_for_the_current_receipt_and_retains_the_task_order() -> Result<()> {
        let latch = Latch::default();
        let (abort, signal) = Abort::new();
        let pause = intent(4, true, Some(7));
        latch.record(pause.clone())?;
        latch.record(intent(3, false, Some(30)))?;
        assert!(latch.record(intent(4, false, Some(7))).is_err());
        assert!(latch.current().blocked);
        assert!(latch.applied(&pause));
        let resume = intent(5, false, None);
        latch.record(resume.clone())?;
        assert!(!latch.applied(&pause));
        assert!(latch.wait(&signal).now_or_never().is_none());
        assert_eq!(latch.order_epoch(&resume["scope"], &json!("cycle")), 7);
        assert_eq!(latch.order_epoch(&resume["scope"], &json!("different")), 0);
        assert!(latch.applied(&resume));
        latch.wait(&signal).await?;

        latch.record(intent(6, true, None))?;
        abort.abort(anyhow::anyhow!("Retired private gate."));
        assert!(latch.wait(&signal).await.is_err());
        Ok(())
    }
}
