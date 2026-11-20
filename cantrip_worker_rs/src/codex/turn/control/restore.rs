//! Rebuild a Chat observer after worker loss and resume its original Codex turn.
use super::{Action, Binding, Selection, pause};
use crate::codex::{preparation::command::Prepared, turn::*};
use cantrip_history::content::Encryption;

struct Reservation {
    sessions: Sessions,
    key: Key,
}

enum ReservationResult {
    Join(Promise<Value>),
    Own(Reservation, Complete<Value>),
}

impl Reservation {
    fn acquire(sessions: &Sessions, key: Key, signature: String) -> Result<ReservationResult> {
        let mut state = sessions.lock().unwrap();
        if state.stopping.contains_key(&key) {
            bail!("The saved turn has a pending Stop.");
        }
        if let Some(pending) = state.restoring.get(&key) {
            if pending.signature == signature {
                return Ok(ReservationResult::Join(pending.response.clone()));
            }
            bail!("Another Resume already owns this saved turn.");
        }
        if state
            .active
            .get(&key)
            .is_some_and(|active| !matches!(*active.phase.lock().unwrap(), Phase::Finished))
        {
            bail!("The saved turn already has a local execution owner.");
        }
        let (complete, response) = Promise::pair();
        state.restoring.insert(
            key.clone(),
            PendingSuspension {
                signature,
                response,
            },
        );
        Ok(ReservationResult::Own(
            Self {
                sessions: sessions.clone(),
                key,
            },
            complete,
        ))
    }

    fn install(&self, active: Arc<Active>) -> Owner {
        self.sessions
            .lock()
            .unwrap()
            .active
            .insert(self.key.clone(), active.clone());
        Owner {
            sessions: self.sessions.clone(),
            key: self.key.clone(),
            active,
        }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.sessions.lock().unwrap().restoring.remove(&self.key);
    }
}

impl Turns {
    pub(super) async fn restore_suspension(
        &self,
        command: &Value,
        key: Key,
        signature: String,
        acknowledge: impl FnOnce(Result<Value>) + Send,
    ) -> Result<Value> {
        let (reservation, complete) = match Reservation::acquire(&self.active, key, signature)? {
            ReservationResult::Join(pending) => return pending.work().await,
            ReservationResult::Own(reservation, complete) => (reservation, complete),
        };
        let result = self
            .restore_owned(command, &reservation, |reply| {
                complete.finish(shared(&reply));
                acknowledge(reply);
            })
            .await;
        complete.finish(shared(&result));
        result
    }

