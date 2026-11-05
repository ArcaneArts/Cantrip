use super::{Admission, raw_one, reject, text};
use crate::native_commands::goal_handoff;
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
impl Admission<'_> {
    pub(super) async fn check_queue(&self, tx: &Transaction<'_>) -> Result<()> {
        let input = self.input;
        let chat = text(&input["session"]["chatId"])?;
        if input["intent"].get("goalStatus").is_some() && input["method"] != "thread/goal/set" {
            return reject("invalid-goal-status");
        }
        if let Some(attempt) = input["intent"].get("autonomousAttempt") {
            if input["origin"] != "autonomous"
                || input["method"] != "turn/start"
                || input["intent"].get("expectedTurnId") != attempt.get("turnId")
                || (truthy(input.get("goalQueueHandoff"))
                    && attempt.get("goalEpoch") != input["goalQueueHandoff"].get("goalEpoch"))
                || input["operationId"]
                    != format!(
                        "native:{}:{}",
                        text(&attempt["runnerGeneration"])?,
                        text(&attempt["attemptId"])?
                    )
                || input["session"]["connectionId"]
                    != format!("autonomous:{}", text(&attempt["runnerGeneration"])?)
            {
                return reject("invalid-autonomous-attempt");
            }
        }
        let mut goal_claim = None;
        if truthy(input.get("goalQueueHandoff")) {
            let handoff = &input["goalQueueHandoff"];
            if input["origin"] != "autonomous" || input["method"] != "turn/start" {
                return reject("invalid-goal-handoff");
            }
            let claim = raw_one(
                tx,
                "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1",
                &[&text(&handoff["claimId"])?],
            )
            .await?;
            let parent = raw_one(
                tx,
                "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
                &[&text(&handoff["operationId"])?],
            )
            .await?;
            let valid = claim
                .as_ref()
                .zip(parent.as_ref())
                .is_some_and(|(claim, parent)| {
                    truthy(claim.get("awaiting_goal"))
                        && !truthy(claim.get("goal_operation_id"))
                        && claim["chat_id"] == input["session"]["chatId"]
                        && claim["operation_id"] == handoff["operationId"]
                        && claim["operation_generation"] == handoff["operationGeneration"]
                        && claim["goal_epoch"] == handoff["goalEpoch"]
                        && matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
                        && parent["owner_id"] == self.owner
                        && parent["worker_id"] == input["workerId"]
                        && parent["status"] == "applied"
                        && parent["method"] == "thread/goal/set"
                });
            if !valid {
                return reject("stale-goal-handoff");
            }
            if !goal_handoff::session_matches(
                tx,
                self.owner,
                &text(&input["workerId"])?,
                claim.as_ref().unwrap(),
                &parent.as_ref().unwrap()["identity"],
                &input["session"],
            )
            .await?
            {
                return reject("stale-goal-handoff");
            }
            goal_claim = claim;
        }
        if input["method"]=="thread/goal/set"&&input["intent"]["goalStatus"]!="paused"
            &&!tx.query("SELECT id FROM managed_queue_claims WHERE chat_id=$1 AND awaiting_goal=true AND status IN ('accepted','dispatched','uncertain')",&[&chat]).await?.is_empty(){return reject("queue-goal-handoff-pending");}
        if input["origin"] == "autonomous" {
            let rows = tx
                .query(
                    "SELECT managed_autonomy_stopped FROM chats WHERE id=$1",
                    &[&chat],
                )
                .await?;
            if rows
                .first()
                .map(|r| r.get::<bool>(0))
                .transpose()?
                .unwrap_or(false)
            {
                return reject("autonomy-stopped");
            }
            let queued=!tx.query("SELECT id FROM queued_prompts p WHERE chat_id=$1 AND state='pending' AND frozen=false AND NOT EXISTS(SELECT 1 FROM managed_queue_claims c WHERE c.prompt_id=p.id AND c.prompt_revision=p.revision AND c.status='rejected') LIMIT 1",&[&chat]).await?.is_empty();
            let claimed=!tx.query("SELECT id FROM managed_queue_claims WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') LIMIT 1",&[&chat]).await?.is_empty();
            if (queued || claimed) && goal_claim.is_none() {
                return reject("canonical-queue-pending");
            }
        }
        if let Some(queue_claim) = self.queue_claim.filter(|v| truthy(Some(v))) {
            let claim = raw_one(
                tx,
                "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1",
                &[&text(&queue_claim["id"])?],
            )
            .await?;
            let Some(claim) = claim.filter(|c| {
                c["chat_id"] == input["session"]["chatId"]
                    && c.get("prompt_revision") == queue_claim.get("promptRevision")
                    && c["status"] == "claimed"
                    && !truthy(c.get("operation_id"))
            }) else {
                return reject("stale-queue-claim");
            };
            let prompt = raw_one(
                tx,
                "SELECT to_jsonb(p)::text FROM queued_prompts p WHERE id=$1",
                &[&text(&claim["prompt_id"])?],
            )
            .await?;
            let method = prompt
                .as_ref()
                .and_then(|p| p["opaque_content"].get("executionMethod"))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| {
                    if prompt.as_ref().is_some_and(|p| p["mode"] == "goal") {
                        json!("thread/goal/set")
                    } else {
                        json!("turn/start")
                    }
                });
            if !prompt.is_some_and(|p| {
                p["state"] == "claimed"
                    && p["revision"] == claim["prompt_revision"]
                    && (input["method"] == method
                        || (input["method"] == "turn/steer"
                            && p["mode"] == "default"
                            && method == "turn/start"))
            }) {
                return reject("queue-action-mismatch");
            }
        }
        Ok(())
    }
}
