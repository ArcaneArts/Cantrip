//! Actual worker capture happens outside transactions; publication rechecks the
//! canonical Task and native settings binding. No client-supplied Source is used.
use super::*;
use futures::future::BoxFuture;
pub(crate) type TaskGoalCaptureReader =
    Arc<dyn Fn(Value, String) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
impl Repository {
    pub(super) async fn capture_task_goal(
        &self,
        owner: &str,
        chat: &str,
        read: TaskGoalCaptureReader,
        input: Option<&Value>,
    ) -> Result<Option<Value>> {
        let (owner, chat, input) = (owner.to_owned(), chat.to_owned(), input.cloned());
        let (first_owner, first_chat) = (owner.clone(), chat.clone());
        let before = self.database.transaction(|tx|Box::pin(async move {
            context::lock_chat(tx,&first_owner,&first_chat).await?;
            if let Some(input) = &input {
                let existing = tx.query("SELECT operation_id FROM native_runtime_handoffs WHERE operation_id=$1",&[&text(&input["operationId"])?]).await?;
                if !existing.is_empty() {return Ok(None);}
            }
            crate::chats::guard::assert_runtime_writable(tx,&first_chat,None,None,crate::chats::guard::Access::Write).await?;
            let Some(row) = task_goal::read(tx,&first_owner,&first_chat,false).await? else {return Ok(None)};
            let state = settings_persistence::get(Executor::Transaction(tx),&first_owner,&first_chat).await?.unwrap_or(Value::Null);
            if input.as_ref().is_some_and(|i|state["binding"].get("bindingId") != i.get("bindingId")) {return reject("handoff-source-replaced");}
            Ok(Some(json!({"scope":row["scope"],"cycleId":row["cycle"]["id"],
                "bindingId":state["binding"].get("bindingId").cloned().unwrap_or(Value::Null)})))
        })).await?;
        let Some(mut captured) = before else {
            return Ok(None);
        };
        let value = read(captured["scope"].clone(), text(&captured["cycleId"])?).await?;
        captured["value"] = parse("taskGoalCycleCaptureSchema", &value)?;
        Ok(Some(captured))
    }
    pub async fn read_task_source(
        &self,
        owner: &str,
        chat: &str,
        read: TaskGoalCaptureReader,
    ) -> Result<Value> {
        let Some(captured) = self.capture_task_goal(owner, chat, read, None).await? else {
            return reject("handoff-task-goal-source-required");
        };
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &owner, &chat).await?;
                    let (scope, value, before_id) = (
                        &captured["scope"],
                        &captured["value"],
                        &captured["bindingId"],
                    );
                    let snapshot = &value["snapshot"];
                    crate::chats::guard::assert_runtime_writable(
                        tx,
                        &chat,
                        Some(&text(&snapshot["context"]["runtimeGeneration"])?),
                        Some(&text(&snapshot["context"]["settingsVersion"]["epoch"])?),
                        crate::chats::guard::Access::Write,
                    )
                    .await?;
                    let Some(row) = task_goal::read(tx, &owner, &chat, false).await? else {
                        return reject("handoff-task-goal-source-replaced");
                    };
                    task_goal::assert_record(&row, scope, &value["record"], None)?;
                    if ["workerId", "chatId", "threadId"]
                        .iter()
                        .any(|key| snapshot["context"].get(key) != scope.get(key))
                    {
                        return reject("handoff-task-goal-source-replaced");
                    }
                    let scoped = crate::native_commands::model_attribution::scoped(
                        tx, &owner, scope, snapshot,
                    )
                    .await?;
                    settings_persistence::change(tx, &chat, |state| {
                        if state["binding"]
                            .get("bindingId")
                            .cloned()
                            .unwrap_or(Value::Null)
                            != *before_id
                            || !state["pending"].as_array().is_some_and(Vec::is_empty)
                        {
                            return reject("handoff-source-replaced");
                        }
                        let mut source = scope.clone();
                        source["runtimeGeneration"] =
                            snapshot["context"]["runtimeGeneration"].clone();
                        source["nativeEpoch"] =
                            snapshot["context"]["settingsVersion"]["epoch"].clone();
                        let mut current = state["binding"].clone();
                        if let Value::Object(fields) = &mut current {
                            fields.retain(|key, _| key.as_str() != Some("bindingId"));
                        }
                        let previous = state["binding"].get("bindingId");
                        let id = if truthy(previous)
                            && deep_equal(&current, &source)
                            && state["effective"]["protectedContent"].get("keyRevision")
                                == snapshot["protectedContent"].get("keyRevision")
                        {
                            previous.unwrap().clone()
                        } else {
                            json!(uuid::Uuid::new_v4().to_string())
                        };
                        source["bindingId"] = id;
                        settings_state::bind(state, before_id, &source, &scoped)
                    })
                    .await
                })
            })
            .await
    }
    pub(super) async fn task_context(
        &self,
        owner: &str,
        state: &Value,
        provider: &Value,
    ) -> Result<Value> {
        let (owner, state, provider) = (owner.to_owned(), state.clone(), provider.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let chat = text(&state["chatId"])?;
            context::lock_chat(tx,&owner,&chat).await?;
            let stored = one(Executor::Transaction(tx),"SELECT to_jsonb(h)::text FROM native_runtime_handoffs h WHERE operation_id=$1 AND owner_id=$2",&[&text(&state["operationId"])?,&owner]).await?;
            let Some(stored) = stored else {return reject("handoff-phase-conflict")};
            let current = wire(&stored)?;
            if current.get("phase") != state.get("phase") || current.get("updatedAt") != state.get("updatedAt") {return reject("handoff-phase-conflict");}
            let binding = stored.get("binding").filter(|value|!value.is_null()).unwrap_or(&stored["source"]);
            guards::assert_source(tx,&owner,binding,&stored["queued_source"],stored["cancel_requested"]==true).await?;
            let Some(row) = task_goal::read(tx,&owner,&chat,stored["cancel_requested"]==true).await? else {return reject("handoff-task-goal-source-replaced")};
            let source = &state["queuedSource"]["taskGoal"];
            let cycle = &source["identity"]["recovery"]["taskGoalCycle"];
            let epoch = cycle["orderEpoch"].as_i64().context("Task Goal queue order")? + i64::from(provider != source["identity"]["providerId"]);
            let mut result = json!({"chatId":chat,"projectId":row["context"]["projectId"],
                "worktreeId":row["context"]["worktreeId"],"rootKind":row["context"]["rootKind"],
                "computerUseEnabled":row["context"]["computerUseEnabled"]==true,
                "cycleId":cycle["cycleId"],"goalEpoch":cycle["goalEpoch"],"orderEpoch":epoch});
            if let Some(os) = row["context"].get("osExecution") {result["osExecution"] = os.clone();}
            parse("nativeRuntimeHandoffTaskContextSchema",&result)
        })).await
    }
}
