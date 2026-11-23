//! Private Core Goal cycles are not explicit Task inputs or managed commands.
use super::*;
use sha2::{Digest, Sha256};

/// Resolve the current logical binding without changing the immutable keeper
/// Source or inventing a new physical inference scope.
pub(crate) fn current_binding(marker: &Value) -> Value {
    let cycle = &marker["cycle"];
    let binding = marker.get("binding").filter(|value| !value.is_null());
    json!({"cycleId":cycle["cycleId"],"goalEpoch":cycle["goalEpoch"],
        "modelRouteId":binding.map_or_else(||cycle["modelRouteId"].clone(),|b|b["modelRouteId"].clone()),
        "providerAccountId":binding.map_or_else(||cycle["providerAccountId"].clone(),|b|b["providerAccountId"].clone()),
        "orderEpoch":binding.map_or_else(||cycle["orderEpoch"].clone(),|b|b["orderEpoch"].clone())})
}

async fn locked(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    if !lock_user(tx, owner).await? {
        return Ok(None);
    }
    let chats = tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 AND chats.owner_id=$1 FOR UPDATE OF chats",
        &[&owner,&chat]).await?;
    if chats.is_empty() {
        return Ok(None);
    }
    tx.query(
        "SELECT chat_id FROM tasks WHERE chat_id=$1 FOR UPDATE",
        &[&chat],
    )
    .await?;
    let cycle = one(Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1 FOR UPDATE",
        &[&owner,&chat]).await?;
    let Some(cycle) = cycle else {
        return Ok(None);
    };
    let id = text(&cycle["id"])?;
    let row = one(Executor::Transaction(tx),
        "SELECT jsonb_build_object('task',to_jsonb(t),'cycle',to_jsonb(c),'chat',to_jsonb(ch),'project',to_jsonb(p),'route',to_jsonb(r))::text FROM chats ch JOIN projects p ON p.id=ch.project_id AND p.owner_id=$1 JOIN tasks t ON t.chat_id=ch.id JOIN task_dispatch_cycles c ON c.id=$3 AND c.chat_id=ch.id AND c.owner_id=$1 LEFT JOIN model_routes r ON r.id=c.model_route_id WHERE ch.id=$2 AND ch.owner_id=$1 LIMIT 1 FOR UPDATE OF ch,p,t,c",
        &[&owner,&chat,&id]).await?;
    let Some(mut row) = row else {
        return Ok(None);
    };
    row["context"] =
        crate::chats::Repository::execution_context_with(Executor::Transaction(tx), owner, chat)
            .await?
            .unwrap_or(Value::Null);
    if row["context"].is_null() {
        return Ok(None);
    }
    row["handoff"] = Value::Bool(
        !tx.query(
            "SELECT operation_id FROM native_runtime_handoffs WHERE owner_id=$1 AND chat_id=$2 AND phase IN ('preparing','prepared','committed') LIMIT 1",
            &[&owner, &chat],
        )
        .await?
        .is_empty(),
    );
    Ok(Some(row))
}
fn same_binding(
    row: &Value,
    worker: &Value,
    provider: &Value,
    thread: &Value,
    cycle: &Value,
) -> bool {
    let (t, c, ch, context) = (&row["task"], &row["cycle"], &row["chat"], &row["context"]);
    context["experience"] == "task"
        && context["contextKind"] == "project"
        && c.get("id") == cycle.get("cycleId")
        && c["operation_kind"] == "finalize"
        && !c["started_at"].is_null()
        && t["plan_goal_enabled"] == true
        && !t["implementation_started_at"].is_null()
        && t["has_final_plan"] == true
        && t["has_goal_prompt"] == true
        && t["active_operation_id"].is_null()
        && c.get("physical_worker_id") == Some(worker)
        && c.get("codex_thread_id") == Some(thread)
        && c.get("model_route_id") == cycle.get("modelRouteId")
        && c.get("provider_account_id") == cycle.get("providerAccountId")
        && c.get("goal_order_epoch") == cycle.get("orderEpoch")
        && row["route"].get("provider_id") == Some(provider)
        && context.get("workerId") == Some(worker)
        && context.get("threadId") == Some(thread)
        && context.get("worktreeId") == c.get("worktree_id")
        && context.get("modelRouteId") == cycle.get("modelRouteId")
        && context.get("providerAccountId") == cycle.get("providerAccountId")
        && ch["archived_at"].is_null()
}
fn eligible(row: &Value) -> bool {
    let (t, c, ch) = (&row["task"], &row["cycle"], &row["chat"]);
    let input = &c["goal_input"];
    row["handoff"] != true
        && !matches!(t["state"].as_str(), Some("complete" | "failed" | "paused"))
        && ch["automation_paused"] != true
        && ch["managed_autonomy_stopped"] != true
        && row["project"]["task_scheduling_paused"] != true
        && !matches!(c["state"].as_str(), Some("paused" | "cancelled"))
        && !(truthy(Some(input))
            && input["deferred"] != true
            && (input["failedBeforeDispatch"] != true
                && input["firstDispatchedOperationId"].is_null()))
}
async fn write(tx: &Transaction<'_>, cycle: &Value, marker: &Value, notify: bool) -> Result<()> {
    let (id, data) = (text(&cycle["id"])?, marker.stringify());
    tx.query(
        "UPDATE task_dispatch_cycles SET goal_cycle_recovery=$2::text::jsonb WHERE id=$1",
        &[&id, &data],
    )
    .await?;
    if !notify {
        return Ok(());
    }
    let chat = text(&cycle["chat_id"])?;
    tx.query("INSERT INTO managed_queue_states(chat_id,revision) VALUES($1,1) ON CONFLICT(chat_id) DO UPDATE SET revision=managed_queue_states.revision+1,notification_due_at=now()",
        &[&chat]).await?;
    Ok(())
}
fn operation(thread: &Value, turn: &Value, cycle: &Value) -> Result<String> {
    Ok(format!(
        "native-inference:{}:{}:{}:{}",
        text(thread)?,
        text(turn)?,
        text(&cycle["scopeId"])?,
        text(&cycle["gateAttemptId"])?
    ))
}
fn stale<T>() -> Result<T> {
    Err(
        crate::task_dispatch::Conflict::new("stale-lease", "The native Task Goal binding changed.")
            .into(),
    )
}
pub(crate) fn committed_source(marker: &Value) -> Option<&Value> {
    let state = &marker["suspension"];
    let terminal = &state["terminal"];
    state.get("source").filter(|source| {
        !source.is_null()
            && state["restoration"].is_null()
            && !terminal.is_null()
            && terminal["projectedAt"].is_null()
    })
}

