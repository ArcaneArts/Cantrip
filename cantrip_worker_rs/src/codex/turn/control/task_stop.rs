//! Core authorizes the Task cancellation. Only Codex can prove it terminal.
use super::{Selection, pause::BOUNDARY_TIMEOUT};
use crate::{
    codex::{
        preparation::command::{Prepared, task_pause::PauseTarget},
        suspension_store,
        turn::*,
    },
    encryption::ServiceError,
};

impl Turns {
    pub(in crate::codex::turn) async fn stop_task(&self, incoming: &Value) -> Result<Value> {
        let key = self.key(incoming)?;
        if incoming["taskStop"].is_null() {
            return self.interrupt_task(incoming, &key).await;
        }
        // Routing only matters for a cold attachment. A live cancellation
        // uses the current native owner even if its provider is now absent.
        self.serialize_stop(key.clone(), incoming, self.stop_named_task(incoming, &key))
            .await
            .map_err(|_| {
                anyhow!("The Task did not confirm Stop. Retry Stop; Resume remains disabled.")
            })
    }

    async fn stop_named_task(&self, command: &Value, key: &Key) -> Result<Value> {
        let stop = &command["taskStop"];
        let scope = &stop["scope"];
        let active = &stop["active"];
        let thread = id(&active["threadId"], "named Task thread")?;
        let turn = id(&active["turnId"], "named Task turn")?;
        check_stop_source(command, stop, &thread, &turn)?;
        let bound = (key.0.clone(), json!(key.1));
        let intent = json!({"paused":true,"scope":scope});
        self.preparation
            .record_task_pause(&bound, &key.2, &intent)?;
        self.preparation
            .assert_task_intent(&bound, &key.2, &intent)?;
        let live = self.preparation.task_pause_target(&bound, &key.2, scope);
        let (runtime, version) = if let Some(target) = &live {
            target.runtime.admission().set_chat_paused(&key.2, true)?;
            target.runtime.admission().cancel_waiting(&key.2)?;
            target.apply(&intent, false).await?;
            self.preparation
                .assert_task_pause_target(&bound, &key.2, &intent, target)?;
            (target.runtime.clone(), target.thread.version())
        } else {
            let prepared = self.attach_task_stop(stop, key).await?;
            prepared.thread.assert_current(&prepared.runtime)?;
            (prepared.runtime, prepared.thread.version())
        };
        let selected = Selection {
            runtime,
            thread,
            turn,
            thread_version: version,
        };
        let current = || -> Result<()> {
            self.preparation
                .assert_task_intent(&bound, &key.2, &intent)?;
            if let Some(target) = &live {
                self.preparation
                    .assert_task_pause_target(&bound, &key.2, &intent, target)?;
            }
            if !selected.transport_current() {
                bail!("The Task Stop lost its current native transport.");
            }
            Ok(())
        };
        current()?;
        let terminal = if let Some(terminal) = selected.terminal().await? {
            terminal
        } else {
            current()?;
            let discarded = selected
                .runtime
                .request(
                    "turn/suspension".into(),
                    Some(json!({
                        "threadId":selected.thread,
                        "operation":json!({"type":"discard","turnId":selected.turn}),
                    })),
                    Some(BOUNDARY_TIMEOUT),
                    None,
                )
                .await;
            match discarded {
                Ok(_) => selected.await_terminal().await?,
                Err(error) => selected.terminal().await?.ok_or(error)?,
            }
        };
        current()?;
        checked(
            "taskTurnStopResultSchema",
            &json!({
                "controlId":stop["controlId"],"interrupted":true,
                "active":active, "outcome":if terminal.status == "interrupted" { "stopped" } else { terminal.status },
                "actor":json!({
                    "workerGeneration":self.task_inputs.generation(),"runtimeGeneration":selected.runtime.generation(),
                    "operationId":stop["controlId"],"operationGeneration":stop["controlId"],
                }),
            }),
        )
    }

