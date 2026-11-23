use super::*;
pub(super) struct PrepareLog<'a> {
    pub trace: &'a Value,
    pub input: &'a Value,
    pub mode: &'a str,
    pub started: i64,
}
impl Coordinator {
    fn message(event: &Value) -> &'static str {
        match event["event"].as_str().expect("Direct log event") {
            "direct_attachment.prepare.started" => "Direct attachment capability requested",
            "direct_attachment.prepare.completed" => "Direct attachment capability prepared",
            "direct_attachment.prepare.failed" => "Direct attachment preparation failed",
            "direct_attachment.revoked" => "Direct attachment capability revoked",
            "direct_attachment.finalized" => "Direct attachment final state captured",
            "direct_attachment.activation.completed" => "Direct attachment route activated",
            "direct_attachment.activation.rejected" => "Direct attachment activation rejected",
            "direct_attachment.activation.uncorrelated" => {
                "Direct attachment activation could not be correlated"
            }
            "direct_attachment.renew.completed" => "Direct attachment capability lease renewed",
            "direct_attachment.renew.failed" => "Direct attachment capability renewal failed",
            "direct_attachment.telemetry.recorded" => "Direct attachment telemetry recorded",
            "direct_attachment.telemetry.final-recorded" => {
                "Final direct attachment telemetry recorded"
            }
            "direct_attachment.lease-persistence.failed" => {
                "Direct attachment lease persistence failed"
            }
            "direct_attachment.runtime.stopped" => "Direct attachment coordinator stopped",
            _ => unreachable!("Known direct-attachment diagnostic"),
        }
    }
    pub(super) fn log(&self, level: &'static str, event: Value) {
        (self.options.logger)(crate::operations::logging::LogCall::event(
            level,
            Self::message(&event),
            event,
        ));
    }
    pub(super) fn rate_log(&self, key: JsString, level: &'static str, event: Value) {
        (self.options.logger)(crate::operations::logging::LogCall::repeated(
            key,
            level,
            Self::message(&event),
            event,
            None,
        ));
    }
    pub(super) fn grant_event(event: &str, operation: &str, status: &str, record: &Value) -> Value {
        let mut value = json!({"event":event,"subsystem":"direct-attachment","operation":operation,"status":status});
        for key in [
            "diagnosticTraceId",
            "mode",
            "attachmentId",
            "resourceId",
            "resourceKind",
            "workerId",
        ] {
            if let Some(field) = record.get(key) {
                value[key] = field.clone();
            }
        }
        value
    }
    pub(super) fn traffic_fields(event: &mut Value, telemetry: &Value) {
        for (key, field) in [
            ("fromLocalBytes", "bytesFromLocal"),
            ("toLocalBytes", "bytesToLocal"),
            ("openedConnectionCount", "connectionsOpened"),
            ("closedConnectionCount", "connectionsClosed"),
        ] {
            event[key] = telemetry[field].clone();
        }
        if let Some(reason) = telemetry.get("lastDestinationRejectionCode") {
            event["lastDestinationRejectionCode"] = reason.clone();
        }
    }
    pub(super) fn prepare_started(&self, context: &PrepareLog<'_>, channels: usize) {
        let mut event = json!({"event":"direct_attachment.prepare.started","subsystem":"direct-attachment","operation":"prepare","status":"started","diagnosticTraceId":context.trace,"mode":context.mode,"resourceKind":context.input["resourceKind"],"workerId":context.input["worker"]["workerId"],"channelCount":channels});
        if let Some(attachment) = context.input.get("attachmentId") {
            event["attachmentId"] = attachment.clone();
        }
        self.log("debug", event);
    }
    pub(super) fn prepare_failed(
        &self,
        context: &PrepareLog<'_>,
        reason: &str,
        cause: Option<&anyhow::Error>,
    ) {
        let mut event = json!({"event":"direct_attachment.prepare.failed","subsystem":"direct-attachment","operation":"prepare","status":"failed","reasonCode":reason,"diagnosticTraceId":context.trace,"mode":context.mode,"resourceId":context.input["resourceId"],"resourceKind":context.input["resourceKind"],"workerId":context.input["worker"]["workerId"],"durationMs":self.now()-context.started});
        if let Some(attachment) = context.input.get("attachmentId") {
            event["attachmentId"] = attachment.clone();
        }
        Self::error_fields(&mut event, cause);
        self.log("warn", event);
    }
    fn error_fields(event: &mut Value, cause: Option<&anyhow::Error>) {
        if let Some(cause) = cause {
            for (key, value) in renewal::error_identity(cause).as_object().unwrap() {
                event[key.as_str().expect("Safe error field")] = value.clone();
            }
        }
    }
    pub(super) fn renewal_failed(
        &self,
        record: &Value,
        started: i64,
        reason: &str,
        cause: Option<&anyhow::Error>,
    ) {
        let status = if matches!(reason, "worker_timeout" | "worker_transport_unavailable") {
            "degraded"
        } else {
            "failed"
        };
        let mut event =
            Self::grant_event("direct_attachment.renew.failed", "renew", status, record);
        event["reasonCode"] = json!(reason);
        event["durationMs"] = json!(self.now() - started);
        event["renewalAttemptCount"] = record["renewalAttemptCount"].clone();
        event["renewalCount"] = record["renewalCount"].clone();
        Self::error_fields(&mut event, cause);
        self.rate_log(
            crate::operations::logging::key(
                "direct-renewal:",
                &[&record["diagnosticTraceId"], &json!(reason)],
            ),
            "warn",
            event,
        );
    }
    pub(super) fn observer_failed(&self, kind: &str, event: &Value, cause: &anyhow::Error) {
        let mut failure = json!({"event":"direct_attachment.lease-persistence.failed","subsystem":"direct-attachment","operation":if kind=="finalized"{"finalize-lease"}else{"renew-lease"},"status":"failed","reasonCode":"repository_write_failed","mode":event["mode"],"attachmentId":event["attachmentId"],"resourceId":event["resourceId"],"resourceKind":event["resourceKind"]});
        Self::error_fields(&mut failure, Some(cause));
        self.log("error", failure);
    }
}
