//! Drain the exact canonical Task input after Core transfers its provider route.
use super::*;
use crate::codex::{admission::Execution, managed::Worker};

pub(crate) const COMMAND: &str = "inference.task-revoke";
const REVOKED: &str = "The Task input's dispatch fence was revoked for provider transfer.";

pub(super) struct Attempt {
    pub(super) interactions: OnceLock<interactions::Handle>,
    receipt: Value,
    revoked: AtomicBool,
    execution: OnceLock<Execution>,
}

impl Attempt {
    pub(super) fn new(command: &Value, worker: &JsString) -> Result<Self> {
        let receipt = checked(
            "taskInferenceInputReceiptSchema",
            &command["taskInferenceInput"],
        )?;
        if receipt["workerId"].as_js_string() != Some(worker) {
            bail!("The Task input belongs to another worker.");
        }
        Ok(Self {
            interactions: OnceLock::new(),
            receipt,
            revoked: AtomicBool::new(false),
            execution: OnceLock::new(),
        })
    }

    pub(super) fn operation(&self) -> &Value {
        &self.receipt["operationId"]
    }

    pub(super) fn revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    pub(super) fn bind(&self, execution: &Execution) -> Result<()> {
        self.execution
            .set(execution.clone())
            .map_err(|_| anyhow!("The Task input already owns an inference attempt."))?;
        if self.revoked() {
            execution.revoke(REVOKED)?;
        }
        Ok(())
    }

    fn revoke(&self, source: &Value, preparation: &Abort) -> Result<()> {
        if &self.receipt != source {
            bail!("The Task input cancellation changed its canonical receipt.");
        }
        self.revoked.store(true, Ordering::Release);
        preparation.abort(anyhow!(REVOKED));
        if let Some(execution) = self.execution.get() {
            execution.revoke(REVOKED)?;
        }
        Ok(())
    }
}

impl Turns {
    pub(crate) async fn revoke_task_input(
        &self,
        worker: &Worker,
        command: &Value,
    ) -> Result<Value> {
        let bound = self.preparation.identity()?;
        let (owner, server) = (&bound.0, id(&bound.1, "inference server identity")?);
        let worker_id = self.encryption.worker_id();
        let source = checked("taskInferenceInputReceiptSchema", &command["source"])?;
        if command["ownerId"].as_js_string() != Some(owner)
            || source["workerId"].as_js_string() != Some(worker_id)
        {
            bail!("The Task input cancellation belongs to another worker owner.");
        }
        let active = || -> Result<bool> {
            let sessions = self.active.lock().unwrap();
            for ((live_owner, live_server, _), turn) in &sessions.active {
                let Some(attempt) = &turn.task_input else {
                    continue;
                };
                if attempt.operation() != &source["operationId"]
                    || matches!(*turn.phase.lock().unwrap(), Phase::Finished)
                {
                    continue;
                }
                if live_owner != owner || live_server != &server {
                    bail!("The Task input cancellation belongs to another worker binding.");
                }
                attempt.revoke(&source, &turn.preparation)?;
                return Ok(true);
            }
            Ok(false)
        };
        let settled = if active()? {
            false
        } else {
            // A missing in-memory owner alone cannot prove a previous worker's
            // native process is gone. Join the actual keeper and read its state.
            worker.confirm_inference_ownership(owner, &server).await?;
            !active()?
        };
        if self.preparation.identity()? != bound {
            bail!("The worker's Task input owner changed during settlement.");
        }
        checked(
            "taskInferenceRouteSettlementSchema",
            &json!({
                "operationId":command["operationId"],"source":source,
                "ownerId":owner,"serverId":server,"workerId":worker_id,
                "workerGeneration":self.task_inputs.generation(),"settled":settled,
            }),
        )
    }

    pub(super) fn task_route_notification(&self, task: &TaskTurn) -> Option<Value> {
        let (owner, server, _) = &task.key;
        self.preparation.identity().ok()
            .filter(|(live_owner, live_server)| live_owner == owner && live_server.as_js_string() == Some(server))
            .map(|_| json!({
                "type":"inference.task-settled","ownerId":owner,"serverId":server,
                "workerId":self.encryption.worker_id(),"workerGeneration":self.task_inputs.generation(),
                "inputOperationId":task.input.operation(),
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_checks_the_full_fence_and_leaves_another_input_untouched() -> Result<()> {
        let receipt = json!({
            "operationId":"3be33a81-2da8-452c-b3b0-391f555de2cd",
            "chatId":"chat","clientMessageId":"message","workerId":"worker","worktreeId":"tree",
            "executionLaneId":"lane","executionLaneActivatedAt":"2026-11-18T00:00:00.000Z",
            "providerId":"provider","modelRouteId":"route","providerAccountId":Value::Null,
            "dispatch":json!({
                "cycleId":"06b8f72e-05c4-475a-b7a7-94094cdd0e6d",
                "operationId":"250afcc0-0568-4be4-9809-414abc522b02",
                "leaseOwner":"lease","fencingToken":7,
            }),
        });
        let worker = JsString::from("worker");
        let original = Attempt::new(&json!({"taskInferenceInput":receipt}), &worker)?;
        let (abort, signal) = Abort::new();
        let mut changed = receipt.clone();
        changed["dispatch"]["fencingToken"] = json!(8);
        assert!(original.revoke(&changed, &abort).is_err());
        assert!(signal.check().is_ok());

        changed["operationId"] = json!("b92bc000-7a8f-42eb-bb72-01170db94666");
        let replacement = Attempt::new(&json!({"taskInferenceInput":changed}), &worker)?;
        let (replacement_abort, replacement_signal) = Abort::new();
        assert!(replacement.revoke(&receipt, &replacement_abort).is_err());

        original.revoke(&receipt, &abort)?;
        original.revoke(&receipt, &abort)?;
        assert_eq!(signal.check().unwrap_err().to_string(), REVOKED);
        assert!(original.revoked());
        assert!(!replacement.revoked());
        assert!(replacement_signal.check().is_ok());
        Ok(())
    }
}
