use super::*;

impl Adapter {
    pub fn lifetime_for_source(&self, source: &Source) -> Result<Lifetime> {
        source.assert_current()?;
        if let Some(lifetime) = self.cached_source_lifetime(source)? {
            return Ok(lifetime);
        }
        let lifetime = self
            .0
            .runtime
            .create_operation_lifetime(source.operation_id().clone())?;
        let signal = source.signal();
        if signal.check().is_err() {
            lifetime.close();
        }
        let released = source.released();
        let owner = lifetime.clone();
        let watcher = tokio::spawn(async move {
            tokio::select! {
                _ = signal.cancelled() => {},
                _ = released => {},
            }
            owner.close();
        })
        .abort_handle();
        let mut state = self.0.state.lock().unwrap();
        if let Some(existing) = state
            .sources
            .iter()
            .find(|entry| entry.source.matches(source))
        {
            watcher.abort();
            return Ok(existing.lifetime.clone());
        }
        if state.exited {
            watcher.abort();
            bail!("The native inference process has exited.");
        }
        state.sources.push(SourceLifetime {
            source: source.downgrade(),
            lifetime: lifetime.clone(),
            watcher,
        });
        Ok(lifetime)
    }

    fn cached_source_lifetime(&self, source: &Source) -> Result<Option<Lifetime>> {
        let mut state = self.0.state.lock().unwrap();
        state.prune();
        let Some(entry) = state
            .sources
            .iter()
            .find(|entry| entry.source.matches(source))
        else {
            return Ok(None);
        };
        if entry.lifetime.operation_id() != source.operation_id() {
            bail!("Canonical inference source changed operation identity.");
        }
        Ok(Some(entry.lifetime.clone()))
    }

    pub fn acquire(&self, input: Acquire) -> Work<Execution> {
        match self.begin_acquire(input) {
            Ok(work) => work,
            Err(error) => Box::pin(async { Err(error) }),
        }
    }

    fn begin_acquire(&self, input: Acquire) -> Result<Work<Execution>> {
        let life = input
            .lifetime
            .clone()
            .ok_or_else(|| anyhow!("Inference requires its live canonical operation lifetime."))?;
        let identity = input.identity();
        let (complete, pending) = {
            let mut state = self.0.state.lock().unwrap();
            state.prune();
            if state.before.iter().any(|entry| {
                entry
                    .request
                    .lifetime
                    .as_ref()
                    .is_some_and(|held| held.same(&life))
            }) {
                bail!("The canonical source is still preparing before acquisition.");
            }
            if life.runtime_generation() != self.generation()
                || life.operation_id() != &input.operation_id
            {
                bail!("Inference operation lifetime changed owner.");
            }
            if let Some(existing) = state
                .requests
                .iter()
                .find(|memo| memo.lifetime.matches(&life))
            {
                if existing.identity != identity {
                    bail!("Inference operation identity changed during redelivery.");
                }
                return Ok(self.acquire_result(life, existing.result.clone()));
            }
            let (complete, pending) = Promise::pair();
            state.requests.push(Memo {
                lifetime: life.downgrade(),
                identity,
                result: pending.clone(),
                operation: None,
            });
            (complete, pending)
        };
        let operation = input
            .track
            .as_ref()
            .map_or(Ok(()), |track| track(input.operation_id.clone()))
            .and_then(|()| self.request_operation(&input.input, &life));
        match operation {
            Err(error) => complete.finish(Err(error)),
            Ok((operation, ticket)) => {
                let this = self.clone();
                let ready = ticket.ready();
                let on_queued = input.input.on_queued;
                tokio::spawn(async move {
                    let queued_ticket = ticket.clone();
                    let queued_operation = operation.clone();
                    let queued = Promise::spawn(async move {
                        let result = async {
                            queued_ticket.queued().await?;
                            check_signal(queued_operation.input.signal.as_ref())?;
                            if let Some(call) = on_queued {
                                call().await?;
                            }
                            check_signal(queued_operation.input.signal.as_ref())?;
                            queued_operation.state.lock().unwrap().queued = true;
                            Ok(())
                        }
                        .await;
                        result.map_err(|error| {
                            let error = Failure::new(error);
                            queued_ticket.cancel(Some(error.error()));
                            error.error()
                        })
                    });
                    let result = async {
                        let lease = ready.await?;
                        operation.state.lock().unwrap().lease = true;
                        queued.work().await?;
                        lease.signal().check()?;
                        if this.0.state.lock().unwrap().exited
                            || operation.state.lock().unwrap().settled
                        {
                            bail!("The native inference admission was cancelled.");
                        }
                        Ok(())
                    }
                    .await;
                    match result {
                        Ok(()) => complete.finish(Ok(())),
                        Err(error) => {
                            let reason = {
                                let mut state = operation.state.lock().unwrap();
                                state.settled = true;
                                state.withdrawal_reason.clone()
                            };
                            this.0
                                .state
                                .lock()
                                .unwrap()
                                .active
                                .shift_remove(&operation.id);
                            operation.finish.finish(Ok(()));
                            complete.finish(Err(reason.map_or(error, anyhow::Error::new)));
                        }
                    }
                });
            }
        }
        Ok(self.acquire_result(life, pending))
    }

