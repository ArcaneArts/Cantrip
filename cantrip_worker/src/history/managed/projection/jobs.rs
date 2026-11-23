use super::*;
impl Pump {
    pub(super) async fn drain(&self, entry: Arc<Entry>) {
        let mut initialization = None;
        let mut retry = 0;
        let outcome: Result<()> = async {
            if self.0.state.lock().unwrap().stopped {
                return Ok(());
            }
            if entry.job.lock().unwrap().projection.is_none() {
                let opened = (self.0.options.factory)(
                    entry.source.clone(),
                    entry.scope.clone(),
                    entry.signal.clone(),
                )
                .await?;
                entry.job.lock().unwrap().projection = Some(opened.projection.clone());
                initialization = Some(opened);
            }
            loop {
                let next = {
                    let state = self.0.state.lock().unwrap();
                    let mut job = entry.job.lock().unwrap();
                    if !job.dirty || state.stopped {
                        None
                    } else {
                        job.dirty = false;
                        Some(job.projection.clone().unwrap())
                    }
                };
                let Some(projection) = next else {
                    break;
                };
                projection.drain().await?;
                entry.job.lock().unwrap().failures = 0;
            }
            Ok(())
        }
        .await;
        let active = !self.0.state.lock().unwrap().stopped;
        if let Err(error) = outcome
            && active
        {
            let unavailable = error.downcast_ref::<ServerRequestError>().is_some_and(|e| {
                e.status == 404
                    && e.code.as_ref().is_some_and(|c| {
                        c == &JsString::from("chat-not-found")
                            || c == &JsString::from("binding-not-found")
                    })
            });
            let error = Failure::new(error);
            {
                let mut job = entry.job.lock().unwrap();
                if unavailable {
                    job.unavailable = Some(error.clone());
                    job.dirty = false;
                } else {
                    job.dirty = true;
                    retry = self.0.options.retry.delay(job.failures);
                    job.failures = job.failures.saturating_add(1);
                }
            }
            self.report(error, entry.scope.value(), false);
        }
        drop(initialization);
        entry.job.lock().unwrap().running = false;
        self.schedule(entry, retry);
        self.settle();
    }
    pub(super) async fn recover(&self) {
        let mut failed = false;
        let weak = Arc::downgrade(&self.0);
        let known: cantrip_history::source::Known = Arc::new(move |scope, id| {
            weak.upgrade().is_some_and(|inner| {
                inner
                    .state
                    .lock()
                    .unwrap()
                    .entries
                    .get(&scope.stringify())
                    .is_some_and(|entry| entry.source.journal_id() == id)
            })
        });
        let outcome: Result<()> = async {
            let mut scan = Journal::recover(
                self.0.options.source_directory.clone().unwrap(),
                self.0.options.worker_id.clone(),
                self.0.options.service.clone(),
                self.0.cancel_recovery.clone(),
                Some(known),
            )
            .await?;
            while let Some(found) = scan.next().await? {
                if self.0.state.lock().unwrap().stopped {
                    break;
                }
                let result = found.journal.and_then(|source| {
                    let scope = source.scope();
                    self.accept(
                        source,
                        Scope {
                            chat_id: scope["chatId"].as_js_string().unwrap().clone(),
                            thread_id: scope["threadId"].as_js_string().unwrap().clone(),
                            binding_id: scope["bindingId"].as_js_string().unwrap().clone(),
                        },
                    )
                });
                if let Err(error) = result {
                    failed = true;
                    self.report(
                        Failure::new(error),
                        obj([("journalKey", s(found.key))]),
                        true,
                    );
                }
            }
            Ok(())
        }
        .await;
        let active = !self.0.state.lock().unwrap().stopped;
        if let Err(error) = outcome
            && active
        {
            failed = true;
            self.report(
                Failure::new(error),
                obj([("journalKey", Value::Null)]),
                true,
            );
        }
        let delay = {
            let mut state = self.0.state.lock().unwrap();
            state.recovery_running = false;
            state.recovery_pending = failed && !state.stopped;
            let delay = self.0.options.retry.delay(state.recovery_failures);
            if state.recovery_pending {
                state.recovery_failures = state.recovery_failures.saturating_add(1);
            }
            delay
        };
        self.schedule_recovery(delay);
        self.settle();
    }
}
