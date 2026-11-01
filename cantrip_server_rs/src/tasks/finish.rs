use super::*;
impl Repository {
    pub async fn complete_operation(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        result: &Value,
        turn: Option<&str>,
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
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let Some(round) = locked_round(tx, &chat, &operation).await? else {
                        return Ok(None);
                    };
                    if !policy::same_operation(&result, &round["relay_request"])
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
                    let Some(task) = locked_task(tx, &chat).await? else {
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
                    if task["active_operation_id"] != operation
                        || task["planning_round"] != round["ordinal"]
                    {
                        return conflict(
                            "idempotency-conflict",
                            "A newer Task operation superseded this result.",
                        );
                    }
                    let now = now();
                    let mut fields =
                        round_columns(&result["classification"], &result["protectedResult"]);
                    fields["relay_result"] = result.clone();
                    fields["failure_task"] = result["goal"]
                        .get("failureTask")
                        .filter(|v| !v.is_null())
                        .unwrap_or(&round["failure_task"])
                        .clone();
                    fields["turn_id"] = json!(turn);
                    fields["completed_at"] = now.clone();
                    let updated_round = update(tx, Table::Round, &operation, &fields, None)
                        .await?
                        .context("Task round completion returned no row")?;
                    let updated_task = if round["kind"] != "finalize" {
                        let mut fields = task_columns(&result["task"]);
                        fields["active_operation_id"] = Value::Null;
                        fields["completed_at"] =
                            if result["task"]["classification"]["state"] == "complete" {
                                now.clone()
                            } else {
                                Value::Null
                            };
                        fields["row_version"] = increment(&task["row_version"]);
                        fields["updated_at"] = now;
                        update(tx, Table::Task, &chat, &fields, None)
                            .await?
                            .context("Task completion returned no row")?
                    } else {
                        task
                    };
                    context(&updated_task, &updated_round).map(Some)
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
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (chat, operation) = (chat.to_owned(), operation.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
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
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (chat, operation, failure) = (
            chat.to_owned(),
            operation.to_owned(),
            goal_launch_failure.cloned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
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
                            || c["lastError"].get("code") != Some(&json!("task-goal-start-failed"))
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
        let rows=self.database.query("SELECT json_build_object('task',to_jsonb(t),'round',to_jsonb(r))::text FROM tasks t JOIN task_planning_rounds r ON r.id=t.active_operation_id",&[]).await?;
        for row in &rows {
            let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
            self.database
                .transaction(|tx| {
                    Box::pin(async move {
                        let task = &row["task"];
                        let round = &row["round"];
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
                        Ok(())
                    })
                })
                .await?;
        }
        Ok(rows.len())
    }
    pub async fn sync_implementation_state(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let next = parse("taskOpaqueContentSchema", &input["task"])?;
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let (chat, version) = (chat.to_owned(), input["rowVersion"].clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
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