    async fn restore_owned(
        &self,
        command: &Value,
        reservation: &Reservation,
        acknowledge: impl FnOnce(Result<Value>) + Send,
    ) -> Result<Value> {
        let key = &reservation.key;
        let (prepared, selected, scope) = self.attach_saved_turn(command, key).await?;
        let runtime = &prepared.runtime;
        let saved = &prepared.saved.as_ref().unwrap().continuation;
        let checkpoint = &command["checkpoint"]["suspension"];
        let thread = selected.thread.clone();
        let turn = selected.turn.clone();
        selected.confirm_held(checkpoint).await?;
        let (receipt, grant) = self.admit_saved_turn(command, &selected, scope).await?;
        let root = receipt.operation();
        let (abort, signal) = Abort::new();
        let binding = Binding::new(
            receipt.session().clone(),
            command["permissionProfileId"].clone(),
            prepared.thread.version(),
        );
        let (subscription, mut events, capture) = output::subscribe(&runtime.history(), &thread)?;
        let transport = subscription.signal();
        binding.restore_capture(capture, output::restored_seed(saved));
        let active = Arc::new(Active {
            root: Some(root.clone()),
            project: receipt.session()["projectId"].as_js_string().cloned(),
            control: OnceLock::from(binding),
            task: OnceLock::new(),
            task_input: None,
            logical_finished: AtomicBool::new(false),
            preparation: abort,
            phase: Mutex::new(Phase::Preparing(Some(thread.clone()))),
            changed: watch::channel(0).0,
        });
        let owner = reservation.install(active.clone());
        let binding = active.control.get().unwrap();
        let source = Source::claimed(root.generation.clone(), Some(signal.clone()));
        let result = async {
            receipt.dispatch().await?;
            let admission = runtime.admission();
            let mut request = Acquire::new(admission.lifetime_for_source(&source)?, command["provider"].clone());
            request.purpose = Some("turn".into());
            request.chat_id = Some(command["chatId"].clone());
            request.project_id = receipt.session().get("projectId").filter(|p| !p.is_null()).cloned();
            request.thread_id = Some(thread.clone());
            request.expected_turn_id = Some(turn.clone());
            request.signal = Some(source.signal());
            request.recovery_key = Some(json!(format!("native-command:{}", root.operation)));
            request.recovery = Some(json!({
                "commandId":root.operation,"commandGeneration":root.generation,
                "threadId":thread,"turnId":turn,
            }));
            let execution = admission.acquire(request).await?;
            let observed = async {
                execution.bind_thread(thread.clone())?;
                execution.bind_turn(turn.clone())?;
                execution.seal_input_dispatch().await?;
                let _mcp = self.preparation.activate(&prepared, &root.lane)?;
                selected.confirm_held(checkpoint).await?;
                prepared.thread.assert_current(runtime)?;
                receipt.applied(&json!({"restored":checkpoint}), Some(&turn)).await?;
                binding.published(true);

                let log_scope = Scope::new(self.encryption.clone())?;
                let scope = receipt.scope();
                scope.identity()?;
                if log_scope.owner != scope.owner || log_scope.server != scope.server {
                    bail!("The worker binding changed during suspension restoration.");
                }
                let identity = (receipt.session()["contextKind"] == "project").then(|| {
                    self.history.capture_outputs(
                        sources::Input {
                            chat_id: key.2.clone(), thread_id: thread.clone(), runtime: runtime.history(),
                            provenance: Some(json!({
                                "kind":"command", "operationId":grant["source"]["operationId"],
                                "operationGeneration":grant["source"]["operationGeneration"],
                            })),
                        },
                        transport.clone(),
                    )
                });
                let protection = protected::Protected::for_native_output(log_scope, command["chatId"].clone());
                let publisher = protection.clone();
                let receipts = self.receipts.clone();
                let operation = root.clone();
                let (emit, published) = protection.publish_with(identity, move |event| {
                    let (receipts, operation, publisher) = (receipts.clone(), operation.clone(), publisher.clone());
                    async move { receipts.event(publisher.scope(), &operation, event).await }
                });

                // Codex can ask for approval as soon as Resume releases the saved turn.
                let mut native_interactions = runtime.interaction_requests(
                    &thread, receipt.session()["contextKind"] == "project" && prepared.environment.is_none())?;
                native_interactions.bind_turn(&turn)?;
                {
                    let _control = binding.pause_control.lock().await;
                    let action = Action::Resume(command);
                    let params = json!({"threadId":thread,"turnId":turn,"paused":false});
                    let control_scope = Scope::new(self.encryption.clone())?;
                    if control_scope.owner != scope.owner || control_scope.server != scope.server {
                        bail!("The worker binding changed before native Resume.");
                    }
                    let control = self.receipts.admit_control(
                        root, control_scope, receipt.session().clone(),
                        &params, &command["permissionProfileId"], action,
                    ).await?;
                    control.dispatch_durable().await?;
                    let start = || {
                        prepared.thread.assert_current(runtime)?;
                        control.scope().identity()?;
                        signal.check()?;
                        execution.dispatched()?;
                        active.set(Phase::Running {
                            runtime: runtime.clone(), thread: thread.clone(), turn: turn.clone(),
                        });
                        Ok::<_, anyhow::Error>(runtime.request(
                            "turn/suspension".into(),
                            Some(json!({"threadId":thread,"operation":json!({"type":"resume","suspension":checkpoint})})),
                            Some(pause::BOUNDARY_TIMEOUT), None,
                        ))
                    };
                    let resume = match start() {
                        Ok(request) => request.await,
                        Err(error) => {
                            let _ = control.settle_durable("rejected", Some(&json!({
                                "error":json!({"code":-32000,"message":"The resumed turn lost its execution owner."})
                            })), None).await;
                            return Err(error);
                        }
                    };
                    if let Err(error) = &resume
                        && error.downcast_ref::<Failure>().is_some_and(|failure| failure.native_error.is_some())
                    {
                        execution.rejected()?;
                        let _ = control.settle_durable("uncertain", None, None).await;
                        bail!("Codex could not resume the saved turn. Its checkpoint has been retained.");
                    }
                    let result = match resume {
                        Ok(Some(reply)) if reply["paused"] == false && &reply["suspension"] == checkpoint => {
                            let settled = control.settle_durable("applied", Some(&json!({"result":reply})), None).await;
                            settled.and_then(|()| pause::result(false, Some(&selected)))
                        }
                        _ => {
                            let _ = control.settle_durable("uncertain", None, None).await;
                            Err(anyhow!("Codex did not confirm that the saved turn resumed."))
                        }
                    };
                    acknowledge(result);
                }

                let collecting = output::collect_restored(&mut events, &transport, &thread, &turn, &emit, saved);
                let terminal = interactions::Turn {
                    runtime, receipt: &receipt, thread: &thread, turn: &turn,
                    thread_version: binding.thread_version, encryption: &self.encryption,
                    emit: &emit, protected: true,
                }.observe(binding, &mut native_interactions.events, collecting).await;
                drop(native_interactions);
                active.set(Phase::Terminal);
                drop(emit);
                if transport.check().is_err() {
                    runtime.retired().await?;
                }
                execution.settled().await?;
                let terminal = terminal?;
                published.await?;
                let result = match terminal.status {
                    "completed" => terminal.result?,
                    "interrupted" => json!({"interrupted":true}),
                    _ => json!({"failed":true}),
                };
                receipt.finish_native(&turn, terminal.status, &result).await?;
                Ok(Value::Null)
            }.await;
            execution.not_dispatched()?;
            observed
        }.await;
        subscription.close();
        source.close();
        active.logical_finished.store(true, Ordering::Relaxed);
        drop(owner);
        result
    }
    pub(super) async fn attach_saved_turn(
        &self,
        command: &Value,
        key: &Key,
    ) -> Result<(Prepared, Selection, Scope)> {
        if command["chatId"] != command["session"]["chatId"] {
            bail!("The saved turn belongs to another chat.");
        }
        let checkpoint = &command["checkpoint"]["suspension"];
        let thread = id(&checkpoint["threadId"], "suspended thread")?;
        let turn = id(&checkpoint["turnId"], "suspended turn")?;
        if command["threadId"].as_js_string() != Some(&thread) {
            bail!("The checkpoint belongs to another native thread.");
        }
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != key.0 || scope.server != key.1 {
            bail!("The worker binding changed before suspension restoration.");
        }
        let mut target = command.clone();
        target["session"]["heldSuspension"] = command["checkpoint"].clone();
        let prepared = if command["type"] == STOP_SUSPENSION {
            self.preparation.prepare_held_stop(&target).await?
        } else {
            self.preparation.prepare(&target, Intent::Preserve).await?
        };
        let saved = &prepared
            .saved
            .as_ref()
            .context("The suspended worker continuation was not opened.")?
            .continuation;
        if saved["threadId"].as_js_string() != Some(&thread)
            || saved["turnId"].as_js_string() != Some(&turn)
            || saved["chatId"] != command["chatId"]
            || saved["cwd"] != command["cwd"]
            || saved["providerId"] != command["provider"]["id"]
            || saved["providerKind"] != command["provider"]["kind"]
            || saved["executionKind"] != "chat"
        {
            bail!("The checkpoint has no compatible worker continuation for this Chat.");
        }
        let runtime = &prepared.runtime;
        let selected = Selection {
            runtime: runtime.clone(),
            thread: thread.clone(),
            turn: turn.clone(),
            thread_version: prepared.thread.version(),
        };
        Ok((prepared, selected, scope))
    }

    pub(super) async fn admit_saved_turn(
        &self,
        command: &Value,
        selected: &Selection,
        scope: Scope,
    ) -> Result<(receipt::Receipt<'_>, Value)> {
        let mut session = crate::codex::preparation::command::native_session(
            command,
            &selected.runtime,
            &selected.thread,
        );
        session["connectionId"] = json!(format!(
            "suspension:{}:{}",
            id(&command["controlId"], "suspension control")?,
            selected.runtime.generation()
        ));
        let (receipt, grant) = self
            .receipts
            .admit_suspension(scope, command, session)
            .await?;
        let execution = self
            .preparation
            .resolve_routing(&grant["execution"])
            .await?;
        autonomous::same_workspace(
            &id(&command["cwd"], "suspended workspace")?,
            &execution["cwd"],
        )
        .await?;
        if !selected.transport_current() {
            bail!("The native runtime changed during suspension admission.");
        }
        Ok((receipt, grant))
    }
}

pub(super) fn shared(result: &Result<Value>) -> Result<Value> {
    result.as_ref().cloned().map_err(|error| anyhow!("{error}"))
}
