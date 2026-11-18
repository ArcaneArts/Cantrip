//! Publish actual autonomous Goal turns through the canonical Task outbox.
use super::{Messages, finish_goal, task_key};
use crate::{
    codex::{preparation::command::Activate, task_inputs},
    encryption::Service,
    history::live::observation::RuntimeHub,
    inference::admission::Promise,
    metadata::Signal,
    outcomes::TaskDelivery,
};
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;

use super::super::{Emit, Key, output};

pub(in crate::codex) struct GoalCycle {
    pub parent: Value,
    pub project: Value,
    pub encryption: Arc<Service>,
    pub key: Key,
    pub client: task_inputs::Client,
    pub outcomes: Arc<TaskDelivery>,
    pub observation: Arc<RuntimeHub>,
    pub activate: Activate,
    pub emit: Emit,
    pub reuse_published_response: bool,
    pub previous: AsyncMutex<Promise<()>>,
}

impl GoalCycle {
    pub fn placement(&self) -> Value {
        json!({
            "cycleId":self.parent["dispatch"]["cycleId"], "modelRouteId":self.parent["modelRouteId"],
            "providerAccountId":self.parent["providerAccountId"], "orderEpoch":self.parent["queueOrderEpoch"].as_u64().unwrap_or(0),
        })
    }

    pub async fn dispatch(
        &self,
        input: Value,
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
        let activation = (self.activate)()?;
        let (observation, mut events) = output::subscribe(&self.observation, &thread)?;
        let source = match self
            .client
            .authorize_goal_cycle(owner, server, &self.parent, input, signal)
            .await
        {
            Ok(source) => source,
            Err(error) => {
                observation.close();
                return Err(error);
            }
        };

        let outcomes = self.outcomes.clone();
        let (owner, server) = (owner.clone(), server.clone());
        let emit = messages.events(self.emit.clone());
        let reuse = self.reuse_published_response;
        *previous = Promise::spawn(async move {
            let transport = observation.signal();
            let settled = output::collect(&mut events, &transport, &thread, &turn, &emit).await;
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
                _ => json!({"ok":false,"error":"The autonomous Task Goal turn failed."}),
            };
            outcomes.goal_cycle(&owner, &server, &source, outcome).await
        });
        Ok(())
    }
}
