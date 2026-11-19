//! The private Task gate and the canonical Task input own boundary control.
use super::{Selection, pause::BOUNDARY_TIMEOUT};
use crate::codex::{
    preparation::command::task_pause::PauseTarget, suspension_store::Commit, turn::*,
};
use task::{checkpoint::Checkpoint, cycle::GoalCycle};

pub(crate) const COMMAND: &str = "chat.pause.set";

enum Observer {
    Round(Arc<Active>),
    Goal(Arc<GoalCycle>, Arc<Checkpoint>),
}

impl Observer {
    fn checkpoint(&self) -> &Checkpoint {
        match self {
            Self::Round(active) => active.task.get().expect("matched explicit Task observer"),
            Self::Goal(_, checkpoint) => checkpoint,
        }
    }

    fn with_current<T>(
        &self,
        selected: &Selection,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if !selected.transport_current() {
            bail!("The Task transport changed during boundary control.");
        }
        match self {
            Self::Round(active) => {
                let phase = active.phase.lock().unwrap();
                if !selected.current(&phase) {
                    bail!("The Task input ended or was replaced during boundary control.");
                }
                operation()
            }
            Self::Goal(owner, capture) => owner.checkpoints.with_current(capture, operation),
        }
    }
}

impl Turns {
    pub(crate) async fn task_pause(&self, command: &Value) -> Result<Value> {
        if command["task"].is_null() {
            bail!("The private Task pause requires its canonical scope.");
        }
        let key = self.key(command)?;
        let bound = (key.0.clone(), json!(key.1));
        let intent = self
            .preparation
            .task_pause(
                &bound,
                &key.2,
                &json!({"scope":command["task"],"paused":command["paused"]}),
            )
            .await?;
        let scope = &intent["scope"];
        let paused = intent["paused"] == true;
        let empty = || {
            checked(
                "taskPauseRuntimeStateSchema",
                &json!({"paused":paused,"active":Value::Null}),
            )
        };
        if command["waitForBoundary"] == false {
            return empty();
        }
        let Some(target) = self.preparation.task_pause_target(&bound, &key.2, scope) else {
            return empty();
        };
        let current = || {
            self.preparation
                .assert_task_pause_target(&bound, &key.2, &intent, &target)
        };
        let Some(turn) = target.active_turn().await? else {
            current()?;
            return empty();
        };
        current()?;
        let selected = Selection {
            runtime: target.runtime.clone(),
            thread: target.thread.id().clone(),
            thread_version: target.thread.version(),
            turn,
        };
        let mut result = json!({
            "paused":paused, "active":json!({"threadId":selected.thread,"turnId":selected.turn}),
        });
        if scope["taskGoalCycle"].is_null() && scope["taskRound"].is_null() {
            target.wait_boundary(&intent, &selected.turn).await?;
        } else {
            let observer = self.task_observer(&key, scope, &target, &selected)?;
            let capture = observer.checkpoint();
            let owned = || {
                current()?;
                observer.with_current(&selected, || Ok(()))
            };
            owned()?;
            let checkpoint = if paused {
                let revision = scope["revision"]
                    .as_u64()
                    .context("Missing Task pause revision.")?;
                let mut saved = capture.evidence.lock().await;
                owned()?;
                let evidence = if let Some((_, evidence)) =
                    saved.as_ref().filter(|(prior, _)| *prior == revision)
                {
                    evidence.clone()
                } else {
                    // Select and enqueue under the observation owner lock. The
                    // native request also carries the exact thread and turn.
                    let reply = observer.with_current(&selected, || {
                        Ok(selected.runtime.request(
                            "turn/suspension".into(),
                            Some(json!({"threadId":selected.thread,"operation":json!({"type":"pause","turnId":selected.turn})})),
                            Some(BOUNDARY_TIMEOUT),
                            None,
                        ))
                    })?.await?.context("Codex did not return a Task suspension.")?;
                    let suspension = checked("nativeTurnSuspensionSchema", &reply["suspension"])?;
                    if reply["paused"] != true
                        || suspension["threadId"].as_js_string() != Some(&selected.thread)
                        || suspension["turnId"].as_js_string() != Some(&selected.turn)
                    {
                        bail!("Codex suspended a different Task turn.");
                    }
                    owned()?;
                    let (continuation, task) = capture.snapshot().await?;
                    owned()?;
                    let evidence = self
                        .suspensions
                        .commit(Commit {
                            source: &capture.source(&selected.thread),
                            home: selected.runtime.codex_home(),
                            suspension: &suspension,
                            runtime_version: selected.runtime.version_raw(),
                            runtime_fingerprint: &Value::Null,
                            continuation: Some(&continuation),
                            task_continuation: Some(&task),
                            binding: Some((&key.0, &key.1)),
                        })
                        .await?;
                    *saved = Some((revision, evidence.clone()));
                    evidence
                };
                selected.confirm_held(&evidence["suspension"]).await?;
                evidence
            } else {
                target.wait_boundary(&intent, &selected.turn).await?;
                Value::Null
            };
            owned()?;
            result["execution"] = json!({
                "actor":capture.actor(self.task_inputs.generation(), selected.runtime.admission().generation()),
                "checkpoint":checkpoint,
            });
        }
        current()?;
        checked("taskPauseRuntimeStateSchema", &result)
    }

