use super::*;
impl Manager {
    pub(in crate::inference::admission) fn recoverable(&self, record: &Value) -> bool {
        let recovery = &record["identity"]["recovery"];
        let physical = record["workerGeneration"]
            != Value::String(self.0.options.scope.worker_generation.clone())
            || record["state"] == "released"
                && matches!(
                    record["outcome"].as_str(),
                    Some("never-started" | "runtime-exited")
                );
        let native = coercion::truthy(record.get("nativeExecution"));
        if coercion::truthy(recovery.get("taskGoalCycle")) {
            return physical
                && (!native
                    || record["state"] == "released" && record["outcome"] == "never-started")
                && identity::queue(&record["identity"]["chatId"], recovery).is_some()
                && record["identity"]["operationId"]
                    == super::super::withdrawal::native_operation(recovery);
        }
        if coercion::truthy(recovery.get("autonomousGoal")) {
            return physical
                && !native
                && identity::queue(&record["identity"]["chatId"], recovery).is_some()
                && record["identity"]["operationId"] == recovery["commandGeneration"];
        }
        if coercion::truthy(recovery.get("taskInput")) {
            let task = &recovery["taskInput"];
            return record["identity"]["chatId"] == task["chatId"]
                && recovery["messageId"] == task["clientMessageId"]
                && record["identity"]["providerId"] == task["providerId"]
                && record["identity"]["operationId"] == task["operationId"];
        }
        (!coercion::truthy(record.get("everGranted")) && record["state"] != "granted"
            || record["state"] == "released" && record["outcome"] == "never-started")
            && coercion::truthy(record["identity"].get("chatId"))
            && ["commandId", "commandGeneration", "messageId"]
                .iter()
                .all(|field| coercion::truthy(recovery.get(field)))
            && record["identity"]["operationId"] == recovery["commandGeneration"]
    }
}
