use super::execution::{changed, undispatched_outcome};
use super::*;

impl Adapter {
    pub fn set_chat_paused(&self, chat: &JsString, paused: bool) -> Result<()> {
        {
            let mut state = self.0.state.lock().unwrap();
            if paused {
                state.paused.insert(chat.clone());
            } else {
                state.paused.remove(chat);
            }
        }
        for operation in self.chat_operations(chat) {
            let ticket = operation.ticket()?;
            if paused {
                let hold = can_hold(&operation.state.lock().unwrap());
                ticket.pause_waiting(hold);
            } else {
                ticket.resume_waiting()?;
            }
        }
        Ok(())
    }

    pub fn can_hold_unstarted_chat(&self, chat: &JsString, require_source: bool) -> bool {
        let operations = self.chat_operations(chat);
        (!require_source || !operations.is_empty())
            && operations
                .iter()
                .all(|operation| can_hold(&operation.state.lock().unwrap()))
    }

    pub fn confirm_chat_hold(&self, chat: &JsString) -> Work<()> {
        let holds = self
            .chat_operations(chat)
            .into_iter()
            .map(|operation| operation.ticket().map(|ticket| ticket.confirm_pause()))
            .collect::<Result<Vec<_>>>();
        Box::pin(async move {
            futures::future::try_join_all(holds?).await?;
            Ok(())
        })
    }

    pub(super) fn chat_operations(&self, chat: &JsString) -> Vec<Arc<Operation>> {
        self.active()
            .into_iter()
            .filter(|operation| {
                operation
                    .input
                    .chat_id
                    .as_ref()
                    .and_then(Value::as_js_string)
                    == Some(chat)
                    && !operation.state.lock().unwrap().settled
            })
            .collect()
    }

    pub fn cancel_waiting(&self, chat: &JsString) -> Result<bool> {
        let preparations = self.0.state.lock().unwrap().before.clone();
        let mut cancelled = false;
        for entry in preparations {
            if entry.request.chat_id.as_ref().and_then(Value::as_js_string) != Some(chat) {
                continue;
            }
            let reason = entry
                .reason
                .lock()
                .unwrap()
                .get_or_insert_with(|| {
                    Failure::new(anyhow!(
                        "The turn was interrupted before response admission."
                    ))
                })
                .clone();
            entry.request.lifetime.as_ref().unwrap().close();
            entry.abort.abort(reason.error());
            cancelled = true;
        }
        for operation in self.chat_operations(chat) {
            let (dispatched, outcome) = cancellation_state(&operation);
            if dispatched {
                continue;
            }
            operation.ticket()?.cancel(None);
            if let Some(outcome) = outcome {
                self.settle(&operation, outcome)?;
            }
            cancelled = true;
        }
        Ok(cancelled)
    }

    pub fn revoke(&self, chats: &HashSet<JsString>, operations: &HashSet<JsString>) -> Result<()> {
        for operation in self.active() {
            if !operation
                .input
                .chat_id
                .as_ref()
                .and_then(Value::as_js_string)
                .is_some_and(|chat| chats.contains(chat))
                && !operations.contains(&operation.input.operation_id)
            {
                continue;
            }
            {
                let mut state = operation.state.lock().unwrap();
                if state.settled {
                    continue;
                }
                state.revoked = true;
            }
            let (_, outcome) = cancellation_state(&operation);
            operation
                .ticket()?
                .cancel(Some(anyhow!("The inference resource was removed.")));
            if let Some(outcome) = outcome {
                self.settle(&operation, outcome)?;
            } else {
                self.notify_revocation(&operation)?;
            }
        }
        Ok(())
    }

    pub fn observation_lost(&self) -> Result<()> {
        for operation in self.active() {
            let (dispatched, outcome) = cancellation_state(&operation);
            if dispatched {
                continue;
            }
            operation.ticket()?.cancel(Some(anyhow!(
                "Native transport disconnected before inference dispatch."
            )));
            if let Some(outcome) = outcome {
                self.settle(&operation, outcome)?;
            }
        }
        Ok(())
    }

