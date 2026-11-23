use super::*;
use crate::{agent_interactions, database::Executor};
impl EventSink {
    pub(super) async fn computer_use(&self, event: &Value) -> Result<bool> {
        let e = &self.turn.execution;
        if event["type"] == "computer-use.approval.request" {
            let event =
                crate::settings::parse_response("cuaApprovalRequestEventSchema", Some(event))?;
            let r = &event["request"];
            let p = &r["provenance"];
            if p["owner"] != "computer-use"
                || p["chatId"] != e["chatId"]
                || p["workerId"] != e["workerId"]
                || p["executionLaneId"] != e["executionLaneId"]
                || r["projectId"] != e["projectId"]
                || !truthy(p.get("threadId"))
                || !truthy(p.get("turnId"))
            {
                bail!("Invalid agent computer-use approval request.");
            }
            self.dependencies
                .live
                .record_interaction(&self.turn.owner, r, true)
                .await?;
            return Ok(true);
        }
        if event["type"] == "computer-use.approval.terminal" {
            let event = crate::settings::parse_response("cuaApprovalTerminalSchema", Some(event))?;
            if event["chatId"] != e["chatId"] {
                bail!("Invalid agent computer-use approval terminal event.");
            }
            let repository = agent_interactions::Repository::new(Executor::Database(
                &self.dependencies.database,
            ));
            let existing = repository
                .get_by_key(&self.turn.owner, &text(&event["requestKey"])?)
                .await?;
            let valid = existing.as_ref().is_some_and(|r| {
                let p = &r["provenance"];
                p["owner"] == "computer-use"
                    && p["chatId"] == e["chatId"]
                    && p["workerId"] == e["workerId"]
                    && p["executionLaneId"] == e["executionLaneId"]
                    && truthy(p.get("threadId"))
                    && truthy(p.get("turnId"))
            });
            if !valid {
                bail!("Invalid agent computer-use approval terminal event.");
            }
            self.dependencies
                .live
                .terminalize_interaction(
                    &self.turn.owner,
                    &text(&event["requestKey"])?,
                    &text(&e["chatId"])?,
                    &text(&e["workerId"])?,
                    &text(&event["status"])?,
                    None,
                )
                .await?;
            return Ok(true);
        }
        Ok(false)
    }
    async fn cancel_interaction(&self, request: &Value, reason: &str) {
        let e = &self.turn.execution;
        let runtime = self.runtime.lock().unwrap().clone();
        if let Ok(worker) = text(&e["workerId"]) {
            let _=self.dependencies.commands.request(&worker,json!({"type":"agent.interaction.cancel","chatId":e["chatId"],"threadId":nullish(e.get("threadId"),&request["threadId"]),"executionProfile":if e["contextKind"]=="standalone" {"standalone-chat"}else{"ide"},"requestKey":request["requestKey"],"reason":reason,"model":runtime["model"],"provider":runtime["provider"]}),None,None).await;
        }
    }
    pub(super) async fn interaction(
        &self,
        event: &Value,
        state: &mut AttemptState,
        at: i64,
    ) -> Result<bool> {
        let e = &self.turn.execution;
        if matches!(
            event["type"].as_str(),
            Some("agent.interaction.requested" | "agent.interaction.requested.protected")
        ) {
            let protected = event["type"] == "agent.interaction.requested.protected";
            let r = &event["request"];
            if !protected && self.turn.encrypted_chat.is_some() {
                self.cancel_interaction(
                    r,
                    "Encrypted chat interactions must use the protected contract.",
                )
                .await;
                bail!("The worker emitted a visible interaction for an encrypted chat turn.");
            }
            state.behavior_turn = nullish(r.get("turnId"), &state.behavior_turn).clone();
            state
                .tracker
                .mark_approval(r["requestKey"].as_js_string().context("Approval key")?, at);
            let mut input = json!({"requestKey":r["requestKey"],"projectId":e["projectId"],"provenance":json!({"chatId":e["chatId"],"threadId":r["threadId"],"turnId":r["turnId"],"itemId":r["itemId"],"executionLaneId":e["executionLaneId"],"workerId":e["workerId"]}),"expiresAt":r["expiresAt"]});
            for key in if protected {
                &["classification", "protectedPayload"][..]
            } else {
                &["payload"][..]
            } {
                input[*key] = r[*key].clone();
            }
            if let Err(error) = self
                .dependencies
                .live
                .record_interaction(&self.turn.owner, &input, protected)
                .await
            {
                self.cancel_interaction(
                    r,
                    if protected {
                        "Cantrip could not persist the protected interaction safely."
                    } else {
                        "Cantrip could not persist the interaction safely."
                    },
                )
                .await;
                return Err(error);
            }
            return Ok(true);
        }
        if matches!(
            event["type"].as_str(),
            Some("agent.interaction.cleared" | "agent.interaction.expired")
        ) {
            self.dependencies
                .live
                .terminalize_interaction(
                    &self.turn.owner,
                    &text(&event["requestKey"])?,
                    &text(&e["chatId"])?,
                    &text(&e["workerId"])?,
                    if event["type"] == "agent.interaction.expired" {
                        "expired"
                    } else {
                        "interrupted"
                    },
                    if event["type"] == "agent.interaction.cleared" {
                        event.get("resolution")
                    } else {
                        None
                    },
                )
                .await?;
            return Ok(true);
        }
        Ok(false)
    }
}
