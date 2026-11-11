use super::*;
impl Repository {
    pub async fn append_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        if attribution.is_some_and(|a| a["contextKind"] == "standalone") {
            anyhow::bail!("Standalone Chat messages must use protected content.")
        }
        let executor = Executor::Database(&self.database);
        let Some(current) = project_chat(executor, owner, chat, false).await? else {
            return Ok(None);
        };
        let active = lane(executor, chat, &current, attribution).await?;
        if attribution.is_some() && active.is_none() {
            return Ok(None);
        }
        if truthy(input.get("idempotencyKey"))
            && let Some(saved) = raw_key(executor, chat, &text(&input["idempotencyKey"])?).await?
        {
            return messages::plain(&saved).map(Some);
        }
        let worktree = attribution
            .map(|a| nullish(a.get("worktreeId"), &current["active_worktree_id"]))
            .unwrap_or(&current["active_worktree_id"]);
        let fields = vec![
            ("id", json!(uuid::Uuid::new_v4().to_string())),
            ("chat_id", json!(chat)),
            ("worktree_id", worktree.clone()),
            ("execution_lane_id", json!(active)),
            ("role", input["role"].clone()),
            (
                "mode",
                nullish(input.get("mode"), &json!("default")).clone(),
            ),
            ("content", input["content"].clone()),
            ("reasoning_effort", input["reasoningEffort"].clone()),
            ("idempotency_key", input["idempotencyKey"].clone()),
        ];
        let rows = insert(executor, fields).await?;
        let saved = required(&rows, "appending a chat message")?;
        touch(executor, chat).await?;
        messages::plain(&saved).map(Some)
    }
    pub async fn upsert_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        let executor = Executor::Database(&self.database);
        let Some(saved) = owned_key(
            executor,
            owner,
            chat,
            &text(&input["idempotencyKey"])?,
            MessageKind::Plain,
        )
        .await?
        else {
            return self.append_message(owner, chat, input, attribution).await;
        };
        let fields = vec![
            ("role", input["role"].clone()),
            ("mode", nullish(input.get("mode"), &saved["mode"]).clone()),
            ("content", input["content"].clone()),
            (
                "reasoning_effort",
                input
                    .get("reasoningEffort")
                    .unwrap_or(&saved["reasoningEffort"])
                    .clone(),
            ),
        ];
        let rows = update(executor, &text(&saved["id"])?, fields).await?;
        touch(executor, chat).await?;
        messages::plain(&required(&rows, "updating a chat message")?).map(Some)
    }
}
pub(crate) async fn append_task_with(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: Option<&Value>,
) -> Result<Option<Value>> {
    append_task_impl(
        executor,
        owner,
        chat,
        input,
        attribution,
        TaskAppend::Ordinary,
    )
    .await
}
pub(crate) async fn append_task_history_with(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: &Value,
) -> Result<Option<Value>> {
    append_task_impl(
        executor,
        owner,
        chat,
        input,
        Some(attribution),
        TaskAppend::Historical,
    )
    .await
}
pub(crate) async fn append_task_round_outcome_with(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: &Value,
    streamed_root: bool,
) -> Result<Option<Value>> {
    let mode = if streamed_root {
        TaskAppend::StreamedRoundOutcome
    } else {
        TaskAppend::Ordinary
    };
    append_task_impl(executor, owner, chat, input, Some(attribution), mode).await
}
#[derive(PartialEq)]
enum TaskAppend {
    Ordinary,
    Historical,
    StreamedRoundOutcome,
}
async fn append_task_impl(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: Option<&Value>,
    mode: TaskAppend,
) -> Result<Option<Value>> {
    if attribution.is_some_and(|a| a["contextKind"] == "standalone") {
        anyhow::bail!("Standalone Chats do not support Task messages.")
    }
    let input = crate::settings::parse_response("taskMessageOpaqueContentSchema", Some(input))?;
    let historical = mode == TaskAppend::Historical;
    if historical && (attribution.is_none() || input["classification"]["role"] != "assistant") {
        anyhow::bail!("Historical Task messages require an attributed assistant response.");
    }
    let current = if historical {
        let rows=executor.query("SELECT to_jsonb(c)::text FROM chats c JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 AND c.experience='task' LIMIT 1",&[&owner,&chat]).await?;
        rows.first().map(catalog::raw).transpose()?
    } else {
        project_chat(executor, owner, chat, true).await?
    };
    let Some(current) = current else {
        return Ok(None);
    };
    let active = lane(executor, chat, &current, attribution).await?;
    if attribution.is_some() && active.is_none() && !historical {
        return Ok(None);
    }
    if let Some(saved) = raw_key(executor, chat, &text(&input["idempotencyKey"])?).await? {
        if saved["id"] != input["id"]
            || saved["role"] != input["classification"]["role"]
            || saved["mode"] != input["classification"]["mode"]
            || saved["reasoning_effort"] != input["reasoningEffort"]
            || saved["task_attachment_ids"].stringify()
                != input["classification"]["attachmentIds"].stringify()
        {
            anyhow::bail!("Encrypted Task message idempotency metadata is inconsistent.")
        }
        let message = messages::task(&saved)?;
        if message["protectedContent"] == input["protectedContent"] {
            return Ok(Some(message));
        }
        if mode != TaskAppend::StreamedRoundOutcome
            || saved["role"] != "assistant"
            || saved["execution_lane_id"] != json!(active)
            || !attribution.is_some_and(|a| saved["worktree_id"] == a["worktreeId"])
            || message["protectedContent"]["keyRevision"]
                != input["protectedContent"]["keyRevision"]
        {
            anyhow::bail!("Encrypted Task message idempotency metadata is inconsistent.")
        }
        // The HTTP outcome can overtake the final worker event for this
        // message. Settle the exact envelope while the round still owns it.
        let rows = update(
            executor,
            &text(&input["id"])?,
            vec![("task_protected_content", input["protectedContent"].clone())],
        )
        .await?;
        touch(executor, chat).await?;
        return messages::task(&required(&rows, "settling a streamed Task message")?).map(Some);
    }
    let worktree = attribution
        .map(|a| nullish(a.get("worktreeId"), &current["active_worktree_id"]))
        .unwrap_or(&current["active_worktree_id"]);
    let mut fields = protected_fields(&input, true);
    fields.extend([
        ("id", input["id"].clone()),
        ("chat_id", json!(chat)),
        ("worktree_id", worktree.clone()),
        ("execution_lane_id", json!(active)),
        ("content", Value::Null),
        ("idempotency_key", input["idempotencyKey"].clone()),
    ]);
    let rows = insert(executor, fields).await?;
    if !historical {
        touch(executor, chat).await?;
    }
    messages::task(&required(&rows, "appending a Task message")?).map(Some)
}
fn is_task_streamed_answer(input: &Value) -> bool {
    input["classification"]["role"] == "assistant"
        && input["idempotencyKey"]
            .as_str()
            .is_some_and(|key| key.starts_with("agent-message:"))
}
pub(crate) async fn upsert_task_with(
    executor: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    input: &Value,
    attribution: Option<&Value>,
) -> Result<Option<Value>> {
    let input = crate::settings::parse_response("taskMessageOpaqueContentSchema", Some(input))?;
    let streamed = is_task_streamed_answer(&input);
    if streamed {
        // The outcome transaction already locks the chat before changing its
        // message and terminal. Serialize the stream writer with that commit.
        executor
            .query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", &[&chat])
            .await?;
    }
    let Some(saved) = owned_key(
        executor,
        owner,
        chat,
        &text(&input["idempotencyKey"])?,
        MessageKind::Task,
    )
    .await?
    else {
        return append_task_with(executor, owner, chat, &input, attribution).await;
    };
    if saved["id"] != input["id"] {
        anyhow::bail!("Encrypted Task message update targets another row.")
    }
    if streamed && !executor.query(
        "SELECT 1 FROM task_planning_rounds WHERE chat_id=$1 AND assistant_message_id=$2 AND kind='direct' AND status='completed' AND inference_input #>> '{terminal,projectedAt}' IS NOT NULL LIMIT 1",
        &[&chat,&text(&input["id"])?],
    ).await?.is_empty() {
        return Ok(Some(saved));
    }
    let rows = update(
        executor,
        &text(&input["id"])?,
        protected_fields(&input, true),
    )
    .await?;
    touch(executor, chat).await?;
    messages::task(&required(&rows, "updating an encrypted Task message")?).map(Some)
}
impl Repository {
    pub async fn append_task_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        append_task_with(
            Executor::Database(&self.database),
            owner,
            chat,
            input,
            attribution,
        )
        .await
    }
    pub async fn upsert_task_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        if is_task_streamed_answer(input) {
            let (owner, chat, input, attribution) = (
                owner.to_owned(),
                chat.to_owned(),
                input.clone(),
                attribution.cloned(),
            );
            return self
                .database
                .transaction(|tx| {
                    Box::pin(async move {
                        upsert_task_with(
                            Executor::Transaction(tx),
                            &owner,
                            &chat,
                            &input,
                            attribution.as_ref(),
                        )
                        .await
                    })
                })
                .await;
        }
        upsert_task_with(
            Executor::Database(&self.database),
            owner,
            chat,
            input,
            attribution,
        )
        .await
    }
    pub async fn set_message_model_route(
        &self,
        owner: &str,
        id: &str,
        model: &str,
        runtime: &Value,
        reasoning: Option<&Value>,
        kind: MessageKind,
    ) -> Result<Option<Value>> {
        let default = json!({"appliedReasoningEffort":Value::Null,"reasoningAdjusted":false});
        let reasoning = reasoning.unwrap_or(&default);
        let fields = vec![
            ("model_id", json!(model)),
            ("model_route_id", runtime["routeId"].clone()),
            ("provider_id", runtime["provider"]["id"].clone()),
            ("provider_name", runtime["provider"]["name"].clone()),
            ("provider_model_name", runtime["model"]["name"].clone()),
            (
                "applied_reasoning_effort",
                reasoning["appliedReasoningEffort"].clone(),
            ),
            ("reasoning_adjusted", reasoning["reasoningAdjusted"].clone()),
        ];
        let (mut parameters, binds) = parameters(&fields)?;
        let message_index = parameters.len() + 1;
        parameters.push(Box::new(id.to_owned()));
        let owner_index = parameters.len() + 1;
        parameters.push(Box::new(owner.to_owned()));
        let encrypted = matches!(kind, MessageKind::Encrypted);
        let column = if encrypted {
            "protected_content"
        } else if matches!(kind, MessageKind::Task) {
            "task_protected_content"
        } else {
            "content"
        };
        let joins = if encrypted {
            ""
        } else {
            "INNER JOIN projects p ON p.id=c.project_id"
        };
        let owner_field = if encrypted { "c" } else { "p" };
        let assignments = fields
            .iter()
            .zip(binds)
            .map(|((k, _), value)| {
                if encrypted {
                    format!(
                        "{k}=CASE WHEN native_model_attribution IS NULL THEN {value} ELSE {k} END"
                    )
                } else {
                    format!("{k}={value}")
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        let refs = parameters
            .iter()
            .map(|p| p.as_ref() as &(dyn postgres_types::ToSql + Sync))
            .collect::<Vec<_>>();
        let rows=checked(self.database.query(&format!("UPDATE chat_messages SET {assignments} WHERE id=${message_index} AND {column} IS NOT NULL AND EXISTS(SELECT c.id FROM chats c {joins} WHERE c.id=chat_messages.chat_id AND {owner_field}.owner_id=${owner_index}) RETURNING to_jsonb(chat_messages)::text"),&refs).await,&fields.into_iter().map(|(_,v)|v).collect::<Vec<_>>())?;
        rows.first()
            .map(|row| kind.map(&catalog::raw(row)?))
            .transpose()
    }
}
