//! Snapshot protected Task input and publication identities.
use super::{Messages, Turn};
use crate::codex::turn::output::{self, Capture, Continuation};
use cantrip_wire::{JsString, Value, value::json};
use std::sync::Arc;

pub(in crate::codex::turn) struct Checkpoint {
    source: Source,
    project: Value,
    observer: Continuation,
    messages: Arc<Messages>,
    protected_input: Value,
    physical: Option<Value>,
    pub evidence: tokio::sync::Mutex<Option<(u64, Value)>>,
}

enum Source {
    Input(Value),
    GoalCycle(Value),
}

impl Turn {
    pub(in crate::codex::turn) fn checkpoint(
        &self,
        command: &Value,
        channel: Capture,
    ) -> Checkpoint {
        let (messages, protected_input) = match self {
            Self::Round(round) => (
                round.messages.clone(),
                json!({"version":1,"request":round.request}),
            ),
            Self::Goal(goal) => (
                goal.messages.clone(),
                json!({"version":2,"prompt":command["protectedTaskPrompt"],
                    "publication":json!({"id":goal.response["messageId"],"idempotencyKey":goal.response["idempotencyKey"]})}),
            ),
        };
        let restoration = &command["taskResumption"];
        let (source, physical) = if restoration.is_null() {
            (Source::Input(command["taskInferenceInput"].clone()), None)
        } else {
            let origin = if restoration["goalCycle"].is_null() {
                Source::Input(restoration["source"].clone())
            } else {
                Source::GoalCycle(restoration["goalCycle"].clone())
            };
            (
                origin,
                Some(command["taskInferenceInput"]["operationId"].clone()),
            )
        };
        Checkpoint {
            source,
            physical,
            project: command["policyProjectId"].clone(),
            observer: Continuation {
                channel,
                seed: output::continuation_seed(
                    command,
                    command["model"].clone(),
                    self.output_schema(),
                ),
            },
            messages,
            protected_input,
            evidence: Default::default(),
        }
    }
}

impl Checkpoint {
    pub(super) fn goal_cycle(
        source: Value,
        project: Value,
        prompt: &Value,
        mut seed: Value,
        channel: Capture,
        messages: Arc<Messages>,
    ) -> Self {
        seed["model"]["routeId"] = source["cycle"]["modelRouteId"].clone();
        let protected_input = json!({
            "version":2, "prompt":prompt, "publication":source["publication"],
        });
        Self {
            source: Source::GoalCycle(source),
            physical: None,
            project,
            observer: Continuation { channel, seed },
            messages,
            protected_input,
            evidence: Default::default(),
        }
    }

    pub(super) fn restore_observer(&mut self, saved: &Value) {
        self.observer.seed = output::restored_seed(saved);
    }

    pub(in crate::codex::turn) fn matches_round(&self, scope: &Value) -> bool {
        let Source::Input(receipt) = &self.source else {
            return false;
        };
        let dispatch = &receipt["dispatch"];
        scope["projectId"] == self.project
            && [
                "workerId",
                "worktreeId",
                "modelRouteId",
                "providerAccountId",
            ]
            .iter()
            .all(|key| scope[*key] == receipt[*key])
            && scope["cycleId"] == dispatch["cycleId"]
            && scope["taskRound"]
                == json!({
                    "inputOperationId":receipt["operationId"],
                    "operationId":dispatch["operationId"],
                    "cycleId":dispatch["cycleId"],
                })
    }

    pub(in crate::codex::turn) fn matches_cycle(
        &self,
        scope: &Value,
        chat: &JsString,
        thread: &JsString,
        turn: &JsString,
        worker: &str,
    ) -> bool {
        let Source::GoalCycle(source) = &self.source else {
            return false;
        };
        let cycle = &source["cycle"];
        let parent = &source["parent"];
        scope["projectId"] == self.project
            && ["workerId", "worktreeId"]
                .iter()
                .all(|key| scope[*key] == parent[*key])
            && ["cycleId", "modelRouteId", "providerAccountId"]
                .iter()
                .all(|key| scope[*key] == cycle[*key])
            && (self.physical.is_some() || source["workerGeneration"] == worker)
            && source["threadId"].as_js_string() == Some(thread)
            && source["turnId"].as_js_string() == Some(turn)
            && parent["chatId"].as_js_string() == Some(chat)
            && scope["taskGoalCycle"]
                == json!({
                    "cycleId":cycle["cycleId"], "sourceKey":source["sourceKey"],
                    "operationId":source["operationId"], "goalEpoch":cycle["goalEpoch"], "scopeId":cycle["scopeId"],
                })
    }

    pub(in crate::codex::turn) fn source(&self, thread: &JsString) -> Value {
        let (parent, route) = match &self.source {
            Source::Input(receipt) => (receipt, receipt),
            Source::GoalCycle(source) => (&source["parent"], &source["cycle"]),
        };
        let mut result = json!({
            "chatId":parent["chatId"],"threadId":thread,"contextKind":"project",
            "projectId":self.project,"placementId":parent["worktreeId"],
            "modelRouteId":route["modelRouteId"],"providerAccountId":route["providerAccountId"],
        });
        match &self.source {
            Source::Input(receipt) => result["taskInput"] = receipt.clone(),
            Source::GoalCycle(source) => result["taskGoalCycle"] = source.clone(),
        }
        result
    }

    pub(in crate::codex::turn) fn actor(&self, worker: &str, runtime: &JsString) -> Value {
        if let Some(physical) = &self.physical {
            return json!({
                "workerGeneration":worker,"runtimeGeneration":runtime,
                "operationId":physical,"operationGeneration":physical,
            });
        }
        match &self.source {
            // Core binds tasks to inference admission, separately from the
            // generation of the app-server transport used to hold the turn.
            Source::Input(receipt) => json!({
                "workerGeneration":worker,"runtimeGeneration":runtime,
                "operationId":receipt["operationId"],"operationGeneration":receipt["operationId"],
            }),
            Source::GoalCycle(source) => json!({
                "workerGeneration":source["workerGeneration"],"runtimeGeneration":source["runtimeGeneration"],
                "operationId":source["operationId"],"operationGeneration":source["operationId"],
            }),
        }
    }

    pub(in crate::codex::turn) async fn snapshot(&self) -> anyhow::Result<(Value, Value)> {
        let continuation = self.observer.snapshot().await?;
        self.messages.assert_bound()?;
        let output = self.messages.output.lock().unwrap();
        let mut identities = output.ids.iter().collect::<Vec<_>>();
        identities.sort_by(|(_, first), (_, second)| first.cmp(second));
        let completed = output.final_message.as_ref().map(|completed| json!({
            "threadId":completed.thread,"turnId":completed.turn,"text":completed.text,"message":completed.cipher,
        }));
        let mode = if continuation["structuredChat"] == true {
            "plan"
        } else {
            self.messages.mode
        };
        let mut protected = self.protected_input.clone();
        protected["events"] = json!({
            "version":1,"mode":mode,"ids":identities,"completedRootMessage":completed,
        });
        Ok((continuation, protected))
    }
}

impl Turn {
    pub(super) fn restore_output(&self, saved: &Value) -> anyhow::Result<()> {
        match self {
            Self::Round(round) => round.messages.restore_output(saved),
            Self::Goal(goal) => goal.messages.restore_output(saved),
        }
    }
}