impl Repository {
    pub(crate) async fn project_goal_cycle_outcome(
        &self,
        owner: &str,
        source: &Value,
        observation: &Value,
        observed: &Value,
    ) -> Result<Option<Value>> {
        let (owner, source, observation, observed) = (
            owner.to_owned(),
            source.clone(),
            observation.clone(),
            observed.clone(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let chat = text(&source["parent"]["chatId"])?;
            let Some(row) = locked(tx, &owner, &chat).await? else { return Ok(None); };
            let cycle = &row["cycle"];
            let mut marker = cycle["goal_cycle_recovery"].clone();
            // The original input keeps its provider after a handoff. The
            // durable native marker owns the continuation's actual provider.
            if committed_source(&marker) != Some(&source)
                || cycle["goal_input"]["receipt"] != source["parent"]
                || !same_binding(&row,&source["parent"]["workerId"],&marker["providerId"],&source["threadId"],&source["cycle"]) {
                return Ok(None);
            }
            anyhow::ensure!(row["handoff"] != true, "The committed Task Goal observation is waiting for its runtime handoff.");
            goal_observations::assert_in(tx, &owner, &chat, &observation).await?;
            let execution = &observed["execution"];
            let status = execution["status"].as_str()
                .filter(|status| matches!(*status, "idle" | "failed") && execution["threadId"] == source["threadId"] && !observed["goal"].is_null())
                .context("The committed Task Goal cycle is awaiting a terminal execution observation.")?;
            let lane = &observation["snapshot"]["lane"];
            if !lane.is_null()
                && (lane["id"] != source["parent"]["executionLaneId"]
                    || lane["workerId"] != source["parent"]["workerId"]
                    || lane["worktreeId"] != source["parent"]["worktreeId"]
                    || lane["threadId"] != source["threadId"]
                    || (lane["activatedAt"].as_js_string().and_then(crate::wire::date_milliseconds)
                        != source["parent"]["executionLaneActivatedAt"].as_js_string().and_then(crate::wire::date_milliseconds)
                        && lane["purpose"] != crate::chats::task_recovery::RECOVERED_GOAL_LANE))
            {
                return Ok(None);
            }
            let next = parse("taskOpaqueContentSchema", &observed["task"])?;
            let version = &observation["snapshot"]["taskRowVersion"];
            let Some(task) = super::finish::sync_implementation_state_in(tx,&chat,version,&next).await? else {
                return Ok(None);
            };
            if !lane.is_null() {
                let closed = crate::chats::execution_lanes::finish_in_transaction(
                    tx,&chat,&text(&lane["id"])?,status,
                    &json!({"expectedActivatedAt":lane["activatedAt"]}),
                ).await?;
                if !closed { return stale(); }
            } else {
                // The explicit input or a disconnect can already have released
                // the parent lane. Settle the chat from the same terminal
                // observation without acquiring or changing that lane.
                let parent = &source["parent"];
                tx.query("UPDATE chats c SET status=$3,updated_at=$4,has_unread_completion=true FROM chat_execution_lanes l WHERE c.id=$1 AND c.owner_id=$2 AND l.id=$5 AND l.chat_id=c.id AND l.state='suspended' AND l.worker_id=$6 AND l.worktree_id=$7 AND l.activated_at=$8::text::timestamptz AND (l.codex_thread_id IS NULL OR l.codex_thread_id=$9)",
                    &[&chat,&owner,&status,&crate::auth::now(),&text(&parent["executionLaneId"])?,&text(&parent["workerId"])?,&text(&parent["worktreeId"])?,&text(&parent["executionLaneActivatedAt"])?,&text(&source["threadId"])?]).await?;
            }
            marker["suspension"]["terminal"]["projectedAt"] = now();
            write(tx,cycle,&marker,false).await?;
            if matches!(task["state"].as_str(),Some("complete" | "blocked" | "failed"))
                && !matches!(cycle["state"].as_str(),Some("succeeded" | "failed" | "cancelled" | "paused"))
            {
                let now = crate::auth::now();
                tx.query("UPDATE task_dispatch_cycles SET state=$2,completed_at=$3,eligibility_code=NULL,updated_at=$3 WHERE id=$1",
                    &[&text(&cycle["id"])?,&if task["state"]=="failed"{"failed"}else{"succeeded"},&now]).await?;
            }
            Ok(Some(task))
        })).await
    }

    /// Recover terminal markers committed by builds before the outbox carried
    /// this observation, and wake pending ones when a worker reconnects.
    pub(crate) async fn wake_committed_goal_cycles(&self, owner: &str) -> Result<()> {
        self.database.query(
            "WITH latest AS (SELECT DISTINCT ON (d.chat_id) d.chat_id,d.goal_cycle_recovery,d.goal_order_epoch,d.physical_worker_id,d.worktree_id FROM task_dispatch_cycles d WHERE d.owner_id=$1 ORDER BY d.chat_id,d.created_at DESC,d.id DESC)
             INSERT INTO managed_queue_states(chat_id,revision)
             SELECT c.id,1 FROM latest d JOIN chats c ON c.id=d.chat_id AND c.owner_id=$1
             WHERE c.archived_at IS NULL AND c.active_worker_id=d.physical_worker_id AND c.active_worktree_id=d.worktree_id
               AND d.goal_cycle_recovery #>> '{suspension,source,cycle,orderEpoch}' = d.goal_order_epoch::text
               AND d.goal_cycle_recovery #>> '{suspension,terminal,observedAt}' IS NOT NULL
               AND d.goal_cycle_recovery #>> '{suspension,terminal,projectedAt}' IS NULL
               AND d.goal_cycle_recovery #>> '{suspension,restoration,receipt,operationId}' IS NULL
             ON CONFLICT(chat_id) DO UPDATE SET revision=managed_queue_states.revision+1,notification_due_at=now()
             WHERE managed_queue_states.notified_revision>=managed_queue_states.revision",
            &[&owner],
        ).await?;
        Ok(())
    }

    pub async fn commit_goal_cycle_outcome(
        &self,
        owner: &str,
        worker: &str,
        input: &Value,
    ) -> Result<Value> {
        let (owner, worker, input) = (owner.to_owned(), worker.to_owned(), input.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let source = parse("taskGoalCycleSuspensionSourceSchema", &input["goalCycleSource"])?;
            let note = &input["notification"];
            let chat = text(&source["parent"]["chatId"])?;
            lock_user(tx, &owner).await?;
            crate::native_commands::context::lock_chat(tx, &owner, &chat).await?;
            let cycle = one(Executor::Transaction(tx), "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 AND c.owner_id=$2 AND c.chat_id=$3 FOR UPDATE", &[&text(&source["cycle"]["cycleId"])?,&owner,&chat]).await?;
            let Some(cycle) = cycle else { return Ok(json!({"committed":false,"retiredReason":"goal-cycle-replaced"})); };
            let mut marker = cycle["goal_cycle_recovery"].clone();
            if marker["suspension"]["source"] != source || cycle["goal_input"]["receipt"] != source["parent"] {
                return Ok(json!({"committed":false,"retiredReason":"goal-cycle-replaced"}));
            }
            if !marker["suspension"]["restoration"].is_null() { return Ok(json!({"committed":false,"retiredReason":"goal-cycle-restored"})); }
            if input["inputKind"] != "goal-cycle" || source["parent"]["workerId"] != worker.as_str() ||
                ["chatId","clientMessageId","executionLaneId","worktreeId"].iter().any(|key| note[*key] != source["parent"][*key]) ||
                !note["taskInferenceInputOperationId"].is_null() || (note["outcome"]["ok"] == true &&
                (note["outcome"]["result"]["threadId"] != source["threadId"] || note["outcome"]["result"]["turnId"] != source["turnId"])) { return stale(); }
            let message = if note["outcome"]["ok"] == true {
                let result = parse("taskMessageRelayResultSchema", &note["outcome"]["result"]["structuredResult"])?;
                let message = result["message"].clone();
                let Some(kind)=super::response_publication::kind(&message,&source["publication"],&note["outcome"]["result"],&source) else { return stale(); };
                Some((message,kind))
            } else { None };
            let digest = format!("{:x}", Sha256::digest(note.stringify().as_bytes()));
            if !marker["suspension"]["terminal"]["outcomeDigest"].is_null() && marker["suspension"]["terminal"]["outcomeDigest"] != digest.as_str() { return stale(); }
            let row = crate::native_commands::suspension::chat(tx, &owner, &chat).await?;
            if row["experience"] != "task" { return stale(); }
            let saved = if let Some((message,kind)) = message {
                crate::chats::message_writes::append_task_outcome_with(Executor::Transaction(tx), &owner, &chat, &message,
                    &json!({"executionLaneId":source["parent"]["executionLaneId"],"worktreeId":source["parent"]["worktreeId"]}),
                    kind==super::response_publication::Kind::NativeRoot).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?
            } else { Value::Null };
            let ok = note["outcome"]["ok"] == true;
            if marker["suspension"]["terminal"].is_null() {
                marker["suspension"]["terminal"] = json!({"ok":ok,"failureKind":if ok {Value::Null} else {json!("runtime")},"observedAt":now(),"projectedAt":Value::Null,
                    "outcomeDigest":digest,"threadId":source["threadId"],"turnId":source["turnId"]});
                write(tx,&cycle,&marker,true).await?;
            }
            crate::native_commands::task_suspension::retire_goal_cycle_locked(tx,&owner,&source,if ok {"completed"} else {"failed"}).await?;
            Ok(json!({"committed":true,"message":saved,"chat":super::rows::goal_chat(&row)?}))
        })).await
    }

    pub async fn pending_goal_cycle_recovery(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let Some(row) = locked(tx, &owner, &chat).await? else {
                        return Ok(None);
                    };
                    let marker = &row["cycle"]["goal_cycle_recovery"];
                    if marker.is_null()
                        || truthy(marker.get("settled"))
                        || !eligible(&row)
                        || !same_binding(
                            &row,
                            &row["context"]["workerId"],
                            &marker["providerId"],
                            &marker["threadId"],
                            &current_binding(marker),
                        )
                    {
                        return Ok(None);
                    }
                    Ok(Some(parse("taskGoalCycleRecoverySchema", marker)?))
                })
            })
            .await
    }

    pub async fn reconcile_goal_cycle(&self, owner: &str, input: &Value) -> Result<Value> {
        let (record, identity) = (&input["record"], &input["record"]["identity"]["recovery"]);
        let cycle = &identity["taskGoalCycle"];
        let base = json!({"key":record["key"],"chatId":record["identity"]["chatId"],"disposition":"unresolved"});
        if cycle.is_null()
            || !["threadId", "turnId"]
                .iter()
                .all(|k| truthy(identity.get(k)))
            || !truthy(record["identity"].get("chatId"))
            || [
                "messageId",
                "commandId",
                "commandGeneration",
                "taskInput",
                "autonomousGoal",
            ]
            .iter()
            .any(|k| truthy(identity.get(k)))
        {
            return Ok(base);
        }
        let parts = [
            text(&record["workerGeneration"])?,
            text(&record["identity"]["runtimeGeneration"])?,
            text(&record["identity"]["operationId"])?,
        ];
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&parts)?));
        let never_started = record["state"] == "released" && record["outcome"] == "never-started";
        let local_settled = record["state"] == "released"
            && matches!(
                record["outcome"].as_str(),
                Some("never-started" | "runtime-exited")
            );
        if record["key"].as_str() != Some(key.as_str())
            || record["identity"]["operationId"].as_str()
                != Some(operation(&identity["threadId"], &identity["turnId"], cycle)?.as_str())
            || (truthy(record.get("nativeExecution")) && !never_started)
            || (record.get("workerGeneration") == input.get("workerGeneration") && !local_settled)
        {
            return Ok(base);
        }
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let (record, identity) = (&input["record"], &input["record"]["identity"]["recovery"]);
            let cycle = &identity["taskGoalCycle"];
            let chat = text(&record["identity"]["chatId"])?;
            let mut result = base;
            let Some(row) = locked(tx,&owner,&chat).await? else {
                result["disposition"] = json!("retired"); return Ok(result);
            };
            let retained = &row["cycle"]["goal_cycle_recovery"];
            let same_episode = !retained.is_null() &&
                retained.get("providerId") == record["identity"].get("providerId") &&
                retained.get("threadId") == identity.get("threadId") &&
                retained["cycle"].get("cycleId") == cycle.get("cycleId") &&
                retained["cycle"].get("goalEpoch") == cycle.get("goalEpoch") &&
                retained["cycle"].get("orderEpoch") == cycle.get("orderEpoch");
            let binding = if same_episode {current_binding(retained)} else {cycle.clone()};
            if !same_binding(&row,&input["workerId"],&record["identity"]["providerId"],&identity["threadId"],&binding) ||
                (truthy(record["identity"].get("projectId")) &&
                    record["identity"].get("projectId") != row["context"].get("projectId")) ||
                row["task"]["state"] == "complete" || !row["chat"]["archived_at"].is_null() {
                result["disposition"] = json!("retired"); return Ok(result);
            }
            if !eligible(&row) { return Ok(result); }
            let mut marker = row["cycle"]["goal_cycle_recovery"].clone();
            if truthy(marker.get("admission")) &&
                marker["admission"].get("operationId") == record["identity"].get("operationId") &&
                marker["admission"].get("runtimeGeneration") == record["identity"].get("runtimeGeneration") &&
                marker["admission"].get("workerGeneration") == record.get("workerGeneration") {
                marker["admission"] = Value::Null;
                write(tx,&row["cycle"],&marker,true).await?;
            }
            if truthy(marker.get("settled")) {
                let same_episode = marker["cycle"].get("goalEpoch") == cycle.get("goalEpoch") &&
                    marker["cycle"].get("orderEpoch") == cycle.get("orderEpoch");
                let same_attempt = marker.get("sourceKey") == record.get("key") ||
                    marker.get("turnId") == identity.get("turnId") ||
                    marker["settled"].get("turnId") == identity.get("turnId");
                let rejected = record["state"] == "released" && record["outcome"] == "never-started" &&
                    marker["settled"].get("operationId") == record["identity"].get("operationId");
                if same_episode && same_attempt && !rejected {
                    result["disposition"] = json!("retired"); return Ok(result);
                }
                marker = Value::Null;
            }
            if !marker.is_null() &&
                (marker["cycle"].get("cycleId") != cycle.get("cycleId") ||
                    marker.get("threadId") != identity.get("threadId") ||
                    marker["cycle"].get("goalEpoch") != cycle.get("goalEpoch") ||
                    marker["cycle"].get("orderEpoch") != cycle.get("orderEpoch") ||
                    marker.get("providerId") != record["identity"].get("providerId")) { return Ok(result); }
            if marker.is_null() {
                marker = parse("taskGoalCycleRecoverySchema",&json!({
                    "sourceKey":record["key"],"operationId":record["identity"]["operationId"],
                    "runtimeGeneration":record["identity"]["runtimeGeneration"],
                    "workerGeneration":record["workerGeneration"],"providerId":record["identity"]["providerId"],
                    "workerId":input["workerId"],
                    "threadId":identity["threadId"],"turnId":identity["turnId"],"cycle":cycle}))?;
                write(tx,&row["cycle"],&marker,true).await?;
            }
            result["disposition"] = json!("requeued");
            result["taskGoalCycleNotDispatched"] = json!(true);
            result["taskGoalRecovery"] = marker;
            Ok(result)
        })).await
    }

    pub async fn dispatch_goal_cycle(
        &self,
        owner: &str,
        input: &Value,
        include_prompt: bool,
    ) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let chat = text(&input["chatId"])?;
            let Some(row) = locked(tx,&owner,&chat).await? else { return stale(); };
            if !same_binding(&row,&input["workerId"],&input["providerId"],&input["threadId"],&input["cycle"]) ||
                !eligible(&row) || input["operationId"].as_str() !=
                    Some(operation(&input["threadId"],&input["turnId"],&input["cycle"])?.as_str()) { return stale(); }
            let mut marker = row["cycle"]["goal_cycle_recovery"].clone();
            if let Some(runtime) = input.get("freshRuntimeGeneration").filter(|value| !value.is_null()) {
                let key = format!("{:x}", Sha256::digest(
                    json!([input["workerGeneration"].clone(), runtime.clone(), input["operationId"].clone()]).stringify().as_bytes(),
                ));
                if input["sourceKey"] != key.as_str() || (!marker.is_null() && marker.get("sourceKey") != input.get("sourceKey") && !truthy(marker.get("settled"))) {return stale();}
                if marker.get("sourceKey") != input.get("sourceKey") {
                marker = parse("taskGoalCycleRecoverySchema", &json!({
                    "sourceKey":input["sourceKey"],"workerGeneration":input["workerGeneration"],
                    "runtimeGeneration":runtime,"operationId":input["operationId"],
                    "workerId":input["workerId"],"providerId":input["providerId"],
                    "threadId":input["threadId"],"turnId":input["turnId"],"cycle":input["cycle"]
                }))?;
                }
            }
            if marker.is_null() || marker.get("sourceKey") != input.get("sourceKey") ||
                marker["cycle"].get("goalEpoch") != input["cycle"].get("goalEpoch") ||
                marker.get("providerId") != input.get("providerId") ||
                current_binding(&marker).get("orderEpoch") != input["cycle"].get("orderEpoch") ||
                (truthy(marker.get("settled")) && marker["settled"]["reason"] != "dispatched") ||
                (truthy(marker.get("settled")) &&
                    (marker["settled"].get("operationId") != input.get("operationId") ||
                        marker["settled"].get("turnId") != input.get("turnId"))) { return stale(); }
            let mut suspension_source = marker["suspension"]["source"].clone();
            if let Some(runtime) = input.get("nativeRuntimeGeneration").filter(|value| !value.is_null())
                && !row["cycle"]["goal_input"].is_null() {
                    if input.get("freshRuntimeGeneration").is_some_and(|fresh| !fresh.is_null() && fresh != runtime) { return stale(); }
                    let publication = if suspension_source.is_null() {
                        json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:goal-cycle:{}", text(&marker["sourceKey"])?)})
                    } else { suspension_source["publication"].clone() };
                    let actual = parse("taskGoalCycleSuspensionSourceSchema", &json!({
                        "kind":"goal-cycle","sourceKey":marker["sourceKey"],"operationId":input["operationId"],
                        "workerGeneration":input["workerGeneration"],"runtimeGeneration":runtime,
                        "threadId":input["threadId"],"turnId":input["turnId"],"cycle":input["cycle"],
                        "parent":row["cycle"]["goal_input"]["receipt"],"publication":publication
                    }))?;
                    if !suspension_source.is_null() && suspension_source != actual { return stale(); }
                    suspension_source = actual;
            }
            if !truthy(marker.get("settled")) || (!suspension_source.is_null() && marker["suspension"].is_null()) {
                if !suspension_source.is_null() { marker["suspension"] = json!({"source":suspension_source}); }
                marker["settled"] = json!({"reason":"dispatched","operationId":input["operationId"],"turnId":input["turnId"]});
                write(tx,&row["cycle"],&marker,true).await?;
            }
            let mut result = json!({"accepted":true});
            if !suspension_source.is_null() {
                if include_prompt {
                    let parent = &suspension_source["parent"];
                    let message = one(Executor::Transaction(tx),
                        "SELECT to_jsonb(m)::text FROM chat_messages m WHERE m.chat_id=$1 AND m.id=$2 AND m.worktree_id=$3 AND m.role IN ('user','system') AND m.mode='goal' AND m.task_protected_content IS NOT NULL",
                        &[&chat, &text(&parent["clientMessageId"])?, &text(&parent["worktreeId"])?]).await?;
                    let Some(message) = message.filter(|message| !truthy(message.get("content"))) else { return stale(); };
                    result["publicationPrompt"] = goal_inference_inputs::opaque_prompt(&message)?;
                }
                result["suspensionSource"] = suspension_source;
            }
            Ok(result)
        })).await
    }

    pub async fn confirm_goal_cycle_recovery(
        &self,
        owner: &str,
        chat: &str,
        source: &Value,
        receipt: &Value,
    ) -> Result<Option<Value>> {
        let (owner, chat, source, receipt) = (
            owner.to_owned(),
            chat.to_owned(),
            source.clone(),
            receipt.clone(),
        );
        self.database.transaction(|tx|Box::pin(async move {
            let Some(row) = locked(tx,&owner,&chat).await? else { return Ok(None); };
            let mut marker = row["cycle"]["goal_cycle_recovery"].clone();
            if marker.is_null() || truthy(marker.get("settled")) ||
                marker.get("sourceKey") != source.get("sourceKey") ||
                receipt.get("sourceKey") != marker.get("sourceKey") ||
                !same_binding(&row,&row["context"]["workerId"],&marker["providerId"],&marker["threadId"],&current_binding(&marker)) ||
                !eligible(&row) { return Ok(None); }
            if receipt["status"] == "scheduled" {
                let admission = json!({"operationId":receipt["admission"]["operationId"],
                    "runtimeGeneration":receipt["admission"]["runtimeGeneration"],
                    "workerGeneration":receipt["workerGeneration"]});
                if ["operationId","runtimeGeneration","workerGeneration"].iter().any(|key|
                    marker["admission"].get(key) != admission.get(key)) {
                    marker["admission"] = admission;
                    write(tx,&row["cycle"],&marker,true).await?;
                }
                return Ok(None);
            }
            if receipt.get("threadId") != marker.get("threadId") ||
                receipt.get("modelRouteId") != current_binding(&marker).get("modelRouteId") ||
                receipt.get("providerAccountId") != current_binding(&marker).get("providerAccountId") ||
                (receipt.get("observedGoalEpoch") == marker["cycle"].get("goalEpoch") &&
                    receipt["observedGoalStatus"] == "active") { return Ok(None); }
            marker["settled"] = json!({"reason":"ineligible","operationId":Value::Null,"turnId":marker["turnId"]});
            write(tx,&row["cycle"],&marker,true).await?;
            Ok(Some(marker))
        })).await
    }
}
