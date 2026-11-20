//! Hold an accepted GUI command until Core commits its unused reservation.
use super::{
    super::{Active, Key, Phase},
    Transfer,
};
use crate::{
    codex::{admission::Adapter, managed::Runtime},
    inference::{
        admission::{AdmissionError, Promise, Source},
        withdrawal::Withdrawal,
    },
    metadata::{Guard, Signal},
};
use anyhow::{Result, anyhow, ensure};
use cantrip_history::projection::Work;
use cantrip_wire::{Value, value::json};
use std::sync::{Arc, Mutex, atomic::Ordering};

pub(in crate::codex::turn) struct QueuedInference {
    admission: Adapter,
    source: Source,
    attempt: Mutex<Option<Attempt>>,
}

struct Attempt {
    handoff: Value,
    proof: Promise<Value>,
    withdrawal: Withdrawal,
}

#[derive(Debug)]
pub(super) struct SourceUnavailable;

impl std::fmt::Display for SourceUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The original inference reservation is no longer unused.")
    }
}

impl std::error::Error for SourceUnavailable {}

impl QueuedInference {
    pub(in crate::codex::turn) fn new(admission: Adapter, source: Source) -> Self {
        Self {
            admission,
            source,
            attempt: Mutex::default(),
        }
    }

    fn begin(&self, handoff: &Value, existing_only: bool) -> Result<Work<Value>> {
        let mut attempt = self.attempt.lock().unwrap();
        if let Some(current) = attempt.as_ref() {
            ensure!(
                current.handoff == *handoff,
                "Another handoff owns this queued input."
            );
            return Ok(current.proof.work());
        }
        if existing_only {
            return Err(SourceUnavailable.into());
        }
        let withdrawal = Withdrawal::new();
        let proof = self
            .admission
            .withdraw_unstarted(&self.source, Some(withdrawal.clone().into()))
            .map_err(|error| {
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<AdmissionError>()
                        .is_some_and(|error| error.unstarted_unavailable)
                }) {
                    SourceUnavailable.into()
                } else {
                    error
                }
            })?;
        let proof = Promise::spawn(proof);
        let pending = proof.work();
        *attempt = Some(Attempt {
            handoff: handoff.clone(),
            proof,
            withdrawal,
        });
        Ok(pending)
    }

    /// A wrapped admission failure can race with the provider grant. The local
    /// reservation tracks the successful seal even if acquire already returned.
    async fn await_deferral(&self, runtime: &Runtime, signal: &Signal) -> bool {
        let pending = self
            .attempt
            .lock()
            .unwrap()
            .as_ref()
            .map(|attempt| attempt.withdrawal.clone());
        let Some(withdrawal) = pending else {
            return false;
        };
        tokio::select! {
            biased;
            result = withdrawal.wait(Some(signal.clone())) => result.is_ok(),
            _ = runtime.retired() => false,
        }
    }

    fn acknowledge(&self, handoff: &Value) -> bool {
        let attempt = self.attempt.lock().unwrap();
        if let Some(attempt) = attempt
            .as_ref()
            .filter(|attempt| &attempt.handoff == handoff)
        {
            attempt.withdrawal.acknowledge();
            return true;
        }
        false
    }
}

impl Active {
    pub(in crate::codex::turn) async fn finish_withdrawal(
        &self,
        runtime: &Runtime,
        signal: &Signal,
    ) -> Option<anyhow::Error> {
        if self
            .queued_inference
            .get()?
            .await_deferral(runtime, signal)
            .await
        {
            Some(
                crate::encryption::ServiceError::new(
                    "worker-inference-deferred",
                    "The unused input was deferred for a runtime handoff.",
                )
                .into(),
            )
        } else {
            None
        }
    }
}

impl Transfer {
    fn active_input(&self, state: &Value) -> Result<Option<(Key, Arc<Active>)>> {
        let chat = super::id(&state["chatId"], "handoff chat")?;
        let key = (
            self.identity.owner.clone(),
            self.identity.server.clone(),
            chat,
        );
        let active = self.turns.active.lock().unwrap().active.get(&key).cloned();
        Ok(active
            .filter(|active| {
                let source = state
                    .get("binding")
                    .filter(|binding| !binding.is_null())
                    .unwrap_or(&state["source"]);
                active.root.as_ref().is_some_and(|root| {
                    state["queuedSource"]["operationId"].as_js_string() == Some(&root.operation)
                        && state["queuedSource"]["operationGeneration"].as_js_string()
                            == Some(&root.generation)
                }) && active.control.get().is_some_and(|control| {
                    control.matches(&json!({
                        "threadId":source["threadId"],
                        "nativeRuntimeGeneration":source["runtimeGeneration"],
                        "modelRouteId":source["modelRouteId"],
                        "providerAccountId":source["providerAccountId"],
                    }))
                })
            })
            .map(|active| (key, active)))
    }

    pub(super) async fn capture_withdrawal(&self, state: &Value) -> Result<Option<Value>> {
        self.check()?;
        let manager = self
            .worker
            .inference_manager(&self.identity.owner, &self.identity.server)?;
        let mut expected = state["queuedSource"].clone();
        expected["chatId"] = state["chatId"].clone();
        if let Some((_, active)) = self.active_input(state)?
            && let Some(queued) = active.queued_inference.get()
        {
            match queued.begin(&state["operationId"], state["cancelRequested"] == true) {
                Ok(proof) => return proof.await.map(Some),
                Err(refusal) => {
                    // The proof may have survived the adapter that originally
                    // accepted it. Only a synchronous refusal can decline.
                    return manager
                        .withdrawal_record(expected)
                        .await?
                        .map_or(Err(refusal), |record| Ok(Some(record)));
                }
            }
        }
        manager.withdrawal_record(expected).await
    }

    pub(super) async fn acknowledge_withdrawal(&self, state: &Value) -> Result<()> {
        self.check()?;
        let Some((key, active)) = self.active_input(state)? else {
            return Ok(());
        };
        if !active
            .queued_inference
            .get()
            .is_some_and(|queued| queued.acknowledge(&state["operationId"]))
        {
            return Ok(());
        }
        active.logical_finished.store(true, Ordering::Relaxed);
        let mut changes = active.changed.subscribe();
        Guard::request(Some(self.signal.clone()))
            .run(async {
                loop {
                    if matches!(*active.phase.lock().unwrap(), Phase::Finished) {
                        return Ok(());
                    }
                    changes
                        .changed()
                        .await
                        .map_err(|_| anyhow!("The withdrawn command lost its settlement."))?;
                }
            })
            .await?;
        let mut sessions = self.turns.active.lock().unwrap();
        if sessions
            .active
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &active))
        {
            sessions.active.remove(&key);
        }
        Ok(())
    }
}

pub(super) fn is_gui(state: &Value) -> bool {
    let queued = &state["queuedSource"];
    queued.is_object()
        && ["autonomousAttempt", "goalRecovery", "taskGoal"]
            .iter()
            .all(|field| queued[*field].is_null())
}
