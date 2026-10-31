//! Apply the real protected event writers under the captured command fence.
mod computer_use;
use super::{CommandError, Repository, settings_persistence::text};
use crate::wire::{Value, value::json};
use anyhow::Result;
use futures::FutureExt;

pub enum PublicationKind {
    Message { message: Value, task: bool },
    Invalidation(&'static str),
}
pub struct Publication {
    pub context: Value,
    pub kind: PublicationKind,
}

impl Repository {
    /// Input has already passed nativeCommandEventSchema, just as in Source.
    pub async fn apply_event(&self, owner: &str, input: &Value) -> Result<Publication> {
        let input = input.clone();
        let worker = input["workerId"].clone();
        let operation = text(&input["operationId"])?;
        let generation = text(&input["operationGeneration"])?;
        let apply_owner = owner.to_owned();
        self.with_event_context(owner,&worker,&operation,&generation,move |context,tx| Box::pin(async move {
            let event=&input["event"];
            let worker=&input["workerId"];
            let chat=text(&context["chatId"])?;
            let attribution=json!({"contextKind":context["contextKind"],"executionLaneId":context["executionLaneId"],"worktreeId":if context["contextKind"]=="project" {context["worktreeId"].clone()} else {Value::Null},"scratchRootId":if context["contextKind"]=="standalone" {context["scratchRootId"].clone()} else {Value::Null}});
            let kind=match event["type"].as_str() {
                Some("computer-use.approval.request"|"computer-use.approval.terminal") => {
                    computer_use::apply(&tx.interactions(),&apply_owner,worker,&context,event).boxed().await?;
                    PublicationKind::Invalidation("agent-interaction")
                }
                Some("agent.protected-message"|"agent.protected-task-message") => {
                    let task=event["type"]=="agent.protected-task-message";
                    if task && context["experience"]!="task" {return Err(CommandError::new("native-event-rejected",None,409).into());}
                    let saved=if task { tx.upsert_task_message(&apply_owner,&chat,&event["message"],Some(&attribution)).boxed().await? }
                        else { tx.upsert_encrypted_message(&apply_owner,&chat,&event["message"],Some(&attribution)).boxed().await? };
                    let Some(message)=saved else {return Err(CommandError::new("native-event-rejected",None,409).into());};
                    PublicationKind::Message{message,task}
                }
                Some("agent.interaction.requested.protected") => {
                    let request=&event["request"];
                    tx.interactions().record(&json!({"requestKey":request["requestKey"],"projectId":context["projectId"],"provenance":json!({"chatId":context["chatId"],"threadId":request["threadId"],"turnId":request["turnId"],"itemId":request["itemId"],"executionLaneId":context["executionLaneId"],"workerId":worker}),"classification":request["classification"],"protectedPayload":request["protectedPayload"],"expiresAt":request["expiresAt"]}),true).boxed().await?;
                    PublicationKind::Invalidation("agent-interaction")
                }
                Some("agent.plan.protected") => {
                    tx.update_encrypted_plan(&chat,&event["state"]).await?;
                    PublicationKind::Invalidation("chat-plan")
                }
                Some("agent.interaction.cleared"|"agent.interaction.expired") => {
                    let expired=event["type"]=="agent.interaction.expired";
                    tx.interactions().terminalize(&text(&event["requestKey"])?,&chat,&text(worker)?,if expired {"expired"} else {"interrupted"},if expired {None} else {event.get("resolution")}).boxed().await?;
                    PublicationKind::Invalidation("agent-interaction")
                }
                _ => unreachable!("Validated protected native event"),
            };
            Ok(Publication{context,kind})
        })).boxed().await
    }
}