    async fn attach_task_stop(&self, stop: &Value, key: &Key) -> Result<Prepared> {
        let stop = self.preparation.resolve_routing(stop).await?;
        let scope = &stop["scope"];
        let evidence = &stop["checkpoint"];
        let locator = evidence["storageId"]
            .as_str()
            .context("A detached Task Stop requires its checkpoint.")?;
        if stop["model"]["routeId"] != scope["modelRouteId"]
            || stop["provider"]["accountId"] != scope["providerAccountId"]
        {
            bail!("The detached Task no longer has its saved provider.");
        }
        let saved = match self.suspensions.open_task_for_stop(&key.2, locator).await {
            Ok(saved) => {
                validate_saved_task(&self.preparation, &stop, &saved).await?;
                Some(saved)
            }
            // Try the actual canonical provider home when an older profile
            // lacks a local Task record or its Task-content grant. Codex
            // still has to attach with the exact checkpoint and prove Stop.
            Err(error) if suspension_store::missing(&error) || error.is::<ServiceError>() => None,
            Err(error) => return Err(error),
        };
        let structured = saved
            .as_ref()
            .is_some_and(|saved| saved.continuation["structuredChat"] == true);
        self.preparation.prepare_task_stop(&json!({
            "cwd":stop["cwd"], "threadId":scope["threadId"], "model":stop["model"], "provider":stop["provider"],
            "permissionProfileId":stop["permissionProfileId"], "mcpServers":Vec::<Value>::new(),
            "taskOwned":true,"taskCycleId":scope["cycleId"],"structuredTask":structured,
            "session":json!({
                "chatId":stop["source"]["chatId"],"contextKind":"project","projectId":scope["projectId"],
                "worktreeId":scope["worktreeId"],"rootKind":"folder-root",
                "scratchRootId":Value::Null,"computerUseEnabled":false,
            }),
        }), saved, &evidence["suspension"]).await
    }

    async fn interrupt_task(&self, command: &Value, key: &Key) -> Result<Value> {
        let scope = &command["task"];
        let bound = (key.0.clone(), json!(key.1));
        let intent = json!({"paused":true,"scope":scope});
        let latch = self
            .preparation
            .record_task_pause(&bound, &key.2, &intent)?;
        let mut interrupted = false;
        if latch.current().intent.as_ref() != Some(&intent) {
            return interrupt_proof(false);
        }
        let target = self
            .preparation
            .task_interrupt_target(&bound, &key.2, scope);
        let Some(target) = target else {
            let active = self
                .active
                .lock()
                .unwrap()
                .active
                .get(key)
                .filter(|owner| owner.task_input.is_some())
                .cloned();
            if let Some(active) = active {
                interrupted = active
                    .interrupt(scope["threadId"].as_js_string(), || {
                        self.preparation.assert_task_intent(&bound, &key.2, &intent)
                    })
                    .await?;
            }
            return interrupt_proof(interrupted);
        };
        let current = || self.assert_interrupt_target(key, &bound, &intent, &target);
        current()?;
        let adapter = target.runtime.admission();
        adapter.set_chat_paused(&key.2, true)?;
        interrupted |= adapter.cancel_waiting(&key.2)?;
        target.apply(&intent, false).await?;
        current()?;
        if let Some(turn) = target.active_turn().await? {
            current()?;
            let reply = target
                .runtime
                .request(
                    "thread/managedExecution/taskInterrupt".into(),
                    Some(json!({
                        "threadId":target.thread.id(),"runnerGeneration":target.runner(),
                        "revision":scope["revision"],"turnId":turn,
                    })),
                    Some(BOUNDARY_TIMEOUT),
                    None,
                )
                .await?
                .context("Codex did not acknowledge the Task interrupt.")?;
            interrupted |= reply["interrupted"]
                .as_bool()
                .context("Invalid native Task interrupt acknowledgement.")?;
        }
        interrupt_proof(interrupted)
    }

