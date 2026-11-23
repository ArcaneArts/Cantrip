//! Publish actual autonomous Goal turns through the canonical Task outbox.
use super::{Messages, checkpoint::Checkpoint, finish_goal, task_key};
use crate::{
    codex::{preparation::command::Activate, task_inputs},
    encryption::Service,
    history::live::observation::RuntimeHub,
    inference::admission::Promise,
    metadata::Signal,
    outcomes::TaskDelivery,
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, watch};

use super::super::{Emit, Key, output};

pub(in crate::codex) struct GoalCycle {
    pub key: Key,
    pub parent: Option<Value>,
    pub placement: Value,
    pub project: Value,
    pub worktree: Value,
    pub enqueued: watch::Sender<Option<Value>>,
    pub handoff_completed: Option<watch::Receiver<bool>>,
    pub encryption: Arc<Service>,
    pub client: task_inputs::Client,
    pub outcomes: Arc<TaskDelivery>,
    pub observation: Arc<RuntimeHub>,
    pub activate: Activate,
    pub emit: Emit,
    pub reuse_published_response: bool,
    pub previous: AsyncMutex<Promise<()>>,
    pub(in crate::codex::turn) checkpoints: Checkpoints,
}

pub(in crate::codex::turn) struct Checkpoints {
    prompt: Value,
    seed: Value,
    current: Arc<Mutex<Option<Arc<Checkpoint>>>>,
}

impl Checkpoints {
    pub(in crate::codex::turn) fn new(command: &Value) -> Self {
        Self {
            prompt: command["protectedTaskPrompt"].clone(),
            seed: output::continuation_seed(command, command["model"].clone(), None),
            current: Arc::default(),
        }
    }

    fn observe(&self, checkpoint: Arc<Checkpoint>) -> Result<ObservedCheckpoint> {
        let mut current = self.current.lock().unwrap();
        if current.is_some() {
            bail!("A previous autonomous Goal still owns its checkpoint observer.");
        }
        *current = Some(checkpoint);
        Ok(ObservedCheckpoint(self.current.clone()))
    }

    pub(in crate::codex::turn) fn current(&self) -> Option<Arc<Checkpoint>> {
        self.current.lock().unwrap().clone()
    }

    pub(in crate::codex::turn) fn with_current<T>(
        &self,
        expected: &Arc<Checkpoint>,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let current = self.current.lock().unwrap();
        if !current
            .as_ref()
            .is_some_and(|value| Arc::ptr_eq(value, expected))
        {
            bail!("The autonomous Goal checkpoint observer ended or was replaced.");
        }
        operation()
    }
}

struct ObservedCheckpoint(Arc<Mutex<Option<Arc<Checkpoint>>>>);

impl Drop for ObservedCheckpoint {
    fn drop(&mut self) {
        // Only one observer can be installed at a time. Retire it before the
        // terminal outcome releases the next producer.
        self.0.lock().unwrap().take();
    }
}

impl GoalCycle {
    pub fn placement(&self) -> Value {
        self.placement.clone()
    }

    pub fn reusable(&self) -> bool {
        self.handoff_completed
            .as_ref()
            .is_none_or(|completion| *completion.borrow() || completion.has_changed().is_ok())
    }

    pub(in crate::codex::turn) async fn wait_for_enqueue(&self, epoch: &Value) -> Result<Value> {
        let mut updates = self.enqueued.subscribe();
        let queued = updates
            .wait_for(|update| {
                update.as_ref().is_some_and(|queued| {
                    &queued["cycle"]["goalEpoch"] == epoch
                        && ["cycleId", "modelRouteId", "providerAccountId", "orderEpoch"]
                            .iter()
                            .all(|key| queued["cycle"][*key] == self.placement[*key])
                })
            })
            .await?;
        Ok(queued.as_ref().unwrap()["admission"].clone())
    }

    pub async fn dispatch(
        &self,
        input: Value,
        provider: &Value,
        thread: JsString,
        turn: JsString,
        signal: Signal,
        before: impl Future<Output = Result<()>>,
    ) -> Result<()> {
        let mut previous = tokio::select! {
            previous = self.previous.lock() => previous,
            error = signal.cancelled() => return Err(error.into()),
        };
        tokio::select! {
            settled = previous.work() => settled?,
            error = signal.cancelled() => return Err(error.into()),
        }
        tokio::select! {
            result = before => result?,
            error = signal.cancelled() => return Err(error.into()),
        }
        let (owner, server, chat) = &self.key;
        let binding = task_key(&self.encryption, &self.key)?;
        let messages = Arc::new(Messages {
            service: self.encryption.clone(),
            context: json!({"ownerId":owner,"chatId":chat,"keyRevision":binding.component.key_revision}),
            binding,
            mode: "goal",
            output: Mutex::default(),
        });
        let activation = self
            .parent
            .as_ref()
            .map(|parent| (self.activate)(&parent["executionLaneId"]))
            .transpose()?;
        let (observation, mut events, capture) = output::subscribe(&self.observation, &thread)?;
        let reply = match self
            .client
            .authorize_goal_cycle(
                owner,
                server,
                self.parent.as_ref(),
                &self.worktree,
                input,
                signal,
            )
            .await
        {
            Ok(reply) => reply,
            Err(error) => {
                observation.close();
                return Err(error);
            }
        };

        let source = &reply["suspensionSource"];
        let activation = match activation {
            Some(activation) => activation,
            None => (self.activate)(&source["parent"]["executionLaneId"])?,
        };
        let prompt = if self.parent.is_some() {
            &self.checkpoints.prompt
        } else {
            &reply["publicationPrompt"]
        };
        let mut seed = self.checkpoints.seed.clone();
        seed["providerId"] = provider["id"].clone();
        seed["providerKind"] = provider["kind"].clone();
        seed["startedAtMs"] = json!(chrono::Utc::now().timestamp_millis());
        let checkpoint = self.checkpoints.observe(Arc::new(Checkpoint::goal_cycle(
            source.clone(),
            self.project.clone(),
            prompt,
            seed,
            capture,
            messages.clone(),
        )))?;

        let outcomes = self.outcomes.clone();
        let (owner, server) = (owner.clone(), server.clone());
        let emit = messages.events(self.emit.clone());
        let reuse = self.reuse_published_response;
        let source = source.clone();
        *previous = Promise::spawn(async move {
            let transport = observation.signal();
            let settled = output::collect(&mut events, &transport, &thread, &turn, &emit).await;
            drop(checkpoint);
            observation.close();
            drop(activation);
            // A lost observation never proves the native turn failed.
            let settled =
                settled.context("Autonomous Task Goal lost its native terminal observation.")?;
            let outcome = match settled.status {
                "completed" => {
                    let result = finish_goal(
                        &messages,
                        settled.result?,
                        &source["publication"]["id"],
                        &source["publication"]["idempotencyKey"],
                        reuse,
                    )?;
                    json!({"ok":true,"result":result})
                }
                "interrupted" => {
                    json!({"ok":false,"error":"The autonomous Task Goal turn was interrupted."})
                }
                _ => json!({
                    "ok": false,
                    "error": super::failure_message(
                        "The autonomous Task Goal turn failed",
                        settled.result.as_ref().err(),
                    ),
                }),
            };
            outcomes.goal_cycle(&owner, &server, &source, outcome).await
        });
        Ok(())
    }
}