    /// Call only on the managed process's confirmed exit event.
    pub fn process_exited(&self) -> Work<()> {
        let (complete, pending) = {
            let mut state = self.0.state.lock().unwrap();
            if let Some(retirement) = &state.retirement {
                return retirement.work();
            }
            state.exited = true;
            let (complete, pending) = Promise::pair();
            state.retirement = Some(pending.clone());
            (complete, pending)
        };
        let fence = self.0.runtime.exited();
        let this = self.clone();
        tokio::spawn(async move {
            let result = fence.await;
            if result.is_ok() {
                let (operations, entries, sources) = {
                    let mut state = this.0.state.lock().unwrap();
                    state.completed.clear();
                    (
                        std::mem::take(&mut state.active),
                        std::mem::take(&mut state.native),
                        state
                            .sources
                            .iter()
                            .map(|entry| (entry.watcher.clone(), entry.lifetime.clone()))
                            .collect::<Vec<_>>(),
                    )
                };
                for (_, active) in operations {
                    let ended = {
                        let mut state = active.operation.state.lock().unwrap();
                        state.settled = true;
                        state.preparation_ended.take()
                    };
                    active.operation.finish.finish(Ok(()));
                    if let Some(ended) = ended {
                        ended.finish(Ok(()));
                    }
                }
                for (_, entry) in entries {
                    let life = entry.state.lock().unwrap().lifetime.take();
                    if let Some(life) = life {
                        life.close();
                    }
                }
                for (watcher, lifetime) in sources {
                    watcher.abort();
                    lifetime.close();
                }
            }
            complete.finish(result);
        });
        pending.work()
    }

    pub fn observe(&self, method: &str, params: &Value) -> Result<()> {
        if !matches!(method, "turn/started" | "turn/completed") {
            return Ok(());
        }
        let (Some(thread), Some(turn)) = (
            params["threadId"].as_js_string(),
            params["turn"]["id"].as_js_string(),
        ) else {
            return Ok(());
        };
        if method == "turn/started" {
            let candidates = self
                .active()
                .into_iter()
                .filter(|operation| {
                    let state = operation.state.lock().unwrap();
                    state.dispatched
                        && state.thread.as_ref() == Some(thread)
                        && !changed(&state.turn, turn)
                })
                .collect::<Vec<_>>();
            if let [operation] = candidates.as_slice() {
                operation.state.lock().unwrap().observed_start = true;
                self.bind_turn(operation, turn.clone())?;
            }
            return Ok(());
        }
        let status = coercion::string(&params["turn"]["status"]).ok();
        if !matches!(
            status.as_ref().and_then(JsString::as_str),
            Some("completed" | "failed" | "interrupted")
        ) {
            return Ok(());
        }
        self.remember_completed(thread, turn, None);
        for operation in self.active() {
            self.reconcile(&operation)?;
        }
        Ok(())
    }

    pub(super) fn remember_completed(
        &self,
        thread: &JsString,
        turn: &JsString,
        scope: Option<&JsString>,
    ) {
        let key = key(thread, turn, scope);
        let entry = {
            let mut state = self.0.state.lock().unwrap();
            let entry = state.native.shift_remove(&key);
            state.completed.insert(key);
            if state.completed.len() > 512 {
                state.completed.shift_remove_index(0);
            }
            entry
        };
        if let Some(entry) = entry {
            let life = entry.state.lock().unwrap().lifetime.clone();
            if let Some(life) = life {
                life.close();
            }
        }
    }

    pub(super) fn bind_turn(&self, operation: &Arc<Operation>, turn: JsString) -> Result<()> {
        {
            let mut state = operation.state.lock().unwrap();
            if changed(&state.turn, &turn) {
                bail!("Inference admission received a different native turn identity.");
            }
            state.turn = Some(turn);
        }
        self.notify_revocation(operation)?;
        self.reconcile(operation)
    }

    pub(super) fn reconcile(&self, operation: &Arc<Operation>) -> Result<()> {
        let candidate = {
            let state = operation.state.lock().unwrap();
            if !state.dispatched || state.native_boundary {
                return Ok(());
            }
            state
                .thread
                .as_ref()
                .zip(state.turn.as_ref())
                .map(|(thread, turn)| key(thread, turn, None))
        };
        let Some(candidate) = candidate else {
            return Ok(());
        };
        if !self.0.state.lock().unwrap().completed.contains(&candidate) {
            return Ok(());
        }
        self.settle_if(operation, Outcome::Completed, |state| {
            state.dispatched
                && !state.native_boundary
                && state
                    .thread
                    .as_ref()
                    .zip(state.turn.as_ref())
                    .is_some_and(|(thread, turn)| key(thread, turn, None) == candidate)
        })
    }
}

fn can_hold(state: &OperationState) -> bool {
    !state.dispatched
        && !state.input_dispatching
        && !state.preparing
        && !state.lease_started
        && !state.native_boundary
        && !state.starting
        && !state.transferring
        && state.turn.as_ref().is_none_or(JsString::is_empty)
}

fn cancellation_state(operation: &Operation) -> (bool, Option<Outcome>) {
    let state = operation.state.lock().unwrap();
    let outcome = (!state.dispatched && !state.preparing && !state.starting && !state.settled)
        .then(|| undispatched_outcome(&state));
    (state.dispatched, outcome)
}
