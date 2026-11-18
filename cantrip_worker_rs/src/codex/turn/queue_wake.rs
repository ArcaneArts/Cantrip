//! A queue revision wakes the prepared native owner after Core supplies its current queue.
use super::{RPC_TIMEOUT, Scope, Turns, id};
use crate::codex::managed::Worker;
use anyhow::{Context, Result, bail};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};

pub(crate) const CHANGED: &str = "chat.queue.changed";

impl Turns {
    pub(crate) async fn queue_changed(&self, command: &Value, worker: &Worker) -> Result<Value> {
        if command["taskPause"].is_object() {
            bail!("Managed Task queue pause delivery requires the Task runtime control path.");
        }
        let chat = id(&command["chatId"], "queue notification chat")?;
        let scope = Scope::new(self.encryption.clone())?;
        let bound = (scope.owner.clone(), json!(scope.server));
        worker.wake_recovery(&scope.owner, &scope.server, &chat);

        if let Some((thread, owner)) = self.preparation.selected_live_thread(&chat, &bound)
            && let Some(session) = owner.session
            && let Some(runner) = owner.runtime.inference_router().goal_runner(&thread)
        {
            let snapshot = self.receipts.queue_snapshot(&scope, &session).await?;
            let (selected, current) = self
                .preparation
                .selected_live_thread(&chat, &bound)
                .context("The queue's native owner retired during wake delivery.")?;
            if selected != thread
                || current.session.as_ref() != Some(&session)
                || current
                    .runtime
                    .inference_router()
                    .goal_runner(&thread)
                    .as_ref()
                    != Some(&runner)
            {
                bail!("The queue's native owner changed during wake delivery.");
            }
            if should_wake(&snapshot) {
                let response = current
                    .runtime
                    .request(
                        "thread/managedExecution/wake".into(),
                        Some(json!({"threadId":thread,"runnerGeneration":runner})),
                        Some(RPC_TIMEOUT),
                        None,
                    )
                    .await?
                    .context("Codex did not acknowledge the queue wake.")?;
                if !response["scheduled"].is_boolean() {
                    bail!("Codex returned an invalid queue wake acknowledgment.");
                }
            }
        }
        scope.identity()?;
        Ok(json!({"acknowledged":true}))
    }
}

fn should_wake(snapshot: &Value) -> bool {
    if snapshot["paused"] == true {
        return false;
    }
    let claims = snapshot["claims"].as_array().unwrap();
    let awaiting_goal = claims.iter().any(|claim| {
        claim["awaitingGoal"] == true
            && claim["goalCancelled"] != true
            && claim["goalEpoch"].is_string()
            && claim["operationId"].is_string()
            && claim["operationGeneration"].is_string()
            && claim["goalOperationId"].is_null()
            && claim["goalOperationGeneration"].is_null()
            && claim["nativeTurnId"].is_null()
            && matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
    });
    if awaiting_goal || !snapshot["goalRecovery"].is_null() {
        return true;
    }
    !snapshot["items"].as_array().unwrap().iter().any(|item| {
        item["frozen"] != true
            && item["state"] == "pending"
            && !claims.iter().any(|claim| {
                claim["promptId"] == item["id"]
                    && claim["promptRevision"] == item["revision"]
                    && claim["status"] == "rejected"
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_wake_obeys_pause_fifo_and_exact_claim() {
        let mut item = json!({"id":"next","state":"pending","revision":4,"frozen":false});
        let mut awaiting = json!({
            "id":"goal","promptId":"setter","promptRevision":3,"status":"dispatched",
            "awaitingGoal":true,"goalEpoch":"epoch","operationId":"queue:goal","operationGeneration":"generation"
        });
        let rejected =
            json!({"id":"attempt","promptId":"next","promptRevision":4,"status":"rejected"});
        let mut snapshot =
            json!({"paused":false,"items":vec![item.clone()],"claims":Vec::<Value>::new()});
        assert!(!should_wake(&snapshot));
        snapshot["claims"] = json!(vec![rejected]);
        assert!(should_wake(&snapshot));
        item["revision"] = json!(5);
        snapshot["items"] = json!(vec![item.clone()]);
        assert!(!should_wake(&snapshot));
        item["frozen"] = json!(true);
        snapshot["items"] = json!(vec![item.clone()]);
        assert!(should_wake(&snapshot));
        item["frozen"] = json!(false);
        snapshot["items"] = json!(vec![item]);
        snapshot["claims"] = json!(vec![awaiting.clone()]);
        assert!(should_wake(&snapshot));
        snapshot["paused"] = json!(true);
        assert!(!should_wake(&snapshot));
        snapshot["paused"] = json!(false);
        awaiting["goalOperationGeneration"] = json!("already-started");
        snapshot["claims"] = json!(vec![awaiting]);
        assert!(!should_wake(&snapshot));
        snapshot["goalRecovery"] = json!({"threadId":"thread"});
        assert!(should_wake(&snapshot));
    }
}
