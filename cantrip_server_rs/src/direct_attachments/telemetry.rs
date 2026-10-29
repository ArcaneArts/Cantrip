use super::*;
fn merge(previous: &Value, telemetry: &Value) -> Value {
    let mut result = Value::Object(Default::default());
    for field in [
        "bytesFromLocal",
        "bytesToLocal",
        "connectionsClosed",
        "connectionsOpened",
    ] {
        result[field] = json!(number(previous, field).max(number(telemetry, field)));
    }
    if let Some(reason) = telemetry
        .get("lastDestinationRejectionCode")
        .or_else(|| previous.get("lastDestinationRejectionCode"))
    {
        result["lastDestinationRejectionCode"] = reason.clone();
    }
    result
}
fn delta(previous: &Value, merged: &Value, record: &Value) -> Value {
    let mut result = Value::Object(Default::default());
    for field in [
        "bytesFromLocal",
        "bytesToLocal",
        "connectionsClosed",
        "connectionsOpened",
    ] {
        result[field] = json!(number(merged, field) - number(previous, field));
    }
    if let Some(reason) = merged.get("lastDestinationRejectionCode") {
        result["lastDestinationRejectionCode"] = reason.clone();
    }
    result["resourceId"] = record["resourceId"].clone();
    result["resourceKind"] = record["resourceKind"].clone();
    result
}
impl Coordinator {
    pub fn activate(&self, capability: &str, authorization: &Value, outcome: &str) -> bool {
        let record = {
            let mut state = self.state.lock().unwrap();
            state
                .grants
                .get_mut(capability)
                .filter(|g| Self::authorized(&g.record, authorization, true))
                .map(|grant| {
                    increment(&mut grant.record, "activationAttemptCount");
                    if outcome == "completed" {
                        increment(&mut grant.record, "activationCount");
                        if grant.record["activatedAtMs"].is_null() {
                            grant.record["activatedAtMs"] = json!(self.now());
                        }
                    }
                    grant.record.clone()
                })
        };
        let Some(record) = record else {
            self.rate_log(crate::operations::logging::key("direct-activation-uncorrelated:",&[&authorization["ownerId"]]),"warn",json!({"event":"direct_attachment.activation.uncorrelated","subsystem":"direct-attachment","operation":"activate","status":if outcome=="capability_mismatch"{"rejected"}else{"degraded"},"reasonCode":if outcome=="capability_mismatch"{"capability_mismatch"}else{"grant_missing"},"mode":"local-direct","attachmentId":authorization["attachmentId"]}));
            return false;
        };
        let completed = outcome == "completed";
        let mut event = Self::grant_event(
            if completed {
                "direct_attachment.activation.completed"
            } else {
                "direct_attachment.activation.rejected"
            },
            "activate",
            if completed { "completed" } else { "rejected" },
            &record,
        );
        event["mode"] = json!("local-direct");
        event["durationMs"] = json!(self.now() as f64 - number(&record, "createdAtMs"));
        event["activationAttemptCount"] = record["activationAttemptCount"].clone();
        event["activationCount"] = record["activationCount"].clone();
        if !completed {
            event["reasonCode"] = json!(outcome);
        }
        self.log(if completed { "info" } else { "warn" }, event);
        true
    }
    pub fn record_telemetry(
        &self,
        capability: &str,
        authorization: &Value,
        telemetry: Value,
    ) -> Option<Value> {
        let (record, result) = {
            let mut state = self.state.lock().unwrap();
            let grant = state
                .grants
                .get_mut(capability)
                .filter(|g| Self::authorized(&g.record, authorization, false))?;
            let previous = &grant.record["telemetry"];
            let merged = merge(previous, &telemetry);
            let result = delta(previous, &merged, &grant.record);
            grant.record["telemetry"] = merged;
            grant.record["telemetryObservedAtMs"] = json!(self.now());
            increment(&mut grant.record, "telemetryReportCount");
            (grant.record.clone(), result)
        };
        let mut event = Self::grant_event(
            "direct_attachment.telemetry.recorded",
            "record-telemetry",
            "completed",
            &record,
        );
        Self::traffic_fields(&mut event, &record["telemetry"]);
        event["telemetryReportCount"] = record["telemetryReportCount"].clone();
        event["leaseRemainingMs"] =
            json!((number(&record, "leaseExpiresAtMs") - self.now() as f64).max(0.0));
        self.log("debug", event);
        Some(result)
    }
    pub fn record_final_telemetry(
        &self,
        capability: &str,
        authorization: &Value,
        telemetry: Value,
    ) -> Option<Value> {
        let (record, result, accepted) = {
            let mut state = self.state.lock().unwrap();
            Self::prune(&mut state, self.now());
            let grant = state
                .finalized
                .get_mut(capability)
                .filter(|g| Self::authorized(&g.record, authorization, false))?;
            if grant.accepted {
                (
                    grant.record.clone(),
                    delta(
                        &grant.record["telemetry"],
                        &grant.record["telemetry"],
                        &grant.record,
                    ),
                    true,
                )
            } else {
                let previous = &grant.record["telemetry"];
                let merged = merge(previous, &telemetry);
                let result = delta(previous, &merged, &grant.record);
                grant.record["telemetry"] = merged;
                grant.accepted = true;
                (grant.record.clone(), result, false)
            }
        };
        if !accepted {
            let mut event = Self::grant_event(
                "direct_attachment.telemetry.final-recorded",
                "record-final-telemetry",
                "completed",
                &record,
            );
            Self::traffic_fields(&mut event, &record["telemetry"]);
            self.log("debug", event);
        }
        Some(result)
    }
}