    fn task_observer(
        &self,
        key: &Key,
        scope: &Value,
        target: &PauseTarget,
        selected: &Selection,
    ) -> Result<Observer> {
        if !scope["taskGoalCycle"].is_null() {
            let owner = target
                .runtime
                .inference_router()
                .active_task_goal_cycle(&selected.thread, target.runner())
                .context("The autonomous Goal has no current execution owner.")?;
            let capture = owner
                .checkpoints
                .current()
                .filter(|candidate| {
                    candidate.matches_cycle(
                        scope,
                        &key.2,
                        &selected.thread,
                        &selected.turn,
                        self.task_inputs.generation(),
                    )
                })
                .context("The autonomous Goal does not match its current native execution.")?;
            return Ok(Observer::Goal(owner, capture));
        }
        let active = self
            .active
            .lock()
            .unwrap()
            .active
            .get(key)
            .cloned()
            .context("The Task input has no current native owner.")?;
        if !active
            .task
            .get()
            .is_some_and(|input| input.matches_round(scope))
        {
            bail!("The Task input does not match the current native owner.");
        }
        Ok(Observer::Round(active))
    }
}

impl PauseTarget {
    async fn active_turn(&self) -> Result<Option<JsString>> {
        self.thread.assert_current(&self.runtime)?;
        let history = self.runtime.read_history(self.thread.id()).await?;
        self.thread.assert_current(&self.runtime)?;
        let mut active = history["thread"]["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|turn| turn["status"] == "inProgress");
        let turn = active
            .next()
            .map(|turn| id(&turn["id"], "active Task turn"))
            .transpose()?;
        if active.next().is_some() {
            bail!("Codex observed multiple active Task turns.");
        }
        Ok(turn)
    }

    async fn wait_boundary(&self, intent: &Value, turn: &JsString) -> Result<()> {
        if intent["paused"] != true {
            return self.apply(intent, true).await;
        }
        let router = self.runtime.inference_router();
        let wait = self.apply(intent, true);
        tokio::pin!(wait);
        loop {
            // A private inference begin can become parkable while Codex is
            // waiting on its provider boundary. Ask the current gate.
            tokio::select! {
                result = &mut wait => return result,
                result = router.pause_pending_root(self.thread.id().clone()) => {
                    if result?.as_ref() == Some(turn) {
                        return Ok(());
                    }
                }
            }
            tokio::select! {
                result = &mut wait => return result,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }
}
