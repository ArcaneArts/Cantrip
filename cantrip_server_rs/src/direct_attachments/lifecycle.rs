use super::*;

#[derive(Clone)]
pub enum Scope {
    Owner(Value),
    Session(Value),
    Attachment(Value),
    Resource {
        owner: Value,
        kind: Value,
        resource: Value,
    },
}
impl Scope {
    fn matches(&self, input: &Value, resource: &Value, leases: bool) -> bool {
        match self {
            Self::Owner(v) => input["ownerId"] == *v,
            Self::Session(v) => input["authSessionId"] == *v,
            Self::Attachment(v) => input.get("attachmentId") == Some(v),
            Self::Resource {
                owner,
                kind,
                resource: target,
            } => {
                input["ownerId"] == *owner
                    && input["resourceKind"] == *kind
                    && ((leases && resource.is_null()) || resource == target)
            }
        }
    }
    fn reason(&self) -> &'static str {
        match self {
            Self::Owner(_) => "Account sessions were revoked",
            Self::Session(_) => "Authorization session was revoked",
            Self::Attachment(_) => "Owning attachment was revoked",
            Self::Resource { .. } => "Owning resource was revoked",
        }
    }
}
fn begin<K: std::hash::Hash + Eq>(map: &mut HashMap<K, usize>, key: K) {
    *map.entry(key).or_default() += 1;
}
fn end<K: std::hash::Hash + Eq>(map: &mut HashMap<K, usize>, key: &K) {
    if let Some(n) = map.get_mut(key) {
        *n -= 1;
        if *n == 0 {
            map.remove(key);
        }
    }
}
struct Fence {
    service: Arc<Coordinator>,
    scope: Scope,
    resource: Option<(Key, Uuid)>,
}
struct Write(Arc<Coordinator>);
pub(super) struct Background(pub(super) Arc<Coordinator>);
impl Drop for Background {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().background -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Drop for Write {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().writes -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Drop for Fence {
    fn drop(&mut self) {
        let mut state = self.service.state.lock().unwrap();
        match &self.scope {
            Scope::Owner(v) => end(&mut state.owners, text(v)),
            Scope::Session(v) => end(&mut state.sessions, text(v)),
            Scope::Attachment(v) => end(&mut state.attachments, text(v)),
            Scope::Resource { owner, kind, .. } => {
                end(&mut state.kinds, &key(owner, kind, None));
                let (key, id) = self.resource.as_ref().unwrap();
                if let Some(lifecycle) = state.lifecycles.get_mut(key).filter(|l| l.id == *id) {
                    lifecycle.revoking -= 1;
                }
                Coordinator::remove_unused(&mut state, key, *id);
            }
        }
        drop(state);
        self.service.changed.notify_waiters();
    }
}
impl Coordinator {
    pub async fn mutate<T>(
        self: &Arc<Self>,
        scope: Scope,
        mutation: impl Future<Output = anyhow::Result<T>>,
    ) -> anyhow::Result<T> {
        let (fence, queue) = {
            let mut state = self.state.lock().unwrap();
            let mut resource = None;
            let mut queue = None;
            match &scope {
                Scope::Owner(v) => begin(&mut state.owners, text(v).clone()),
                Scope::Session(v) => begin(&mut state.sessions, text(v).clone()),
                Scope::Attachment(v) => begin(&mut state.attachments, text(v).clone()),
                Scope::Resource {
                    owner,
                    kind,
                    resource: target,
                } => {
                    let resource_key = key(owner, kind, Some(target));
                    let l = Self::lifecycle(&mut state, resource_key.clone());
                    l.generation = Uuid::new_v4();
                    l.revoking += 1;
                    resource = Some((resource_key, l.id));
                    queue = Some(l.queue.clone());
                    begin(&mut state.kinds, key(owner, kind, None));
                }
            }
            (
                Fence {
                    service: self.clone(),
                    scope: scope.clone(),
                    resource,
                },
                queue,
            )
        };
        let _queue = if let Some(queue) = queue {
            Some(queue.lock_owned().await)
        } else {
            None
        };
        let (leases, pending) = {
            let state = self.state.lock().unwrap();
            (
                state
                    .leases
                    .iter()
                    .filter_map(|(id, l)| scope.matches(&l.input, &l.resource, true).then_some(*id))
                    .collect::<Vec<_>>(),
                state
                    .preparations
                    .iter()
                    .filter_map(|(id, p)| {
                        scope
                            .matches(&p.input, &p.input["resourceId"], false)
                            .then_some(*id)
                    })
                    .collect::<Vec<_>>(),
            )
        };
        self.wait(|state| {
            leases.iter().all(|id| !state.leases.contains_key(id))
                && pending
                    .iter()
                    .all(|id| !state.preparations.contains_key(id))
        })
        .await;
        let grants = self
            .state
            .lock()
            .unwrap()
            .grants
            .iter()
            .filter_map(|(id, g)| {
                scope
                    .matches(&g.record, &g.record["resourceId"], false)
                    .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        futures::future::join_all(
            grants
                .iter()
                .map(|id| self.revoke(id, scope.reason(), None)),
        )
        .await;
        let result = mutation.await;
        drop(_queue);
        drop(fence);
        result
    }
    pub async fn revoke_scope(self: &Arc<Self>, scope: Scope) {
        let _ = self.mutate(scope, async { Ok(()) }).await;
    }
    pub async fn revoke(
        self: &Arc<Self>,
        capability: &str,
        reason: &str,
        authorization: Option<&Value>,
    ) -> bool {
        let Some(record) =
            self.finalize_authorized(capability, revocation_reason(reason), authorization)
        else {
            return false;
        };
        let started = self.now();
        let delivered = self.send_revoke(capability, &record, reason).await;
        let mut event = Self::grant_event(
            "direct_attachment.revoked",
            "revoke",
            if delivered { "completed" } else { "degraded" },
            &record,
        );
        event["reasonCode"] = json!(revocation_reason(reason));
        event["success"] = json!(delivered);
        event["durationMs"] = json!(self.now() - started);
        self.log(if delivered { "info" } else { "warn" }, event);
        true
    }
    pub fn worker_offline(self: &Arc<Self>, worker: &Value) {
        let ids = self
            .state
            .lock()
            .unwrap()
            .grants
            .iter()
            .filter_map(|(id, g)| (g.record["workerId"] == *worker).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            self.finalize(&id, "worker_disconnected");
        }
    }
    pub(super) fn finalize(self: &Arc<Self>, capability: &str, reason: &str) -> Option<Value> {
        self.finalize_authorized(capability, reason, None)
    }
    fn finalize_authorized(
        self: &Arc<Self>,
        capability: &str,
        reason: &str,
        authorization: Option<&Value>,
    ) -> Option<Value> {
        let grant = {
            let mut state = self.state.lock().unwrap();
            let grant = state.grants.get(capability)?;
            if authorization.is_some_and(|a| !Self::authorized(&grant.record, a, false)) {
                return None;
            }
            state.grants.shift_remove(capability).unwrap()
        };
        if let Some(timer) = grant.timer {
            timer.abort();
        }
        drop(grant.offline);
        let record = grant.record;
        self.observe("finalized", Self::lease_event(capability, &record));
        let now = self.now();
        {
            let mut state = self.state.lock().unwrap();
            let key = resource_key(&record);
            if let Some(l) = state.lifecycles.get(&key) {
                let id = l.id;
                Self::remove_unused(&mut state, &key, id);
            }
            if record["mode"] == "direct-tunnel" {
                Self::prune(&mut state, now);
                state.finalized.insert(
                    capability.into(),
                    Finalized {
                        record: record.clone(),
                        expires: now + 120_000,
                        accepted: false,
                    },
                );
                while state.finalized.len() > 4096 {
                    state.finalized.shift_remove_index(0);
                }
            }
        }
        let mut event = Self::grant_event(
            "direct_attachment.finalized",
            "finalize",
            "completed",
            &record,
        );
        event["reasonCode"] = json!(reason);
        event["durationMs"] = json!(now - number(&record, "createdAtMs") as i64);
        for field in [
            "activationAttemptCount",
            "activationCount",
            "renewalAttemptCount",
            "renewalCount",
            "telemetryReportCount",
        ] {
            event[field] = record[field].clone();
        }
        Self::traffic_fields(&mut event, &record["telemetry"]);
        for (field, age) in [
            ("activatedAtMs", "activationAgeMs"),
            ("telemetryObservedAtMs", "telemetryAgeMs"),
        ] {
            if let Some(at) = record[field].as_f64() {
                event[age] = json!(now as f64 - at);
            }
        }
        self.log("info", event);
        self.changed.notify_waiters();
        Some(record)
    }
    pub(super) async fn send_revoke(&self, capability: &str, record: &Value, reason: &str) -> bool {
        (self.workers)(
            record["workerId"].clone(),
            json!({"type":"direct.capability.revoke","capabilityId":capability,"reason":reason}),
            Some(record["ownerId"].clone()),
        )
        .await
        .is_ok()
    }
    pub async fn close(self: &Arc<Self>) {
        let start = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                false
            } else {
                state.closed = true;
                true
            }
        };
        if start {
            let service = self.clone();
            tokio::spawn(async move {
                let (leases, pending) = {
                    let state = service.state.lock().unwrap();
                    (
                        state.leases.keys().copied().collect::<Vec<_>>(),
                        state.preparations.keys().copied().collect::<Vec<_>>(),
                    )
                };
                service
                    .wait(|s| {
                        leases.iter().all(|id| !s.leases.contains_key(id))
                            && pending.iter().all(|id| !s.preparations.contains_key(id))
                    })
                    .await;
                let ids = service
                    .state
                    .lock()
                    .unwrap()
                    .grants
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();
                futures::future::join_all(
                    ids.iter()
                        .map(|id| service.revoke(id, "Cantrip Server is stopping", None)),
                )
                .await;
                service.wait(|s| s.writes == 0).await;
                {
                    let mut state = service.state.lock().unwrap();
                    state.finalized.clear();
                    state.close_complete = true;
                }
                service.log("info",json!({"event":"direct_attachment.runtime.stopped","subsystem":"direct-attachment","operation":"shutdown","status":"completed","activeCapabilityCount":ids.len()}));
                service.changed.notify_waiters();
            });
        }
        self.wait(|s| s.close_complete).await;
    }
    pub(super) fn prune(state: &mut State, now: i64) {
        state.finalized.retain(|_, g| g.expires > now);
    }
    pub(super) fn lease_event(capability: &str, record: &Value) -> Value {
        json!({"attachmentId":record["attachmentId"],"capabilityId":capability,"leaseExpiresAt":iso(number(record,"leaseExpiresAtMs") as i64).expect("Stored lease time"),"mode":record["mode"],"ownerId":record["ownerId"],"resourceId":record["resourceId"],"resourceKind":record["resourceKind"]})
    }
    pub(super) fn observe(self: &Arc<Self>, kind: &'static str, event: Value) {
        if event["mode"] != "direct-tunnel" || event["resourceKind"] != "tunnel" {
            return;
        }
        let Some(observer) = self.options.observer.clone() else {
            return;
        };
        self.state.lock().unwrap().writes += 1;
        let write_guard = Write(self.clone());
        let service = self.clone();
        let mut write = Box::pin(async move {
            let _write = write_guard;
            if let Err(cause) = observer(kind, event.clone()).await {
                service.observer_failed(kind, &event, &cause);
            }
        });
        if write.as_mut().now_or_never().is_none() {
            tokio::spawn(write);
        }
    }
}
fn revocation_reason(reason: &str) -> &'static str {
    if reason.contains("expired") {
        "expired"
    } else if reason.contains("session") {
        "session_revoked"
    } else if reason.contains("attachment") {
        "attachment_revoked"
    } else if reason.contains("resource") {
        "resource_revoked"
    } else if reason.contains("Server") {
        "server_shutdown"
    } else {
        "revoked"
    }
}
