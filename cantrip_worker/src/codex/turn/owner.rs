use super::{Active, Key, Owner, Phase, Sessions};
use anyhow::{Result, bail};
use std::sync::{Arc, atomic::Ordering};

impl Owner {
    pub(super) async fn claim(
        sessions: &Sessions,
        key: &Key,
        active: &Arc<Active>,
    ) -> Result<Self> {
        loop {
            let mut changes = {
                let mut entries = sessions.lock().unwrap();
                if entries.restoring.contains_key(key) || entries.stopping.contains_key(key) {
                    bail!("This chat already has an active native turn.");
                }
                if active.root.as_ref().is_some_and(|root| {
                    entries.cancelled.contains(&(
                        key.clone(),
                        root.operation.clone(),
                        root.generation.clone(),
                    ))
                }) {
                    bail!("The GUI request was stopped before native dispatch.");
                }
                if let Some(previous) = entries.active.get(key) {
                    // Core can acknowledge Stop before cancelled GUI preparation
                    // has unwound on the worker. Wait for the exact prior owner to
                    // release its slot before admitting this already queued turn.
                    if active.root.is_none()
                        || previous.root.is_none()
                        || !previous.logical_finished.load(Ordering::Relaxed)
                    {
                        bail!("This chat already has an active native turn.");
                    }
                    let changes = previous.changed.subscribe();
                    if !matches!(*previous.phase.lock().unwrap(), Phase::Preparing(_)) {
                        bail!("This chat already has an active native turn.");
                    }
                    changes
                } else {
                    if let Some(input) = &active.task_input
                        && entries.active.values().any(|owned| {
                            owned.task_input.as_ref().is_some_and(|other| {
                                other.operation() == input.operation()
                                    && !matches!(*owned.phase.lock().unwrap(), Phase::Finished)
                            })
                        })
                    {
                        bail!("The Task input already has a live physical command owner.");
                    }
                    entries.active.insert(key.clone(), active.clone());
                    return Ok(Self {
                        sessions: sessions.clone(),
                        key: key.clone(),
                        active: active.clone(),
                    });
                }
            };
            changes.changed().await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::Abort;
    use cantrip_wire::value::json;
    use std::sync::{Mutex, OnceLock, atomic::AtomicBool};
    use tokio::sync::watch;

    fn gui_turn(operation: &str) -> Arc<Active> {
        let root = super::super::receipt::Operation::for_gui_preparation(&json!({
            "chatId":"chat",
            "nativeCommandReceipt":json!({
                "method":"turn/start","status":"accepted","startsExecution":true,
                "chatId":"chat","operationId":operation,"operationGeneration":"generation",
                "activationGeneration":"activation"
            })
        }))
        .unwrap();
        Arc::new(Active {
            root,
            context: OnceLock::new(),
            project: None,
            control: OnceLock::new(),
            queued_inference: OnceLock::new(),
            task: OnceLock::new(),
            task_input: None,
            logical_finished: AtomicBool::new(false),
            preparation: Abort::new().0,
            phase: Mutex::new(Phase::Preparing(None)),
            changed: watch::channel(0).0,
        })
    }

    #[tokio::test]
    async fn resume_waits_for_cancelled_preparation_to_release_ownership() {
        let sessions = Sessions::default();
        let key = ("owner".into(), "server".into(), "chat".into());
        let stopped = gui_turn("stopped");
        let previous = Owner::claim(&sessions, &key, &stopped).await.unwrap();
        stopped.logical_finished.store(true, Ordering::Relaxed);
        let next = gui_turn("resume");
        let claim = Owner::claim(&sessions, &key, &next);
        tokio::pin!(claim);
        assert!(futures::poll!(&mut claim).is_pending());

        drop(previous);
        let owner = claim.await.unwrap();
        assert!(Arc::ptr_eq(&owner.active, &next));
    }

    #[tokio::test]
    async fn a_gui_turn_does_not_replace_an_active_owner() {
        let sessions = Sessions::default();
        let key = ("owner".into(), "server".into(), "chat".into());
        let active = gui_turn("active");
        let _owner = Owner::claim(&sessions, &key, &active).await.unwrap();

        let result = Owner::claim(&sessions, &key, &gui_turn("other")).await;
        assert!(result.is_err());
    }
}
