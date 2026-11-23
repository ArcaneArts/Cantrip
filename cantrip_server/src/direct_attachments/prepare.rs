use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

struct Preparation {
    service: Arc<Coordinator>,
    id: Uuid,
    key: Key,
    lifecycle: Uuid,
}
impl Drop for Preparation {
    fn drop(&mut self) {
        let mut state = self.service.state.lock().unwrap();
        state.preparations.shift_remove(&self.id);
        Coordinator::remove_unused(&mut state, &self.key, self.lifecycle);
        drop(state);
        self.service.changed.notify_waiters();
    }
}
impl Coordinator {
    pub async fn prepare(self: &Arc<Self>, input: PrepareInput) -> anyhow::Result<Value> {
        let (pending, generation) = {
            let mut state = self.state.lock().unwrap();
            if !std::ptr::eq(input.lease.coordinator.as_ptr(), Arc::as_ptr(self))
                || !Self::lease_matches(&state, &input)
            {
                return Err(unavailable(if state.closed {
                    "The direct attachment coordinator is shutting down."
                } else {
                    "The owning resource is being revoked."
                }));
            }
            let key = resource_key(&input.value);
            let lifecycle = Self::lifecycle(&mut state, key.clone());
            if lifecycle.revoking > 0 {
                return Err(unavailable("The owning resource is being revoked."));
            }
            let (lifecycle, generation) = (lifecycle.id, lifecycle.generation);
            let id = Uuid::new_v4();
            state.preparations.insert(
                id,
                Pending {
                    input: input.value.clone(),
                    lifecycle,
                },
            );
            (
                Preparation {
                    service: self.clone(),
                    id,
                    key,
                    lifecycle,
                },
                generation,
            )
        };
        let ticket = self
            .prepare_inner(&input.value, pending.lifecycle, generation)
            .await?;
        let valid = {
            let state = self.state.lock().unwrap();
            Self::lease_matches(&state, &input)
                && state.lifecycles.get(&pending.key).is_some_and(|l| {
                    l.id == pending.lifecycle && l.generation == generation && l.revoking == 0
                })
        };
        if !valid {
            self.revoke(
                ticket["binding"]["capabilityId"].as_str().unwrap(),
                "Owning resource was revoked",
                None,
            )
            .await;
            return Err(unavailable(
                "The owning resource changed while direct access was being prepared.",
            ));
        }
        Ok(ticket)
    }
    async fn prepare_inner(
        self: &Arc<Self>,
        input: &Value,
        lifecycle: Uuid,
        generation: Uuid,
    ) -> anyhow::Result<Value> {
        let started = self.now();
        let trace = input
            .get("diagnosticTraceId")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!(Uuid::new_v4().to_string()));
        let tunnel = wire::coercion::truthy(input.get("tunnelRoute"));
        let mode = if tunnel {
            "direct-tunnel"
        } else {
            "direct-capability"
        };
        let mut channels = Vec::new();
        for channel in input["channels"].as_array().expect("Direct channels") {
            if !channels.contains(channel) {
                channels.push(channel.clone());
            }
        }
        let context = events::PrepareLog {
            trace: &trace,
            input,
            mode,
            started,
        };
        self.prepare_started(&context, channels.len());
        if input["worker"]["online"] != true
            || !(self.options.connected)(&input["worker"]["workerId"])
        {
            self.prepare_failed(&context, "worker_offline", None);
            return Err(unavailable("Worker is offline."));
        }
        if input["worker"]["directBroker"]["available"] != true {
            self.prepare_failed(&context, "direct_broker_unavailable", None);
            return Err(unavailable("Worker does not offer a local direct broker."));
        }
        let now = self.now();
        let capability = Uuid::new_v4().to_string();
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy)?;
        let secret = URL_SAFE_NO_PAD.encode(entropy);
        let maximum = input
            .get("maxLeaseExpiresAt")
            .and_then(|v| v.as_js_string())
            .and_then(wire::date_milliseconds)
            .unwrap_or(now + 43_200_000)
            .min(now + 43_200_000);
        let expiry = input
            .get("leaseExpiresAt")
            .and_then(|v| v.as_js_string())
            .and_then(wire::date_milliseconds)
            .unwrap_or(now + 60_000)
            .min(maximum);
        if expiry <= now || maximum <= now {
            self.prepare_failed(&context, "lease_expired", None);
            return Err(unavailable("Direct attachment lease has already expired."));
        }
        let binding = json!({"capabilityId":capability,"ownerId":input["ownerId"],"authSessionId":input["authSessionId"],"workerId":input["worker"]["workerId"],"resourceKind":input["resourceKind"],"resourceId":input["resourceId"],"attachmentId":input.get("attachmentId").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(Uuid::new_v4().to_string())),"channels":channels,"expiresAt":iso(now+15_000)?,"leaseExpiresAt":iso(expiry)?});
        let ticket = checked(
            "directAttachmentTicketSchema",
            json!({"broker":input["worker"]["directBroker"],"binding":binding,"secret":secret}),
        )?;
        let result=async {
            let response=(self.workers)(input["worker"]["workerId"].clone(),json!({"type":"direct.capability.prepare","diagnosticTraceId":trace,"binding":binding,"secret":secret,"tunnelRoute":input.get("tunnelRoute").cloned().unwrap_or(Value::Null)}),Some(input["ownerId"].clone())).await?;
            checked("directCapabilityPrepareResultSchema",response)
        }.await;
        let prepared = match result {
            Ok(v) => v,
            Err(cause) => {
                self.prepare_failed(&context, "worker_prepare_failed", Some(&cause));
                return Err(unavailable(
                    "Worker could not prepare a local direct capability.",
                ));
            }
        };
        if prepared["capabilityId"] != capability.as_str() {
            self.prepare_failed(&context, "worker_ack_mismatch", None);
            anyhow::bail!("Worker acknowledged another direct capability.");
        }
        let jitter = (self.options.jitter)()?;
        let record = json!({"activatedAtMs":Value::Null,"activationAttemptCount":0,"activationCount":0,"attachmentId":binding["attachmentId"],"authSessionId":input["authSessionId"],"createdAtMs":started,"diagnosticTraceId":trace,"leaseExpiresAtMs":expiry,"maxLeaseExpiresAtMs":maximum,"mode":mode,"ownerId":input["ownerId"],"renewalAttemptCount":0,"renewalCount":0,"renewalSupported":input["worker"]["directBroker"]["leaseRenewal"],"renewalWindowMs":90_000+(jitter as u32%60_001),"resourceId":input["resourceId"],"resourceKind":input["resourceKind"],"telemetryObservedAtMs":Value::Null,"telemetryReportCount":0,"workerId":input["worker"]["workerId"],"telemetry":json!({"bytesFromLocal":0,"bytesToLocal":0,"connectionsClosed":0,"connectionsOpened":0})});
        {
            let mut state = self.state.lock().unwrap();
            let offline = self.bridge.as_ref().map(|bridge| {
                let (weak, capability) = (Arc::downgrade(self), capability.clone());
                bridge.subscribe_worker_offline(
                    input["worker"]["workerId"]
                        .as_str()
                        .expect("Enrolled direct worker"),
                    Arc::new(move || {
                        if let Some(service) = weak.upgrade() {
                            service.finalize(&capability, "worker_disconnected");
                        }
                    }),
                )
            });
            let timer = self.timer(&capability, expiry);
            state.grants.insert(
                capability,
                Grant {
                    id: Uuid::new_v4(),
                    record: record.clone(),
                    lifecycle,
                    generation,
                    renewal: Arc::new(tokio::sync::Mutex::new(())),
                    timer,
                    offline,
                },
            );
        }
        let mut event = Self::grant_event(
            "direct_attachment.prepare.completed",
            "prepare",
            "completed",
            &record,
        );
        event["durationMs"] = json!(self.now() - started);
        event["channelCount"] = json!(channels.len());
        event["leaseDurationMs"] = json!(expiry - now);
        self.log("info", event);
        Ok(ticket)
    }
    pub(super) fn timer(
        self: &Arc<Self>,
        capability: &str,
        expiry: i64,
    ) -> Option<tokio::task::AbortHandle> {
        if !self.options.automatic_expiry {
            return None;
        }
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis((expiry - self.now()).max(1) as u64);
        let (weak, capability) = (Arc::downgrade(self), capability.to_owned());
        Some(
            tokio::spawn(async move {
                tokio::time::sleep_until(deadline).await;
                if let Some(service) = weak.upgrade() {
                    // A running timer must not abort its own admitted revoke.
                    let current = {
                        let mut state = service.state.lock().unwrap();
                        let current = state
                            .grants
                            .get_mut(&capability)
                            .filter(|g| number(&g.record, "leaseExpiresAtMs") == expiry as f64)
                            .map(|g| g.timer.take())
                            .is_some();
                        if current {
                            state.background += 1;
                        }
                        current
                    };
                    if current {
                        let _background = super::lifecycle::Background(service.clone());
                        service
                            .revoke(&capability, "Direct capability expired", None)
                            .await;
                    }
                }
            })
            .abort_handle(),
        )
    }
    pub async fn sweep_expired(self: &Arc<Self>) {
        let ids = self
            .state
            .lock()
            .unwrap()
            .grants
            .iter()
            .filter_map(|(id, g)| {
                (number(&g.record, "leaseExpiresAtMs") <= self.now() as f64).then_some(id.clone())
            })
            .collect::<Vec<_>>();
        futures::future::join_all(
            ids.iter()
                .map(|id| self.revoke(id, "Direct capability expired", None)),
        )
        .await;
    }
}