    fn assert_interrupt_target(
        &self,
        key: &Key,
        bound: &(JsString, Value),
        intent: &Value,
        target: &PauseTarget,
    ) -> Result<()> {
        self.preparation.assert_task_intent(bound, &key.2, intent)?;
        if !self
            .preparation
            .task_interrupt_target(bound, &key.2, &intent["scope"])
            .is_some_and(|current| current.same(target))
        {
            bail!("The private Task root changed during interruption.");
        }
        Ok(())
    }
}

async fn validate_saved_task(
    preparation: &Ensurer,
    stop: &Value,
    saved: &suspension_store::Opened,
) -> Result<()> {
    let scope = &stop["scope"];
    let source = &saved.source;
    let goal = &source["taskGoalCycle"];
    let canonical = if scope["taskGoalCycle"].is_null() {
        goal.is_null() && source["taskInput"] == stop["source"]
    } else {
        goal["parent"] == stop["source"]
            && goal["threadId"] == stop["active"]["threadId"]
            && goal["turnId"] == stop["active"]["turnId"]
            && goal_selector(goal) == scope["taskGoalCycle"]
    };
    let original = &saved.continuation;
    let cwd = preparation
        .resolve_routing(&json!({"cwd":original["cwd"]}))
        .await?;
    if !canonical
        || saved.evidence != stop["checkpoint"]
        || source["contextKind"] != "project"
        || source["projectId"] != scope["projectId"]
        || source["placementId"] != scope["worktreeId"]
        || source["threadId"] != scope["threadId"]
        || source["modelRouteId"] != scope["modelRouteId"]
        || source["providerAccountId"] != scope["providerAccountId"]
        || original["providerId"] != stop["provider"]["id"]
        || original["providerKind"] != stop["provider"]["kind"]
        || cwd["cwd"] != stop["cwd"]
    {
        bail!("The saved Task checkpoint belongs to another execution.");
    }
    Ok(())
}

fn interrupt_proof(interrupted: bool) -> Result<Value> {
    checked(
        "chatInterruptAcceptedSchema",
        &json!({"interrupted":interrupted}),
    )
}

fn goal_selector(goal: &Value) -> Value {
    json!({
        "cycleId":goal["cycle"]["cycleId"],"sourceKey":goal["sourceKey"],"operationId":goal["operationId"],
        "goalEpoch":goal["cycle"]["goalEpoch"],"scopeId":goal["cycle"]["scopeId"],
    })
}

fn check_stop_source(
    command: &Value,
    stop: &Value,
    thread: &JsString,
    turn: &JsString,
) -> Result<()> {
    let source = &stop["source"];
    let scope = &stop["scope"];
    let round = &scope["taskRound"];
    let goal = &scope["taskGoalCycle"];
    let dispatch = &source["dispatch"];
    let descriptor = &stop["checkpoint"]["suspension"];
    if round.is_null() == goal.is_null()
        || command["chatId"] != source["chatId"]
        || command["threadId"].as_js_string() != Some(thread)
        || scope["threadId"].as_js_string() != Some(thread)
        || scope["workerId"] != source["workerId"]
        || scope["worktreeId"] != source["worktreeId"]
        || scope["cycleId"] != dispatch["cycleId"]
        || (!round.is_null()
            && (round["inputOperationId"] != source["operationId"]
                || round["operationId"] != dispatch["operationId"]
                || round["cycleId"] != dispatch["cycleId"]))
        || (!goal.is_null()
            && (source["kind"] != "goal"
                || goal["cycleId"] != dispatch["cycleId"]
                || !goal["operationId"].as_str().is_some_and(|operation| {
                    operation.starts_with(&format!(
                        "native-inference:{thread}:{turn}:{}:",
                        goal["scopeId"].as_str().unwrap_or_default()
                    ))
                })))
        || (!stop["checkpoint"].is_null()
            && (descriptor["threadId"].as_js_string() != Some(thread)
                || descriptor["turnId"].as_js_string() != Some(turn)))
    {
        bail!("The Task Stop control does not match its canonical native source.");
    }
    Ok(())
}
