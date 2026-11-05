use super::*;
pub(super) async fn complete_operation_in(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    operation: &str,
    result: &Value,
    turn: Option<&str>,
    guard: Option<&Value>,
) -> Result<Option<Value>> {
    if let Some(guard) = guard {
        dispatch_fence::assert(tx, owner, chat, operation, guard, false).await?;
    }
    let Some(round) = locked_round(tx, chat, operation).await? else {
        return Ok(None);
    };
    if !policy::same_operation(result, &round["relay_request"])
        || result["chatId"] != chat
        || result["operationId"] != operation
        || result["classification"]["kind"] != round["kind"]
        || result["classification"]["ordinal"] != round["ordinal"]
    {
        return conflict(
            "idempotency-conflict",
            "The encrypted Task result does not match its operation.",
        );
    }
    let Some(task) = locked_task(tx, chat).await? else {
        return Ok(None);
    };
    if truthy(round.get("relay_result")) {
        if round["relay_result"]["fingerprint"] != result["fingerprint"] {
            return conflict(
                "idempotency-conflict",
                "A different encrypted result already completed this operation.",
            );
        }
        return context(&task, &round).map(Some);
    }
    if task["active_operation_id"] != operation || task["planning_round"] != round["ordinal"] {
        return conflict(
            "idempotency-conflict",
            "A newer Task operation superseded this result.",
        );
    }
    let now = now();
    let mut fields = round_columns(&result["classification"], &result["protectedResult"]);
    fields["relay_result"] = result.clone();
    fields["failure_task"] = result["goal"]
        .get("failureTask")
        .filter(|v| !v.is_null())
        .unwrap_or(&round["failure_task"])
        .clone();
    fields["turn_id"] = json!(turn);
    fields["completed_at"] = now.clone();
    let updated_round = update(tx, Table::Round, operation, &fields, None)
        .await?
        .context("Task round completion returned no row")?;
    let updated_task = if round["kind"] != "finalize" {
        let mut fields = task_columns(&result["task"]);
        fields["active_operation_id"] = Value::Null;
        fields["completed_at"] = if result["task"]["classification"]["state"] == "complete" {
            now.clone()
        } else {
            Value::Null
        };
        fields["row_version"] = increment(&task["row_version"]);
        fields["updated_at"] = now;
        update(tx, Table::Task, chat, &fields, None)
            .await?
            .context("Task completion returned no row")?
    } else {
        task
    };
    context(&updated_task, &updated_round).map(Some)
}
impl Repository {
    pub async fn complete_operation(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        result: &Value,
        turn: Option<&str>,
    ) -> Result<Option<Value>> {
        self.complete_operation_guarded(owner, chat, operation, result, turn, None)
            .await
    }
    pub(crate) async fn complete_operation_fenced(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        result: &Value,
        turn: Option<&str>,
        lease: &Value,
    ) -> Result<Option<Value>> {
        let guard = json!({"kind":"leased","lease":lease});
        self.complete_operation_guarded(owner, chat, operation, result, turn, Some(&guard))
            .await
    }
    pub(crate) async fn complete_operation_guarded(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        result: &Value,
        turn: Option<&str>,
        guard: Option<&Value>,
    ) -> Result<Option<Value>> {
        let result = parse("taskOperationRelayResultSchema", result)?;
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (chat, operation, turn) = (
            chat.to_owned(),
            operation.to_owned(),
            turn.map(str::to_owned),
        );
        let (owner, guard) = (owner.to_owned(), guard.cloned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    complete_operation_in(
                        tx,
                        &owner,
                        &chat,
                        &operation,
                        &result,
                        turn.as_deref(),
                        guard.as_ref(),
                    )
                    .await
                })
            })
            .await
    }
    pub async fn complete_finalization_operation(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
    ) -> Result<Option<Value>> {
        self.complete_finalization_operation_guarded(owner, chat, operation, None)
            .await
    }
    pub async fn complete_finalization_operation_guarded(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        guard: Option<&Value>,
    ) -> Result<Option<Value>> {
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (owner, chat, operation, guard) = (
            owner.to_owned(),
            chat.to_owned(),
            operation.to_owned(),
            guard.cloned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    if let Some(guard) = &guard {
                        dispatch_fence::assert(tx, &owner, &chat, &operation, guard, false).await?;
                    }
                    let Some(round) = locked_round(tx, &chat, &operation)
                        .await?
                        .filter(|r| truthy(r.get("relay_result")) && r["kind"] == "finalize")
                    else {
                        return Ok(None);
                    };
                    let Some(task) = locked_task(tx, &chat).await? else {
                        return Ok(None);
                    };
                    if task["state"] == "implementing"
                        && task["planning_round"] == round["ordinal"]
                        && task["active_operation_id"].is_null()
                    {
                        return context(&task, &round).map(Some);
                    }
                    if task["active_operation_id"] != operation
                        && !(task["state"] == "failed"
                            && task["planning_round"] == round["ordinal"])
                    {
                        return conflict(
                            "idempotency-conflict",
                            "A newer Task operation superseded Goal startup.",
                        );
                    }
                    let now = now();
                    let mut fields = task_columns(&round["relay_result"]["task"]);
                    fields["active_operation_id"] = Value::Null;
                    fields["implementation_started_at"] =
                        if task["implementation_started_at"].is_null() {
                            now.clone()
                        } else {
                            task["implementation_started_at"].clone()
                        };
                    fields["row_version"] = increment(&task["row_version"]);
                    fields["updated_at"] = now;
                    let updated = update(tx, Table::Task, &chat, &fields, None)
                        .await?
                        .context("Task finalization returned no row")?;
                    context(&updated, &round).map(Some)
                })
            })
            .await
    }
    pub async fn fail_operation(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        goal_launch_failure: Option<&Value>,
    ) -> Result<Option<Value>> {
        self.fail_operation_guarded(owner, chat, operation, goal_launch_failure, None)
            .await
    }
    pub(crate) async fn fail_operation_fenced(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        goal_launch_failure: Option<&Value>,
        guard: &Value,
    ) -> Result<Option<Value>> {
        self.fail_operation_guarded(owner, chat, operation, goal_launch_failure, Some(guard))
            .await
    }
    pub(crate) async fn fail_operation_guarded(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        goal_launch_failure: Option<&Value>,
        guard: Option<&Value>,
    ) -> Result<Option<Value>> {
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (chat, operation, failure) = (
            chat.to_owned(),
            operation.to_owned(),
            goal_launch_failure.cloned(),
        );
        let (owner, guard) = (owner.to_owned(), guard.cloned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    if let Some(guard) = &guard {
                        dispatch_fence::assert(tx, &owner, &chat, &operation, guard, false).await?;
                    }
                    let Some(round) = locked_round(tx, &chat, &operation).await? else {
                        return Ok(None);
                    };
                    let Some(task) = locked_task(tx, &chat).await? else {
                        return Ok(None);
                    };
                    let failure = if let Some(failure) = failure {
                        let failure = parse("taskOpaqueContentSchema", &failure)?;
                        let c = &failure["classification"];
                        let expected = round["relay_result"].get("task");
                        let matches = expected.is_some_and(|expected| {
                            [
                                "planAuthorship",
                                "hasPlan",
                                "hasQuestions",
                                "hasFinalPlan",
                                "hasGoalPrompt",
                            ]
                            .iter()
                            .all(|k| c[*k] == expected["classification"][*k])
                                && failure["protectedContent"]["keyRevision"]
                                    == expected["protectedContent"]["keyRevision"]
                        });
                        if round["kind"] != "finalize"
                            || !matches
                            || c["state"] != "failed"
                            || c["stableStateBeforeFailure"] != "review"
                            || !c["activeOperationKind"].is_null()
                            || c["planningRound"] != round["ordinal"]
                            || !c["lastError"]["code"]
                                .as_str()
                                .and_then(|code| code.strip_prefix("task-goal-start-"))
                                .is_some_and(|kind| {
                                    matches!(
                                        kind,
                                        "failed"
                                            | "timeout"
                                            | "capacity"
                                            | "rate-limit"
                                            | "connection"
                                            | "needs-input"
                                            | "configuration"
                                            | "usage-limit"
                                            | "budget-limit"
                                    )
                                })
                            || c["lastError"].get("operationKind") != Some(&json!("finalize"))
                        {
                            return conflict(
                                "idempotency-conflict",
                                "The encrypted Goal startup failure does not match finalization.",
                            );
                        }
                        Some(failure)
                    } else {
                        None
                    };
                    if task["state"] == "failed" && task["planning_round"] == round["ordinal"] {
                        return context(&task, &round).map(Some);
                    }
                    let now = now();
                    let mut fields = round_columns(
                        &round["failure_round"]["classification"],
                        &round["failure_round"]["protectedContent"],
                    );
                    fields["completed_at"] = now.clone();
                    let updated_round = update(tx, Table::Round, &operation, &fields, None)
                        .await?
                        .context("Task round failure returned no row")?;
                    let updated_task = if task["planning_round"] == round["ordinal"] {
                        let mut fields =
                            task_columns(failure.as_ref().unwrap_or(&round["failure_task"]));
                        fields["active_operation_id"] = Value::Null;
                        fields["row_version"] = increment(&task["row_version"]);
                        fields["updated_at"] = now;
                        update(tx, Table::Task, &chat, &fields, None)
                            .await?
                            .context("Task failure returned no row")?
                    } else {
                        task
                    };
                    context(&updated_task, &updated_round).map(Some)
                })
            })
            .await
    }
    pub async fn reconcile_interrupted_operations(&self) -> Result<usize> {
        let rows=self.database.query("SELECT json_build_object('task',to_jsonb(t),'round',to_jsonb(r))::text FROM tasks t JOIN task_planning_rounds r ON r.id=t.active_operation_id WHERE r.inference_input IS NULL",&[]).await?;
        let mut reconciled = 0;
        for row in &rows {
            let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
            let changed = self
                .database
                .transaction(|tx| {
                    Box::pin(async move {
                        let task = &row["task"];
                        let round = &row["round"];
                        let current =
                            locked_round(tx, &text(&task["chat_id"])?, &text(&round["id"])?)
                                .await?;
                        if current.is_none_or(|r| !r["inference_input"].is_null()) {
                            return Ok(false);
                        }
                        let now = now();
                        let mut fields = round_columns(
                            &round["failure_round"]["classification"],
                            &round["failure_round"]["protectedContent"],
                        );
                        fields["completed_at"] = now.clone();
                        update(tx, Table::Round, &text(&round["id"])?, &fields, None).await?;
                        let mut fields = task_columns(&round["failure_task"]);
                        fields["active_operation_id"] = Value::Null;
                        fields["row_version"] = increment(&task["row_version"]);
                        fields["updated_at"] = now;
                        update(
                            tx,
                            Table::Task,
                            &text(&task["chat_id"])?,
                            &fields,
                            Some(("active_operation_id", &round["id"])),
                        )
                        .await?;
                        Ok(true)
                    })
                })
                .await?;
            if changed {
                reconciled += 1;
            }
        }
        Ok(reconciled)
    }
    pub async fn sync_implementation_state(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        self.sync_implementation_state_guarded(owner, chat, input, None)
            .await
    }
    pub async fn sync_implementation_state_guarded(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        guard: Option<&Value>,
    ) -> Result<Option<Value>> {
        let next = parse("taskOpaqueContentSchema", &input["task"])?;
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (owner, chat, version, guard) = (
            owner.to_owned(),
            chat.to_owned(),
            input["rowVersion"].clone(),
            guard.cloned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    if let Some(guard) = &guard {
                        dispatch_fence::assert(
                            tx,
                            &owner,
                            &chat,
                            &text(&guard["lease"]["operationId"])?,
                            guard,
                            true,
                        )
                        .await?;
                    }
                    let Some(task) = locked_task(tx, &chat).await? else {
                        return Ok(None);
                    };
                    if task["row_version"] != version {
                        return conflict(
                            "stale-version",
                            "The Task changed before its Goal status was synchronized.",
                        );
                    }
                    let current = summary(&task, None)?;
                    let c = &next["classification"];
                    let implementation = |state: &Value| {
                        matches!(
                            state.as_str(),
                            Some("implementing" | "paused" | "blocked" | "complete" | "failed")
                        )
                    };
                    if !implementation(&current["state"])
                        || !implementation(&c["state"])
                        || !c["activeOperationKind"].is_null()
                        || !c["stableStateBeforeFailure"].is_null()
                        || [
                            "planningRound",
                            "planAuthorship",
                            "hasPlan",
                            "hasQuestions",
                            "hasFinalPlan",
                            "hasGoalPrompt",
                        ]
                        .iter()
                        .any(|k| c[*k] != current[*k])
                        || next["protectedContent"]["keyRevision"]
                            != current["protectedContent"]["keyRevision"]
                    {
                        return conflict(
                            "idempotency-conflict",
                            "The encrypted Goal update changes protected planning metadata.",
                        );
                    }
                    let recovering = current["state"] == "failed"
                        && c["state"] == "complete"
                        && truthy(current.get("implementationStartedAt"))
                        && current["hasFinalPlan"] == true
                        && current["hasGoalPrompt"] == true;
                    if current["state"] != c["state"]
                        && !recovering
                        && !policy::can_transition(&text(&current["state"])?, &text(&c["state"])?)
                    {
                        return policy::transition_error(
                            &text(&current["state"])?,
                            &text(&c["state"])?,
                        );
                    }
                    // Source compares the raw JSONB object's serialization,
                    // including stored key order, rather than parsed summaries.
                    if task_content(&task).stringify() == next.stringify() {
                        return Ok(Some(current));
                    }
                    let now = now();
                    let mut fields = task_columns(&next);
                    fields["completed_at"] = if c["state"] == "complete" {
                        if task["completed_at"].is_null() {
                            now.clone()
                        } else {
                            task["completed_at"].clone()
                        }
                    } else {
                        Value::Null
                    };
                    fields["row_version"] = increment(&task["row_version"]);
                    fields["updated_at"] = now;
                    let updated = update(tx, Table::Task, &chat, &fields, None)
                        .await?
                        .context("Task Goal synchronization returned no row")?;
                    summary(&updated, None).map(Some)
                })
            })
            .await
    }
}
