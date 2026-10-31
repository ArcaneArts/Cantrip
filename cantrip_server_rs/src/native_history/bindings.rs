use super::*;
use crate::{
    native_commands::context,
    wire::{coercion::truthy, value::json},
};

fn mapped(row: &Value) -> Result<Value> {
    let created = chrono::DateTime::parse_from_rfc3339(&text(&row["created_at"])?)?;
    let mut result = json!({"id":row["id"],"chatId":row["chat_id"],"workerId":row["worker_id"],"threadId":row["thread_id"],"projectId":row["project_id"],"worktreeId":row["worktree_id"],"modelRouteId":row["model_route_id"],"providerAccountId":row["provider_account_id"],"createdFromOperationId":row["created_from_operation_id"],"createdAt":crate::auth::iso(created.to_utc())});
    if row["ancestor_thread_ids"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        result["ancestorThreadIds"] = row["ancestor_thread_ids"].clone();
    }
    crate::settings::parse_response("nativeHistoryBindingSchema", Some(&result))
}

/// Same project/chat serialization as native admission, without borrowing its
/// active lane, runtime, settings or computer-use permission.
async fn lock_chat(tx: &Transaction<'_>, owner: &str, worker: &str, chat: &str) -> Result<Value> {
    if let Err(error) = context::lock_chat(tx, owner, chat).await {
        if error
            .downcast_ref::<crate::native_commands::CommandError>()
            .is_some_and(|e| e.code == "chat-not-found")
        {
            return reject("chat-not-found", 404);
        }
        return Err(error);
    }
    let row = one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        &[&chat, &owner],
    )
    .await?
    .context("Locked native history chat disappeared")?;
    if row["experience"] != "agent"
        || row["context_kind"] != "project"
        || !truthy(row.get("project_id"))
    {
        return reject("ineligible-chat", 409);
    }
    if tx
        .query(
            "SELECT id FROM workers WHERE id=$1 AND owner_id=$2",
            &[&worker, &owner],
        )
        .await?
        .is_empty()
    {
        return reject("worker-not-found", 404);
    }
    Ok(row)
}

/// Caller owns this transaction for both the historical binding and its writes.
pub(super) async fn owned(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    chat: &str,
    binding: &str,
) -> Result<Value> {
    lock_chat(tx, owner, worker, chat).await?;
    let row = one(tx,"SELECT to_jsonb(b)::text FROM native_history_bindings b WHERE id=$1 AND owner_id=$2 AND worker_id=$3 AND chat_id=$4 FOR UPDATE",&[&binding,&owner,&worker,&chat]).await?;
    match row {
        Some(row) => mapped(&row),
        None => reject("binding-not-found", 404),
    }
}

impl Repository {
    pub async fn open_binding(&self, owner: &str, raw: &Value) -> Result<Value> {
        let input = crate::settings::parse_response("nativeHistoryBindingOpenSchema", Some(raw))?;
        let owner = owner.to_owned();
        self.database
            .transaction(|tx| Box::pin(async move { open(tx, &owner, &input).await }))
            .await
    }
    pub async fn read_owned_binding(
        &self,
        owner: &str,
        worker: &str,
        chat: &str,
        binding: &str,
    ) -> Result<Value> {
        let (owner, worker, chat, binding) = (
            owner.to_owned(),
            worker.to_owned(),
            chat.to_owned(),
            binding.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move { owned(tx, &owner, &worker, &chat, &binding).await })
            })
            .await
    }
}

