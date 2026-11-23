//! Reopen an applied Goal setter's first cycle through the native producer.
use super::{Guard, Intent, Scope, Signal, Target, Turns, Worker, checked, id, read_native_goal};
use anyhow::{Result, ensure};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use std::time::Duration;

pub(crate) const COMMAND: &str = "chat.goal.claim-recover";

impl Turns {
    pub(crate) async fn recover_goal_claim(
        &self,
        command: &Value,
        worker: &Worker,
        signal: Signal,
    ) -> Result<Value> {
        let claim = &command["claim"];
        ensure!(
            claim["threadId"] == command["threadId"]
                && command["session"]["chatId"] == command["chatId"],
            "Goal claim recovery belongs to another managed session."
        );
        let scope = Scope::new(self.encryption.clone())?;
        let chat = id(&command["chatId"], "Goal claim recovery chat")?;
        let key = (scope.owner.clone(), scope.server.clone(), chat.clone());
        let manager = worker.inference_manager(&scope.owner, &scope.server)?;
        let guard = Guard::metadata_timeout(Some(signal), None, Duration::from_secs(10));
        // The native journal keeper must fence a surviving former process
        // before preparation can bring up another producer.
        guard.run(manager.confirm_native_ownership()).await?;
        scope.identity()?;
        let target = match self.live_goal_target(command, &scope, &chat) {
            Some(live) => live,
            None => Target::from_prepared(
                command,
                self.preparation.prepare(command, Intent::Preserve).await?,
            ),
        };
        ensure!(
            claim["threadId"].as_js_string() == Some(target.thread.id()),
            "Goal claim recovery prepared a different native thread."
        );
        let reply = |body: Value| {
            guard.check()?;
            target.thread.assert_current(&target.runtime)?;
            scope.identity()?;
            checked("nativeGoalClaimRecoveryReceiptSchema", &body)
        };
        let generation = self.receipts.worker_generation();
        let queued = |admission: Value| {
            reply(json!({
                "status":"queued","claim":claim,"admission":admission,
            }))
        };
        let deferred = || {
            reply(json!({
                "status":"deferred","claim":claim,"workerGeneration":generation,
            }))
        };
        let observation = self.goal_recoveries.observe_claim(
            &key,
            target.thread.id(),
            claim,
            target.runtime.generation(),
        );
        if let Some(admission) = observation.observed() {
            return queued(admission);
        }
        let queue = guard
            .run(self.receipts.queue_snapshot(&scope, &target.session))
            .await?;
        let Some(current) = eligible_claim(&queue, claim) else {
            return deferred();
        };
        let previous = &claim["admission"];
        if previous.is_object() && previous["workerGeneration"] != generation {
            if current["goalOperationId"] != previous["operationId"]
                || current["goalOperationGeneration"] != previous["operationGeneration"]
            {
                return deferred();
            }
            let source = json!({
                "operationId":previous["operationId"],
                "operationGeneration":previous["operationGeneration"],
                "threadId":target.thread.id(),
                "goalEpoch":claim["goalEpoch"],
            });
            let input = checked(
                "nativeGoalRecoveryFenceSchema",
                &json!({
                    "serverId":scope.server,"workerId":self.encryption.worker_id(),
                    "workerGeneration":generation,"source":source,"admission":previous,"firstClaim":claim,
                }),
            )?;
            scope.identity()?;
            let result = self
                .receipts
                .exchange(
                    "goal-recovery-fence",
                    "/api/internal/native-commands/goal-recovery-fence",
                    &input,
                    &guard,
                )
                .await?;
            let result = checked("nativeGoalRecoveryFenceResultSchema", &result)?;
            if result["recovery"]["source"] != source {
                return deferred();
            }
            manager.wake_recovery(Some(chat));
            return reply(json!({
                "status":"recovering","claim":claim,"workerGeneration":generation,
            }));
        }
        let (goal, epoch, native_epoch) =
            read_native_goal(&target.runtime, &target.thread, &guard).await?;
        if epoch != claim["goalEpoch"] || goal["status"] != "active" {
            // A child already attached to this claim owns its own settlement.
            if !current["goalOperationId"].is_null()
                || !current["goalOperationGeneration"].is_null()
            {
                return deferred();
            }
            let mut observation = target.session.clone();
            let Value::Object(fields) = &mut observation else {
                unreachable!()
            };
            fields.shift_remove("connectionId");
            observation["workerId"] = json!(self.encryption.worker_id());
            observation["nativeEpoch"] = native_epoch;
            observation["goalEpoch"] = epoch;
            observation["goalStatus"] = goal["status"].clone();
            return reply(json!({
                "status":"ineligible","claim":claim,"workerGeneration":generation,"observation":observation,
            }));
        }
        if let Some(admission) = observation.observed() {
            return queued(admission);
        }
        target.wake(&guard).await?;
        queued(target.wait(&observation, &guard).await?)
    }
}

fn eligible_claim<'a>(queue: &'a Value, claim: &Value) -> Option<&'a Value> {
    if queue["paused"] == true || !queue["goalRecovery"].is_null() {
        return None;
    }
    queue["claims"].as_array()?.iter().find(|current| {
        current["id"] == claim["claimId"]
            && current["awaitingGoal"] == true
            && current["goalCancelled"] != true
            && current["operationId"] == claim["operationId"]
            && current["operationGeneration"] == claim["operationGeneration"]
            && current["goalEpoch"] == claim["goalEpoch"]
            && current["promptId"] == claim["promptId"]
            && current["promptRevision"] == claim["promptRevision"]
            && current["nativeTurnId"].is_null()
            && matches!(current["status"].as_str(), Some("dispatched" | "uncertain"))
    })
}
