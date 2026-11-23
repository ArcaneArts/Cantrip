use super::*;
impl Coordinator {
    pub async fn renew(
        self: &Arc<Self>,
        capability: &str,
        authorization: &Value,
    ) -> anyhow::Result<Value> {
        let (id, queue) = {
            let state = self.state.lock().unwrap();
            let Some(grant) = state
                .grants
                .get(capability)
                .filter(|g| Self::authorized(&g.record, authorization, false))
            else {
                return Ok(json!({"status":"missing"}));
            };
            (grant.id, grant.renewal.clone())
        };
        let _queue = queue.lock_owned().await;
        let (record, expiry, maximum, candidate, started) = {
            let mut state = self.state.lock().unwrap();
            if !Self::current(&state, capability, id) {
                return Ok(json!({"status":"missing"}));
            }
            let grant = state.grants.get_mut(capability).unwrap();
            let record = &mut grant.record;
            if record["activatedAtMs"].is_null() || number(record, "activationCount") == 0.0 {
                return Ok(json!({"status":"not-active"}));
            }
            let started = self.now();
            let expiry = number(record, "leaseExpiresAtMs") as i64;
            let maximum = number(record, "maxLeaseExpiresAtMs") as i64;
            let candidate = expiry.max(maximum.min(started + 60_000));
            if expiry > started && record["renewalSupported"] != true {
                return Ok(json!({"status":"unsupported"}));
            }
            if expiry > started
                && (expiry - started > number(record, "renewalWindowMs") as i64
                    || candidate <= expiry)
            {
                return Ok(
                    json!({"leaseExpiresAt":iso(expiry)?,"renewed":false,"status":"completed"}),
                );
            }
            if expiry > started && candidate > started {
                increment(record, "renewalAttemptCount");
            }
            (record.clone(), expiry, maximum, candidate, started)
        };
        if expiry <= started || candidate <= started {
            self.revoke(capability, "Direct capability expired", None)
                .await;
            return Ok(json!({"status":"expired"}));
        }
        let response=async {
            let result=(self.workers)(record["workerId"].clone(),json!({"type":"direct.capability.renew","capabilityId":capability,"leaseExpiresAt":iso(candidate)?}),Some(record["ownerId"].clone())).await?;
            checked("directCapabilityRenewResultSchema",result)
        }.await;
        let result = match response {
            Ok(result) => result,
            Err(cause) => {
                if retryable(&cause) {
                    self.renewal_failed(
                        &record,
                        started,
                        if timed_out(&cause) {
                            "worker_timeout"
                        } else {
                            "worker_transport_unavailable"
                        },
                        Some(&cause),
                    );
                    return Ok(json!({"status":"retryable-failure"}));
                }
                self.renewal_failed(&record, started, "worker_request_failed", Some(&cause));
                self.fail_closed(capability, id, &record).await;
                return Ok(json!({"status":"worker-rejected"}));
            }
        };
        if result["renewed"] != true {
            self.renewal_failed(&record, started, "worker_rejected", None);
            self.fail_closed(capability, id, &record).await;
            return Ok(json!({"status":"worker-rejected"}));
        }
        let accepted = result
            .get("leaseExpiresAt")
            .and_then(Value::as_js_string)
            .and_then(wire::date_milliseconds)
            .unwrap_or(candidate);
        if accepted < candidate || accepted > maximum {
            self.renewal_failed(&record, started, "worker_ack_invalid", None);
            self.fail_closed(capability, id, &record).await;
            return Ok(json!({"status":"worker-rejected"}));
        }
        let updated = {
            let mut state = self.state.lock().unwrap();
            if !Self::current(&state, capability, id) {
                None
            } else {
                let g = state.grants.get_mut(capability).unwrap();
                if let Some(timer) = g.timer.take() {
                    timer.abort();
                }
                let expiry = (number(&g.record, "leaseExpiresAtMs") as i64).max(accepted);
                g.record["leaseExpiresAtMs"] = json!(expiry);
                g.timer = self.timer(capability, expiry);
                increment(&mut g.record, "renewalCount");
                Some(g.record.clone())
            }
        };
        let Some(updated) = updated else {
            self.renewal_failed(&record, started, "identity_changed", None);
            self.send_revoke(capability, &record, "Direct renewal identity changed")
                .await;
            if self
                .state
                .lock()
                .unwrap()
                .grants
                .get(capability)
                .is_some_and(|g| g.id == id)
            {
                self.finalize(capability, "identity_changed");
            }
            return Ok(json!({"status":"missing"}));
        };
        self.observe("renewed", Self::lease_event(capability, &updated));
        let mut event = Self::grant_event(
            "direct_attachment.renew.completed",
            "renew",
            "completed",
            &updated,
        );
        event["durationMs"] = json!(self.now() - started);
        event["leaseDurationMs"] =
            json!((number(&updated, "leaseExpiresAtMs") - self.now() as f64).max(0.0));
        event["renewalAttemptCount"] = updated["renewalAttemptCount"].clone();
        event["renewalCount"] = updated["renewalCount"].clone();
        self.log("debug", event);
        Ok(
            json!({"leaseExpiresAt":iso(number(&updated,"leaseExpiresAtMs") as i64)?,"renewed":true,"status":"completed"}),
        )
    }
    async fn fail_closed(self: &Arc<Self>, capability: &str, id: Uuid, record: &Value) {
        let current = self
            .state
            .lock()
            .unwrap()
            .grants
            .get(capability)
            .is_some_and(|g| g.id == id);
        if current {
            self.revoke(capability, "Direct capability renewal rejected", None)
                .await;
        } else {
            self.send_revoke(capability, record, "Direct capability renewal rejected")
                .await;
        }
    }
}
fn bridge_error(cause: &anyhow::Error) -> Option<&crate::workers::bridge::CommandError> {
    cause
        .downcast_ref::<crate::workers::bridge::CommandError>()
        .or_else(
            || match cause.downcast_ref::<crate::workers::command_bus::CommandFailure>() {
                Some(crate::workers::command_bus::CommandFailure::Bridge(error)) => Some(error),
                _ => None,
            },
        )
}
fn timed_out(cause: &anyhow::Error) -> bool {
    cause.to_string() == "Worker command direct.capability.renew timed out."
}
fn retryable(cause: &anyhow::Error) -> bool {
    timed_out(cause)
        || bridge_error(cause).is_some_and(|error| {
            error.unavailable
                || error.code.as_deref().is_some_and(|code| {
                    matches!(
                        code,
                        "ECONNREFUSED"
                            | "ECONNRESET"
                            | "EHOSTUNREACH"
                            | "ENETUNREACH"
                            | "ENOTFOUND"
                            | "EPIPE"
                            | "ETIMEDOUT"
                            | "ERR_SOCKET_CLOSED"
                    )
                })
        })
}
pub(super) fn error_identity(cause: &anyhow::Error) -> Value {
    let bridge = bridge_error(cause);
    let class = if cause.is::<ContractFailure>() {
        "ZodError"
    } else {
        "Error"
    };
    let mut value = json!({"errorClass":class});
    if let Some(code) = bridge.and_then(|e| e.code.as_deref()).filter(|code| {
        matches!(
            *code,
            "ECONNREFUSED"
                | "ECONNRESET"
                | "EHOSTUNREACH"
                | "ENETUNREACH"
                | "ENOTFOUND"
                | "EPIPE"
                | "ETIMEDOUT"
                | "ERR_INVALID_ARG_TYPE"
                | "ERR_INVALID_STATE"
                | "ERR_SOCKET_CLOSED"
        )
    }) {
        value["errorCode"] = json!(code);
    }
    value
}
