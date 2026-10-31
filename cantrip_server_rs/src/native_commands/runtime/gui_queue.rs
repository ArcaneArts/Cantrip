//! GUI queue requests use the same transaction authority as native requests.
use super::super::{
    CommandError, Repository,
    admit::text,
    managed_queue::{self, QueueRepository},
    queued_prompt::PromptRepository,
};
use crate::{
    database::Database,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};
use futures::FutureExt;
use std::sync::Arc;

pub struct GuiQueue {
    queue: QueueRepository,
    commands: Repository,
    prompts: PromptRepository,
}
impl GuiQueue {
    pub fn new(database: Arc<Database>) -> Self {
        Self {
            queue: QueueRepository::new(database.clone()),
            commands: Repository::new(database.clone()),
            prompts: PromptRepository::new(database),
        }
    }
    async fn prepare(
        &self,
        owner: &str,
        context: &Value,
        mutation: &Value,
        options: &Value,
    ) -> Result<Value> {
        // These are separate reads in Source. Mutation authority below performs
        // the final transactional revision, placement and activation checks.
        let chat = text(&context["chatId"])?;
        let state = self.queue.snapshot(owner, &chat).boxed().await?;
        let control = self.commands.control_context(owner, &chat).boxed().await?;
        let kind = mutation["kind"]
            .as_str()
            .context("GUI queue mutation kind")?;
        let prompt = if matches!(kind, "add" | "update") {
            mutation.get("prompt").cloned()
        } else {
            let items = state["items"]
                .as_array()
                .context("GUI queue snapshot items")?;
            let queued = items
                .iter()
                .find(|item| mutation.get("id").is_some() && item.get("id") == mutation.get("id"))
                .or_else(|| items.first())
                .cloned();
            if queued.is_some() {
                queued
            } else {
                let id = mutation
                    .get("id")
                    .filter(|id| truthy(Some(id)))
                    .or_else(|| {
                        (kind == "reorder")
                            .then(|| mutation["ids"].as_array().and_then(|ids| ids.first()))
                            .flatten()
                            .filter(|id| truthy(Some(id)))
                    });
                if let Some(id) = id {
                    self.prompts
                        .get_encrypted(owner, &text(id)?)
                        .boxed()
                        .await?
                } else {
                    None
                }
            }
        };
        let prompt = prompt
            .filter(|prompt| truthy(Some(prompt)))
            .ok_or_else(|| CommandError::new("queue-item-unavailable", None, 409))?;
        let resume = matches!(kind, "add" | "start");
        let mut intent = json!({"scope":"thread","settingKeys":Vec::<Value>::new(),"expectedTurnId":Value::Null});
        if resume {
            intent["resumeAutonomy"] = json!(true);
        }
        let digest = options
            .get("payloadDigest")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!(managed_queue::digest(&mutation.stringify())));
        Ok(json!({
            "expectedRevision":options.get("expectedRevision").filter(|v|!v.is_null()).unwrap_or(&state["revision"]),
            "mutation":mutation,
            "admission":json!({
                "workerId":context["workerId"],"operationId":options["operationId"],"origin":"gui","method":format!("thread/queue/{kind}"),
                "session":json!({"chatId":context["chatId"],"threadId":context["threadId"],"contextKind":context["contextKind"],"projectId":context["projectId"],"placementId":context["worktreeId"],"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"runtimeGeneration":control["runtimeGeneration"],"connectionId":Value::Null}),
                "payloadDigest":digest,"protectedPayload":prompt["protectedContent"]["envelope"],"expectedActivationGeneration":control["activationGeneration"],"intent":intent
            })
        }))
    }
    pub async fn mutate(
        &self,
        owner: &str,
        context: &Value,
        mutation: &Value,
        options: &Value,
    ) -> Result<Value> {
        let input = self
            .prepare(owner, context, mutation, options)
            .boxed()
            .await?;
        let mut expected = Value::object([] as [(&str, Value); 0]);
        if matches!(input["mutation"]["kind"].as_str(), Some("add" | "start"))
            && let Some(revision) = context.get("managedInputRevision")
        {
            expected["expectedInputRevision"] = revision.clone();
        }
        let result = self.queue.mutate(owner, &input, &expected).boxed().await?;
        reject(&result)?;
        Ok(result)
    }
    pub async fn lookup(
        &self,
        owner: &str,
        context: &Value,
        mutation: &Value,
        options: &Value,
    ) -> Result<Option<Value>> {
        let input = self
            .prepare(owner, context, mutation, options)
            .boxed()
            .await?;
        let result = self
            .queue
            .lookup(owner, &input["admission"])
            .boxed()
            .await?;
        if truthy(result.get("found")) {
            reject(&result)?;
            Ok(Some(result))
        } else {
            Ok(None)
        }
    }
}
fn reject(result: &Value) -> Result<()> {
    if result["receipt"]["status"] == "rejected" {
        let code = result["receipt"]
            .get("rejectionCode")
            .filter(|v| !v.is_null())
            .map(text)
            .transpose()?
            .unwrap_or_else(|| "queue-mutation-rejected".into());
        return Err(CommandError::new(code, None, 409).into());
    }
    Ok(())
}