    fn acquire_result(&self, life: Lifetime, pending: Promise<()>) -> Work<Execution> {
        let this = self.clone();
        Box::pin(async move {
            pending.work().await?;
            let operation = this
                .0
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .find(|memo| memo.lifetime.matches(&life))
                .and_then(|memo| memo.operation.clone())
                .ok_or_else(|| anyhow!("The native inference owner is no longer retained."))?;
            let ticket = operation.ticket()?;
            Ok(Execution {
                adapter: this,
                operation,
                ticket,
                life,
            })
        })
    }

    fn request_operation(
        &self,
        input: &Input,
        life: &Lifetime,
    ) -> Result<(Arc<Operation>, Ticket)> {
        if self.0.state.lock().unwrap().exited {
            bail!("The native inference process has exited.");
        }
        let mut provider = json!({"providerId": input.provider_id()});
        if let (Value::Object(fields), Value::Object(supplied)) = (&mut provider, &input.provider) {
            fields.extend(supplied.clone());
        }
        self.0.admission.configure(provider)?;
        let mut request = input.worker_request(life.clone());
        request.initially_suspended |= input
            .chat_id
            .as_ref()
            .and_then(Value::as_js_string)
            .is_some_and(|chat| self.0.state.lock().unwrap().paused.contains(chat));
        let ticket = self.0.runtime.request(request)?;
        let (finish, settlement) = Promise::pair();
        let mut state = self.0.state.lock().unwrap();
        if state.exited {
            drop(state);
            ticket.cancel(None);
            bail!("The native inference process has exited.");
        }
        let mut retained = input.clone();
        retained.track = None;
        retained.on_queued = None;
        let operation = Arc::new(Operation {
            id: state.id(),
            input: retained,
            ticket: ticket.downgrade(),
            settlement,
            finish,
            state: Mutex::new(OperationState {
                thread: input.thread_id.clone(),
                turn: input.expected_turn_id.clone(),
                native_scope: input.native_scope_id.clone(),
                native_boundary: input
                    .native_scope_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty()),
                task_goal_cycle: input
                    .recovery
                    .as_ref()
                    .and_then(|v| v.get("taskGoalCycle"))
                    .cloned(),
                task_input: input
                    .recovery
                    .as_ref()
                    .and_then(|v| v.get("taskInput"))
                    .cloned(),
                ..OperationState::default()
            }),
        });
        state.active.insert(
            operation.id,
            Active {
                operation: operation.clone(),
                _ticket: ticket.clone(),
            },
        );
        let memo = state
            .requests
            .iter_mut()
            .find(|memo| memo.lifetime.matches(life))
            .unwrap();
        memo.operation = Some(operation.clone());
        Ok((operation, ticket))
    }
}

pub(super) fn check_signal(signal: Option<&Signal>) -> Result<()> {
    signal.map_or(Ok(()), Signal::check)
}
