use super::super::CommandError;
use super::*;
use anyhow::Context;
use futures::FutureExt;

async fn validate(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    admission: &Value,
    mutation: &Value,
) -> Result<()> {
    let prompt = &mutation["prompt"];
    let mut ids = vec![prompt["modelId"].clone()];
    if truthy(prompt.get("subagentModelId")) {
        ids.push(prompt["subagentModelId"].clone())
    }
    let encoded = ids.iter().map(text).collect::<Result<Vec<_>>>()?;
    let rows = tx
        .query(
            "SELECT id FROM model_profiles WHERE owner_id=$1 AND id=ANY($2::text[])",
            &[&owner, &encoded],
        )
        .await?;
    let models = rows
        .iter()
        .map(|row| row.get::<String>(0).map(|s| json!(s)))
        .collect::<Result<Vec<_>>>()?;
    if ids.iter().any(|id| !models.contains(id)) {
        return reject("queue-model-unavailable");
    }
    if truthy(prompt.get("worktreeId")) && tx.query("SELECT w.id FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id WHERE w.id=$1 AND s.project_id=$2",&[&text(&prompt["worktreeId"])?,&text(&admission["session"]["projectId"])?]).await?.is_empty() {return reject("queue-worktree-unavailable")}
    let ids = &prompt["classification"]["attachmentIds"];
    let attachments = TransactionRepository::new(tx)
        .chat_attachments(owner, chat, ids)
        .await?;
    let ids = ids.as_array().context("Queue prompt attachments")?;
    if ids
        .iter()
        .any(|id| !attachments.iter().any(|a| a.get("id") == Some(id)))
        || mutation["attachments"]
            .as_array()
            .context("Queue mutation attachments")?
            .iter()
            .any(|a| !ids.contains(&a["id"]))
    {
        return reject("queue-attachment-unavailable");
    }
    Ok(())
}
struct Effect {
    claim: Option<Value>,
    accepted: Option<Value>,
}
async fn apply(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    effect: &mut Effect,
) -> Result<()> {
    let admission = &input["admission"];
    let chat = text(&admission["session"]["chatId"])?;
    let mutation = &input["mutation"];
    let repository = TransactionRepository::new(tx);
    let state = raw_one(
        tx,
        "SELECT to_jsonb(s)::text FROM managed_queue_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .context("Locked queue state")?;
    if state["revision"] != input["expectedRevision"] {
        return reject("queue-revision-conflict");
    }
    let prompts=tx.query("SELECT to_jsonb(p)::text FROM queued_prompts p WHERE chat_id=$1 ORDER BY position ASC,created_at ASC",&[&chat]).await?.iter().map(|r|Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?)).collect::<Result<Vec<_>>>()?;
    let kind = mutation["kind"].as_str().context("Queue mutation kind")?;
    if matches!(kind, "add" | "update") {
        validate(tx, owner, &chat, admission, mutation).await?;
    }
    match kind {
        "add" => {
            if prompts.iter().any(|p| {
                p["id"] == mutation["prompt"]["id"]
                    || p["idempotency_key"] == mutation["prompt"]["idempotencyKey"]
            }) {
                return reject("queue-item-conflict");
            }
            if repository
                .create_prompt(owner, &chat, &mutation["prompt"], &mutation["attachments"])
                .await?
                .is_none()
            {
                return reject("queue-item-unavailable");
            }
        }
        "reorder" => {
            let pending = prompts
                .iter()
                .filter(|p| p["state"] == "pending" || p["state"] == "claimed")
                .collect::<Vec<_>>();
            if pending.iter().any(|p| p["state"] == "claimed") {
                return reject("queue-item-claimed");
            }
            let ids = mutation["ids"]
                .as_array()
                .context("Queue order identifiers")?;
            if ids.len() != pending.len()
                || ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id))
                || pending.iter().any(|p| !ids.contains(&p["id"]))
            {
                return reject("queue-order-conflict");
            }
            for (position, id) in ids.iter().enumerate() {
                tx.query("UPDATE queued_prompts SET position=$1::text::integer,revision=revision+1,updated_at=$2 WHERE id=$3",&[&position.to_string(),&crate::auth::now(),&text(id)?]).await?;
            }
        }
        _ => {
            let prompt = if kind == "start" && !truthy(mutation.get("id")) {
                prompts
                    .iter()
                    .find(|p| p["state"] == "pending" && !truthy(p.get("frozen")))
            } else {
                prompts.iter().find(|p| p.get("id") == mutation.get("id"))
            };
            let Some(prompt) = prompt.filter(|p| p["state"] == "pending") else {
                return reject(if prompt.is_some_and(|p| p["state"] == "claimed") {
                    "queue-item-claimed"
                } else {
                    "queue-item-unavailable"
                });
            };
            if kind != "start" && prompt["revision"] != mutation["expectedItemRevision"] {
                return reject("queue-item-revision-conflict");
            }
            let prompt_id = text(&prompt["id"])?;
            match kind {
                "update" => {
                    if mutation["prompt"]["id"] != prompt["id"] {
                        return reject("queue-item-conflict");
                    }
                    repository
                        .replace_prompt(
                            owner,
                            &prompt["id"],
                            &mutation["prompt"],
                            &mutation["attachments"],
                        )
                        .await?;
                    tx.query(
                        "UPDATE queued_prompts SET model_id=$1,revision=revision+1 WHERE id=$2",
                        &[&text(&mutation["prompt"]["modelId"])?, &prompt_id],
                    )
                    .await?;
                }
                "delete" => {
                    tx.query("UPDATE queued_prompts SET state='removed',revision=revision+1,updated_at=$1 WHERE id=$2",&[&crate::auth::now(),&prompt_id]).await?;
                }
                "start" => {
                    let chat_row = raw_one(
                        tx,
                        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1",
                        &[&chat],
                    )
                    .await?
                    .context("Locked queue Chat")?;
                    if truthy(chat_row.get("automation_paused")) {
                        return reject("queue-paused");
                    }
                    let id = format!("queue:{}", digest(&text(&admission["operationId"])?));
                    let created=raw_one(tx,"INSERT INTO managed_queue_claims(id,request_operation_id,chat_id,prompt_id,prompt_revision) VALUES($1,$2,$3,$4,$5::text::integer) RETURNING to_jsonb(managed_queue_claims)::text",&[&id,&text(&admission["operationId"])?,&chat,&prompt_id,&prompt["revision"].stringify()]).await?.context("Queue claim insert")?;
                    effect.claim = Some(claim_value(&created)?);
                    retain_input(tx, &id, prompt).await?;
                    tx.query(
                        "UPDATE queued_prompts SET state='claimed',updated_at=$1 WHERE id=$2",
                        &[&crate::auth::now(), &prompt_id],
                    )
                    .await?;
                }
                _ => anyhow::bail!("Unknown queue mutation"),
            }
        }
    }
    bump(tx, &chat).await?;
    if truthy(admission["intent"].get("resumeAutonomy")) {
        repository.resume_autonomy(owner, &chat).await?;
    }
    if matches!(kind, "add" | "update") {
        effect.accepted = repository
            .encrypted_prompt(owner, &text(&mutation["prompt"]["id"])?)
            .await?;
    }
    let mut result = Value::object([] as [(&str, Value); 0]);
    if let Some(accepted) = &effect.accepted {
        result["acceptedItem"] = accepted.clone();
    }
    tx.query("UPDATE native_commands SET status='applied',queue_result=$1::text::jsonb,updated_at=$2 WHERE operation_id=$3",&[&result.stringify(),&crate::auth::now(),&text(&admission["operationId"])?]).await?;
    Ok(())
}
pub(crate) async fn mutate(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    options: &Value,
) -> Result<Value> {
    let admission = &input["admission"];
    let chat = text(&admission["session"]["chatId"])?;
    authority::authorize(tx, owner, &admission["workerId"], &admission["session"])
        .boxed()
        .await?;
    if replay::method(&input["mutation"]["kind"]).is_none_or(|m| admission["method"] != m) {
        return reject("queue-method-mismatch");
    }
    let repository = TransactionRepository::new(tx);
    if let Some(prior) = replay::prior(tx, owner, admission, false).boxed().await? {
        return Ok(prior);
    }
    let control = repository.control_context(owner, &chat).boxed().await?;
    let mut effective = admission.clone();
    effective["expectedActivationGeneration"] = control["activationGeneration"].clone();
    effective["session"]["runtimeGeneration"] = control["runtimeGeneration"].clone();
    let mut admission_options = json!({"canonicalQueueMutation":true});
    if let Some(revision) = options.get("expectedInputRevision") {
        admission_options["expectedInputRevision"] = revision.clone();
    }
    let grant = repository
        .admit(owner, &effective, &admission_options)
        .boxed()
        .await?;
    if grant["receipt"]["status"] != "accepted" {
        let mut result = snapshot::snapshot(tx, owner, &chat).await?;
        result["receipt"] = grant["receipt"].clone();
        return Ok(result);
    }
    let mut effect = Effect {
        claim: None,
        accepted: None,
    };
    // The source catches typed policy failures without rolling back the effect
    // block. A claim already inserted before a retained-input conflict survives.
    if let Err(error) = apply(tx, owner, input, &mut effect).boxed().await {
        let Some(error) = error.downcast_ref::<CommandError>() else {
            return Err(error);
        };
        tx.query("UPDATE native_commands SET status='rejected',rejection_code=$1,updated_at=$2 WHERE operation_id=$3",&[&error.code,&crate::auth::now(),&text(&admission["operationId"])?]).await?;
    }
    let mut result = snapshot::snapshot(tx, owner, &chat).await?;
    result["receipt"] = repository
        .get(
            owner,
            &text(&admission["workerId"])?,
            &text(&admission["operationId"])?,
            &text(&grant["receipt"]["operationGeneration"])?,
        )
        .await?;
    if let Some(claim) = effect.claim {
        result["claim"] = claim;
    }
    if let Some(accepted) = effect.accepted {
        result["acceptedItem"] = accepted;
    }
    Ok(result)
}
impl QueueRepository {
    pub async fn mutate(&self, owner: &str, input: &Value, options: &Value) -> Result<Value> {
        let (owner, input, options) = (owner.to_owned(), input.clone(), options.clone());
        self.database
            .transaction(|tx| Box::pin(async move { mutate(tx, &owner, &input, &options).await }))
            .await
    }
}
