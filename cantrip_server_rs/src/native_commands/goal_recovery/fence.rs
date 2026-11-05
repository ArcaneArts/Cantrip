use super::*;

/// Marker membership is canonical no-dispatch authority. No journal entry is
/// invented for a crash before enqueue; the replacement worker separately
/// reads its actual keeper before asking to retire this exact old admission.
impl Repository {
    pub async fn fence_goal_recovery_admission(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let worker = text(&input["workerId"])?;
            let operation = text(&input["admission"]["operationId"])?;
            let generation = text(&input["admission"]["operationGeneration"])?;
            let captured = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let chat = text(&captured["chat_id"])?;
            context::lock_chat(tx, &owner, &chat).await?;
            let marker = read(tx, &chat).await?;
            let Some(marker) = marker.filter(|m| deep_equal(&m["source"], &input["source"]) && deep_equal(&m["admission"], &input["admission"]) &&
                m["admission"].get("workerGeneration") != input.get("workerGeneration")) else {
                return Ok(json!({"recovery":read(tx, &chat).await?}));
            };
            let unblocked = !tx.query(&format!("SELECT c.id FROM chats c WHERE c.id=$1 AND {} AND {}",
                super::super::managed_queue::NO_PERMISSION, super::super::managed_queue::NO_HANDOFF), &[&chat]).await?.is_empty();
            if !unblocked { return reject("goal-recovery-ineligible"); }
            let row = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let original = row.get("operation_id") == marker["source"].get("operationId") &&
                row.get("operation_generation") == marker["source"].get("operationGeneration") && !truthy(row["intent"].get("goalRecovery"));
            if row["intent"].get("workerGeneration") != input["admission"].get("workerGeneration") ||
                (!original && !deep_equal(&row["intent"]["goalRecovery"], &marker["source"])) ||
                !retire::unused(tx, &row, &marker["source"], json!({"kind":"not-dispatched","source":"canonical-goal-recovery",
                    "admission":input["admission"],"fencedByWorkerGeneration":input["workerGeneration"]})).await? {
                return reject("goal-recovery-source-unsettled");
            }
            let recovery = json!({"source":marker["source"],"admission":Value::Null});
            tx.query("UPDATE managed_queue_states SET goal_recovery=$1::text::jsonb WHERE chat_id=$2", &[&recovery.stringify(),&chat]).await?;
            queue::changed(tx, &chat).await?;
            Ok(json!({"recovery":recovery}))
        })).await
    }
}
