use super::*;
impl Capture {
    pub(super) async fn fire(&self, kind: Kind, id: u64) {
        let (revision, record) = {
            let mut state = self.0.state.lock().unwrap();
            if state.timers[kind as usize]
                .as_ref()
                .is_none_or(|v| v.id != id)
            {
                return;
            }
            state.timers[kind as usize] = None;
            if state.stopped {
                return;
            }
            match kind {
                Kind::Read => {
                    if !state.observing || state.reading {
                        return;
                    }
                    state.reading = true;
                    state.dirty = false;
                }
                Kind::Write => {
                    if state.writing {
                        return;
                    }
                    state.writing = true;
                }
                Kind::Notify => {
                    if state.notifying || state.notification.is_none() {
                        return;
                    }
                    state.notifying = true;
                }
            }
            (state.revision, state.notification.clone())
        };
        match kind {
            Kind::Read => self.read(revision).await,
            Kind::Write => self.write().await,
            Kind::Notify => self.notify(record.unwrap()).await,
        }
    }
    async fn read(&self, revision: u64) {
        let result = self.subscription().read_snapshot().await;
        let mut delay = self.0.options.timing.snapshot;
        match result {
            Ok(frame) => {
                let mut state = self.0.state.lock().unwrap();
                if state.observing && !state.stopped {
                    if state.awaiting_context.as_ref().is_some_and(|turn| {
                        frame["snapshot"]["history"]["turns"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|entry| {
                                entry["turnId"].as_js_string() == Some(turn)
                                    && entry["contexts"]
                                        .as_array()
                                        .is_some_and(|entries| !entries.is_empty())
                            })
                    }) {
                        state.awaiting_context = None;
                    }
                    let gap = state.cursors.snapshot(&frame);
                    state.pending.push_back(Pending {
                        frame,
                        revision: Some(revision),
                    });
                    if gap {
                        state.dirty = true;
                        state.read_failures = state.read_failures.saturating_add(1);
                        delay = self.0.options.timing.delay(state.read_failures);
                    } else {
                        state.read_failures = 0;
                    }
                }
            }
            Err(error) => {
                let active = {
                    let state = self.0.state.lock().unwrap();
                    state.observing && !state.stopped
                };
                if active {
                    self.report(Failure::new(error), Phase::Snapshot);
                    let mut state = self.0.state.lock().unwrap();
                    state.dirty = true;
                    state.read_failures = state.read_failures.saturating_add(1);
                    delay = self.0.options.timing.delay(state.read_failures);
                }
            }
        }
        self.0.state.lock().unwrap().reading = false;
        self.schedule(Kind::Write, 0);
        self.schedule(Kind::Read, delay);
        self.0.state.lock().unwrap().check_flushed();
    }
    async fn write(&self) {
        let mut delay = 0;
        loop {
            let frame = {
                let state = self.0.state.lock().unwrap();
                if state.stopped {
                    break;
                }
                state.pending.front().map(|v| v.frame.clone())
            };
            let Some(frame) = frame else {
                break;
            };
            match (self.0.options.append)(frame).await {
                Ok(record) => {
                    {
                        let mut state = self.0.state.lock().unwrap();
                        let entry = state.pending.pop_front().unwrap();
                        state.write_failures = 0;
                        if let Some(revision) = entry.revision {
                            let mut remaining = Vec::new();
                            for (requested, waiter) in state.snapshots.drain(..) {
                                if requested <= revision {
                                    let _ = waiter.send(Ok(Snapshot {
                                        observation: entry.frame.clone(),
                                        record: record.clone(),
                                    }));
                                } else {
                                    remaining.push((requested, waiter));
                                }
                            }
                            state.snapshots = remaining;
                        }
                        if !state.stopped && self.0.options.on_persisted.is_some() {
                            state.notification = Some(Arc::new(record));
                        }
                    }
                    self.schedule(Kind::Notify, 0);
                }
                Err(error) => {
                    if !self.0.state.lock().unwrap().stopped {
                        self.report(Failure::new(error), Phase::Append);
                        let mut state = self.0.state.lock().unwrap();
                        state.write_failures = state.write_failures.saturating_add(1);
                        delay = self.0.options.timing.delay(state.write_failures);
                    }
                    break;
                }
            }
        }
        self.0.state.lock().unwrap().writing = false;
        self.schedule(Kind::Write, delay);
        self.0.state.lock().unwrap().check_flushed();
    }
    async fn notify(&self, record: Arc<Value>) {
        let result = self.0.options.on_persisted.as_ref().unwrap()(record.as_ref().clone()).await;
        let mut delay = 0;
        match result {
            Ok(()) => {
                let mut state = self.0.state.lock().unwrap();
                if state
                    .notification
                    .as_ref()
                    .is_some_and(|v| Arc::ptr_eq(v, &record))
                {
                    state.notification = None;
                }
                state.notify_failures = 0;
            }
            Err(error) => {
                if !self.0.state.lock().unwrap().stopped {
                    self.report(Failure::new(error), Phase::Notify);
                    let mut state = self.0.state.lock().unwrap();
                    state.notify_failures = state.notify_failures.saturating_add(1);
                    delay = self.0.options.timing.delay(state.notify_failures);
                }
            }
        }
        self.0.state.lock().unwrap().notifying = false;
        self.schedule(Kind::Notify, delay);
        self.0.state.lock().unwrap().check_flushed();
    }
}
