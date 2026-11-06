use super::*;
fn error(message: String) -> CommandError {
    CommandError {
        message: message.into(),
        code: None,
        unavailable: false,
        request_id: None,
        encoding_error: None,
        inference: None,
    }
}
fn inference(options: &RequestOptions, event: &Value) {
    if event.get("timing").is_some()
        && let Some(observer) = &options.on_inference
    {
        let mut value = json!({"timing":event["timing"],"sequence":event["sequence"]});
        if let Some(provider) = event.get("providerTimings") {
            value["providerTimings"] = provider.clone();
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(value)));
    }
}
fn code(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    if s.len() <= 100
        && s.split('-').all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    {
        Some(s.into())
    } else {
        None
    }
}
fn message(value: Option<&Value>, fallback: &str) -> wire::JsString {
    value
        .filter(|v| !v.is_null())
        .and_then(|v| wire::coercion::string(v).ok())
        .unwrap_or_else(|| fallback.into())
}
// Nullish fallback does not coerce strings, booleans or objects. The
// coordinator's Number.isFinite-equivalent check must reject those values.
fn freshness(request: &Value) -> f64 {
    match request.get("timeoutMs") {
        None | Some(Value::Null) => 86_400_000.0,
        Some(Value::Number(value)) => *value,
        _ => f64::NAN,
    }
}
impl CoordinatedBridge {
    pub fn request(
        self: &Arc<Self>,
        worker: &str,
        command: Value,
        options: RequestOptions,
    ) -> BoxFuture<'static, Outcome> {
        let this = self.clone();
        let worker = worker.to_owned();
        own(async move {
            if this.state.lock().unwrap().connections.contains_key(&worker) {
                let callback = options.on_event.clone();
                let observed = options.clone();
                let on_event: EventHandler = Arc::new(move |event| {
                    let callback = callback.clone();
                    if event["type"] == "inference.command-state" {
                        inference(&observed, &event);
                        if !observed.forward_inference && event["admitted"] != true {
                            return Box::pin(async { Ok(()) });
                        }
                    }
                    Box::pin(async move {
                        if let Some(callback) = callback {
                            callback(event).await?;
                        }
                        Ok(())
                    })
                });
                return this
                    .local
                    .request(&worker, command, options.timeout, Some(on_event))
                    .await;
            }
            this.request_remote(worker, command, options).await
        })
    }
    async fn request_remote(
        self: Arc<Self>,
        worker: String,
        command: Value,
        mut options: RequestOptions,
    ) -> Outcome {
        if self.state.lock().unwrap().pending.len() >= 2048 {
            self.state.lock().unwrap().failed += 1;
            self.repeat("coordination-command-queue-full".into(),"warn","Shared worker command queue is full",json!({"event":"coordination.command.rejected","subsystem":"relay-coordination","operation":command["type"],"reasonCode":"queue-full","status":"rejected","workerId":worker}));
            return Err(error("The shared worker command queue is full.".into()));
        }
        let presence = self
            .coordinator
            .find_worker(&worker.clone().into())
            .await
            .map_err(|e| error(e.to_string()))?;
        let Some(presence) = presence else {
            self.state.lock().unwrap().failed += 1;
            self.repeat(format!("coordination-command-offline:{worker}:{}",command["type"].as_str().unwrap_or("")),"warn","Remote worker command could not be dispatched",json!({"event":"coordination.command.rejected","subsystem":"relay-coordination","operation":command["type"],"reasonCode":"worker-offline","status":"rejected","workerId":worker}));
            return Err(CommandError::unavailable(format!(
                "Worker {worker} is offline."
            )));
        };
        if let Some(id) = text(&presence["connectionId"]) {
            self.state.lock().unwrap().known.insert(worker.clone(), id);
        }
        let owner = match options.owner.take() {
            Some(owner) => Some(owner),
            None => (self.resolve_owner)(worker.clone())
                .await
                .map_err(|e| error(e.to_string()))?,
        };
        let Some(owner) = owner.filter(|o| !o.is_empty() && presence["ownerId"] == o.as_str())
        else {
            self.state.lock().unwrap().failed += 1;
            return Err(CommandError::unavailable(format!(
                "Worker {worker} is unavailable."
            )));
        };
        let timeout = options.timeout.map(|d| d.min(Duration::from_secs(86400)));
        let ttl = timeout
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(86_400_000.0);
        let id = Uuid::new_v4().to_string();
        let at = now();
        let kind = command["type"].as_str().unwrap_or("").to_owned();
        self.state.lock().unwrap().routed += 1;
        self.log(
            "debug",
            "Remote worker command dispatched",
            "coordination.command.dispatched",
            &kind,
            "dispatched",
            json!({"requestId":id,"workerId":worker}),
        );
        let (tx, rx) = oneshot::channel();
        let (delivery, mut events) = mpsc::unbounded_channel();
        let pending = Arc::new(Pending {
            instance: presence["instanceId"].as_str().unwrap_or("").into(),
            worker: worker.clone(),
            command: kind,
            started: at,
            delivery,
            completion: Mutex::new(Some(tx)),
            timer: Mutex::new(None),
            deadline: Mutex::new(CommandDeadline::new(timeout)),
            changed: watch::channel(()).0,
            options,
        });
        self.state
            .lock()
            .unwrap()
            .pending
            .insert(id.clone(), pending.clone());
        let weak = Arc::downgrade(&self);
        let p = pending.clone();
        let key = id.clone();
        run(async move {
            while let Some(delivery) = events.recv().await {
                let Some(b) = weak.upgrade() else {
                    return;
                };
                match delivery {
                    Delivery::Finished => return,
                    Delivery::Event(event) => {
                        if let Some(handler) = &p.options.on_event
                            && let Err(cause) = handler(event).await
                        {
                            b.state.lock().unwrap().pending.shift_remove(&key);
                            p.stop_timer();
                            b.log("warn","Remote worker command event handling failed","coordination.command.event-handler-failed",&p.command,"failed",json!({"requestId":key,"reasonCode":"event-handler-failed","durationMs":now()-p.started,"workerId":p.worker}));
                            b.complete(&p, Err(cause));
                            return;
                        }
                    }
                    Delivery::Response(response) => {
                        let outcome = if wire::coercion::truthy(response.get("ok")) {
                            b.log("debug","Remote worker command completed","coordination.command.completed",&p.command,"completed",json!({"requestId":key,"durationMs":now()-p.started,"workerId":p.worker}));
                            Ok(response.get("result").cloned())
                        } else {
                            let code = code(&response["errorCode"]);
                            b.log("warn","Remote worker command failed","coordination.command.failed",&p.command,"failed",json!({"requestId":key,"reasonCode":code.as_deref().unwrap_or("remote-worker-failure"),"durationMs":now()-p.started,"workerId":p.worker}));
                            if code.as_deref() == Some("worker-unavailable") {
                                let mut e = CommandError::unavailable(
                                    "Remote worker is unavailable.".into(),
                                );
                                e.message =
                                    message(response.get("error"), "Remote worker is unavailable.");
                                Err(e)
                            } else {
                                Err(CommandError {
                                    message: message(
                                        response.get("error"),
                                        "Remote worker command failed.",
                                    ),
                                    code,
                                    unavailable: false,
                                    request_id: Some(key.clone()),
                                    encoding_error: None,
                                    inference: wire::parse(
                                        "inferenceFailureEvidenceSchema",
                                        response.get("inference"),
                                    )
                                    .ok()
                                    .map(Box::new),
                                })
                            }
                        };
                        b.complete(&p, outcome);
                        return;
                    }
                }
            }
        });
        let this = self.clone();
        let p = pending.clone();
        let key = id.clone();
        run(async move {
            if let Err(cause)=this.coordinator.publish(json!({"kind":"worker-command-request","targetInstanceId":presence["instanceId"],"workerId":worker,"ownerId":owner,"requestId":key,"command":command,"timeoutMs":timeout.map(|d|d.as_secs_f64()*1000.0)}),Some(ttl)).await{
                let removed=this.state.lock().unwrap().pending.shift_remove(&key).is_some();if !removed{return;}
                p.stop_timer();this.log("error","Remote worker command relay failed","coordination.command.dispatch-failed",&p.command,"failed",json!({"requestId":key,"reasonCode":"coordination-publish-failed","durationMs":now()-p.started,"workerId":p.worker}));
                this.complete(&p,Err(error(cause.to_string())));
            }
        });
        if timeout.is_some() && pending.completion.lock().unwrap().is_some() {
            self.arm_deadline(id, pending);
        }
        rx.await
            .unwrap_or_else(|_| Err(CommandError::unavailable("Server is shutting down.".into())))
    }
    fn arm_deadline(self: &Arc<Self>, id: String, pending: Arc<Pending>) {
        let weak = Arc::downgrade(self);
        let p = pending.clone();
        let mut changed = p.changed.subscribe();
        let task = tokio::spawn(async move {
            loop {
                changed.borrow_and_update();
                let remaining = p.deadline.lock().unwrap().remaining();
                let expired = match remaining {
                    None => {
                        if changed.changed().await.is_err() {
                            return;
                        }
                        false
                    }
                    Some(left) => {
                        tokio::select! {biased;update=changed.changed()=>{if update.is_err(){return;}false},_=tokio::time::sleep(left)=>true}
                    }
                };
                if !expired {
                    continue;
                }
                let Some(b) = weak.upgrade() else {
                    return;
                };
                let removed = {
                    let mut state = b.state.lock().unwrap();
                    if !p
                        .deadline
                        .lock()
                        .unwrap()
                        .remaining()
                        .is_some_and(|d| d.is_zero())
                    {
                        continue;
                    }
                    if state.pending.get(&id).is_some_and(|v| Arc::ptr_eq(v, &p)) {
                        state.pending.shift_remove(&id);
                        true
                    } else {
                        false
                    }
                };
                if removed {
                    b.log("warn","Remote worker command timed out","coordination.command.timed-out",&p.command,"failed",json!({"requestId":id,"reasonCode":"timeout","durationMs":now()-p.started,"workerId":p.worker}));
                    b.complete(
                        &p,
                        Err(CommandError::command(
                            format!("Worker command {} timed out.", p.command),
                            "worker-command-timeout",
                            &id,
                        )),
                    );
                }
                return;
            }
        });
        *pending.timer.lock().unwrap() = Some(task.abort_handle());
    }
    pub(super) fn receive_event(&self, message: &Value) {
        let Some(id) = message["requestId"].as_str() else {
            return;
        };
        let pending = self.state.lock().unwrap().pending.get(id).cloned();
        let Some(p) = pending.filter(|p| message["sourceInstanceId"] == p.instance.as_str()) else {
            return;
        };
        let Ok(event) = wire::parse("workerEventSchema", message.get("event")) else {
            return;
        };
        if event["type"] == "inference.command-state" {
            if let (Some(sequence), Some(state)) =
                (event["sequence"].as_u64(), event["state"].as_str())
                && p.deadline.lock().unwrap().observe(sequence, state)
            {
                p.changed.send_replace(());
            }
            inference(&p.options, &event);
            if !p.options.forward_inference && event["admitted"] != true {
                return;
            }
        }
        if p.options.on_event.is_some() {
            let _ = p.delivery.send(Delivery::Event(event));
        }
    }
    pub(super) fn receive_response(&self, message: Value) {
        let Some(id) = message["requestId"].as_str() else {
            return;
        };
        let pending = {
            let mut state = self.state.lock().unwrap();
            if state
                .pending
                .get(id)
                .is_none_or(|p| message["sourceInstanceId"] != p.instance.as_str())
            {
                return;
            }
            state.pending.shift_remove(id).unwrap()
        };
        pending.stop_timer();
        let _ = pending.delivery.send(Delivery::Response(message));
    }
    pub(super) async fn receive_command(self: &Arc<Self>, message: Value) -> Result<()> {
        if self.state.lock().unwrap().incoming >= 512 {
            self.repeat("coordination-incoming-command-busy".into(),"warn","Incoming worker command relay is busy",json!({"event":"coordination.command.rejected","subsystem":"relay-coordination","operation":"receive-command","reasonCode":"incoming-limit","status":"rejected","workerId":message["workerId"]}));
            return self
                .respond(
                    &message,
                    false,
                    None,
                    Some("Worker command relay is busy.".into()),
                    None,
                    None,
                )
                .await;
        }
        let Some(worker) = text(&message["workerId"]) else {
            return Ok(());
        };
        let command = wire::parse("workerCommandSchema", message.get("command"));
        let (local, generation) = {
            let s = self.state.lock().unwrap();
            (
                s.connections.get(&worker).cloned(),
                s.attachments.get(&worker).copied(),
            )
        };
        let owner = (self.resolve_owner)(worker.clone()).await?;
        let expires = message["expiresAt"].as_f64().unwrap_or(f64::NAN);
        let remaining = if matches!(message.get("timeoutMs"), Some(Value::Null)) {
            None
        } else {
            let duration = wire::coercion::number(message.get("timeoutMs"))
                .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?;
            let budget = expires - now();
            // Math.min propagates NaN, whereas f64::min chooses the other
            // operand. Missing timeout is undefined/NaN, distinct from null.
            Some(if duration.is_nan() || budget.is_nan() {
                f64::NAN
            } else {
                duration.min(budget).min(86_400_000.0)
            })
        };
        if expires <= now() || remaining.is_some_and(|n| n <= 0.0) {
            return self
                .respond(
                    &message,
                    false,
                    None,
                    Some("Worker command expired before dispatch.".into()),
                    Some("worker-command-timeout".into()),
                    None,
                )
                .await;
        }
        let unavailable = command.is_err()
            || local.as_ref().is_none_or(|c| {
                !self.same_connection(&worker, c) || message["ownerId"] != c.owner.as_str()
            })
            || self.state.lock().unwrap().attachments.get(&worker).copied() != generation
            || !self.local.is_connected(&worker)
            || owner.as_deref() != message["ownerId"].as_str();
        if unavailable {
            return self
                .respond(
                    &message,
                    false,
                    None,
                    Some("Worker is unavailable.".into()),
                    Some("worker-unavailable".into()),
                    None,
                )
                .await;
        }
        self.state.lock().unwrap().incoming += 1;
        let b = self.clone();
        let m = message.clone();
        let handler: EventHandler = Arc::new(move |event| {
            let b = b.clone();
            let m = m.clone();
            Box::pin(async move {
                b.coordinator.publish(json!({"kind":"worker-command-event","targetInstanceId":m["sourceInstanceId"],"requestId":m["requestId"],"event":event}),Some(freshness(&m))).await.map_err(|e|error(e.to_string()))
            })
        });
        let result = self
            .local
            .request(
                &worker,
                command.unwrap(),
                remaining.map(|n| {
                    // Node schedules setTimeout(NaN) with a one millisecond
                    // delay; it does not disable the local command deadline.
                    if n.is_nan() {
                        Duration::from_millis(1)
                    } else {
                        Duration::from_secs_f64(n.max(0.0) / 1000.0)
                    }
                }),
                Some(handler),
            )
            .await;
        let response = match result {
            Ok(value) => self.respond(&message, true, value, None, None, None).await,
            Err(cause) => {
                self.respond(
                    &message,
                    false,
                    None,
                    Some(cause.message),
                    if cause.unavailable {
                        Some("worker-unavailable".into())
                    } else {
                        cause.code
                    },
                    cause.inference.map(|v| *v),
                )
                .await
            }
        };
        self.state.lock().unwrap().incoming -= 1;
        response
    }
    async fn respond(
        &self,
        request: &Value,
        ok: bool,
        result: Option<Value>,
        error: Option<wire::JsString>,
        code: Option<String>,
        inference: Option<Value>,
    ) -> Result<()> {
        let mut payload = json!({"kind":"worker-command-response","targetInstanceId":request["sourceInstanceId"],"requestId":request["requestId"],"ok":ok});
        if let Some(result) = result {
            payload["result"] = result;
        }
        if let Some(error) = error {
            payload["error"] = Value::String(error);
        }
        if let Some(code) = code {
            payload["errorCode"] = json!(code);
        }
        if let Some(inference) = inference {
            payload["inference"] = inference;
        }
        self.coordinator
            .publish(payload, Some(freshness(request)))
            .await
    }
}