async fn open(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let worker = text(&input["workerId"])?;
    let chat = text(&input["chatId"])?;
    let thread = text(&input["threadId"])?;
    let chat_row = lock_chat(tx, owner, &worker, &chat).await?;
    let existing=one(tx,"SELECT to_jsonb(b)::text FROM native_history_bindings b WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND thread_id=$4",&[&owner,&worker,&chat,&thread]).await?;
    let provenance = &input["provenance"];
    if provenance["kind"] == "binding" {
        return match existing {
            Some(row) if row["id"] == provenance["bindingId"] => mapped(&row),
            _ => reject("binding-not-found", 404),
        };
    }
    let mut ancestors = Vec::new();
    let parent = if provenance["kind"] == "child" {
        let id = text(&provenance["parentBindingId"])?;
        let parent=one(tx,"SELECT to_jsonb(b)::text FROM native_history_bindings b WHERE id=$1 AND owner_id=$2 AND worker_id=$3 AND chat_id=$4",&[&id,&owner,&worker,&chat]).await?;
        let Some(parent) = parent else {
            return reject("parent-binding-not-found", 404);
        };
        ancestors = parent["ancestor_thread_ids"]
            .as_array()
            .context("Native history ancestry")?
            .clone();
        ancestors.push(parent["thread_id"].clone());
        if ancestors.iter().any(|id| id == &input["threadId"]) || ancestors.len() > 31 {
            return reject("invalid-child-ancestry", 409);
        }
        if existing
            .as_ref()
            .is_some_and(|row| row["ancestor_thread_ids"] != json!(ancestors.clone()))
        {
            return reject("child-parent-mismatch", 409);
        }
        Some(parent)
    } else {
        None
    };
    if let Some(row) = existing {
        return mapped(&row);
    }
    let source = if let Some(parent) = parent {
        json!({"projectId":parent["project_id"],"worktreeId":parent["worktree_id"],"modelRouteId":parent["model_route_id"],"providerAccountId":parent["provider_account_id"],"createdFromOperationId":parent["created_from_operation_id"]})
    } else if provenance["kind"] == "current" {
        let current = context::execution(tx, owner, &chat).await?;
        let Some(mut current) = current.filter(|c| {
            c["contextKind"] == "project"
                && c["workerId"] == input["workerId"]
                && c["threadId"] == input["threadId"]
        }) else {
            return reject("thread-not-bound", 409);
        };
        current["createdFromOperationId"] = Value::Null;
        current
    } else {
        let operation = text(&provenance["operationId"])?;
        let generation = text(&provenance["operationGeneration"])?;
        let command=one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND worker_id=$4 AND chat_id=$5",&[&operation,&generation,&owner,&worker,&chat]).await?;
        let Some(command) =
            command.filter(|c| c["kind"] == "start" && truthy(c.get("execution_lane_id")))
        else {
            return reject("command-not-bound", 409);
        };
        let session = crate::settings::parse_response(
            "nativeCommandSessionSchema",
            Some(&command["identity"]),
        )?;
        if session["contextKind"] != "project"
            || session["chatId"] != input["chatId"]
            || session["threadId"] != input["threadId"]
            || session["projectId"] != chat_row["project_id"]
        {
            return reject("command-thread-mismatch", 409);
        }
        let lane = text(&command["execution_lane_id"])?;
        let placement = text(&session["placementId"])?;
        if tx
            .query(
                "SELECT id FROM chat_execution_lanes WHERE id=$1 AND chat_id=$2 AND worktree_id=$3",
                &[&lane, &chat, &placement],
            )
            .await?
            .is_empty()
        {
            return reject("command-placement-mismatch", 409);
        }
        json!({"projectId":chat_row["project_id"],"worktreeId":session["placementId"],"modelRouteId":session["modelRouteId"],"providerAccountId":session["providerAccountId"],"createdFromOperationId":command["operation_id"]})
    };
    let id = uuid::Uuid::new_v4().to_string();
    let project = text(&source["projectId"])?;
    let worktree = text(&source["worktreeId"])?;
    let route = optional(&source["modelRouteId"])?;
    let account = optional(&source["providerAccountId"])?;
    let operation = optional(&source["createdFromOperationId"])?;
    let ancestors = json!(ancestors).stringify();
    let row=one(tx,"INSERT INTO native_history_bindings(id,owner_id,worker_id,chat_id,thread_id,ancestor_thread_ids,project_id,worktree_id,model_route_id,provider_account_id,created_from_operation_id) VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9,$10,$11) RETURNING to_jsonb(native_history_bindings)::text",&[&id,&owner,&worker,&chat,&thread,&ancestors,&project,&worktree,&route,&account,&operation]).await?.context("No row returned binding native history")?;
    mapped(&row)
}
