use super::*;
impl Requests {
    pub fn handle_response(&self, message: &Value, payload: &Value) -> bool {
        if message.get("id").is_none() || coercion::truthy(message.get("method")) {
            return false;
        }
        let id = numeric_id(&message["id"]);
        let (settlement, pending) = {
            let mut state = self.0.state.lock().unwrap();
            (
                id.and_then(|id| state.settlements.remove(&id)),
                id.and_then(|id| state.pending.shift_remove(&id)),
            )
        };
        if let Some(pending) = &pending
            && let Some(timer) = &pending.timer
        {
            timer.abort();
        }
        if let Some(settlement) = settlement
            && settlement.replied().is_err()
        {
            self.record(diagnostic("message",json!({"id":coercion::number(message.get("id")).unwrap_or(f64::NAN),"settlementObserverFailed":true})),Some("Native inference settlement observer failed".into()));
        }
        let Some(pending) = pending else {
            self.record(
                diagnostic("unmatched-response", payload.clone()),
                Some(super::super::provider_errors::surround(
                    "Unmatched App Server response ",
                    &coercion::string(&message["id"]).unwrap(),
                    "",
                )),
            );
            return true;
        };
        if let Some(error) = message.get("error") {
            log(&self.0.ports, &pending, "failed", Some(&error["code"]));
            let failure = Failure {
                kind: "native",
                message: self
                    .0
                    .ports
                    .policy
                    .readable(error["message"].as_js_string().unwrap()),
                native_error: Some(error.clone()),
                request_method: Some(pending.method),
            };
            let _ = pending.send.send(Err(failure));
        } else {
            log(&self.0.ports, &pending, "completed", None);
            let _ = pending.send.send(Ok(message.get("result").cloned()));
        }
        true
    }
}

pub(super) fn log(ports: &Ports, pending: &Pending, status: &str, code: Option<&Value>) {
    let Some(logs) = &ports.logs else {
        return;
    };
    let event = if status == "timed-out" {
        "codex.rpc.timeout"
    } else if status == "failed" {
        "codex.rpc.failed"
    } else {
        "codex.rpc.completed"
    };
    let mut context = json!({"event":event,"subsystem":"codex","operation":pending.method,"status":status,"runtimeId":ports.runtime_id,"durationMs":pending.started.elapsed().as_millis() as u64});
    if let Some(code) = code {
        context["reasonCode"] = json!(format!("rpc-{}", code.stringify()));
    }
    if status == "completed" {
        let _ = logs.emitter.sampled(
            format!("codex-rpc-completed:{}", pending.method.lossy()).into(),
            Some(&json!(100)),
            "trace",
            &"Codex app-server request completed".into(),
            Some(&context),
        );
    } else {
        logs.repeated(
            format!(
                "codex-rpc-{status}:{}:{}",
                pending.method.lossy(),
                code.map_or(String::new(), Value::stringify)
            ),
            "warn",
            if status == "timed-out" {
                "Codex app-server request timed out"
            } else {
                "Codex app-server request failed"
            },
            context,
        );
    }
}
