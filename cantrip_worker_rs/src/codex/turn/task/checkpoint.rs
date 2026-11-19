//! Snapshot the protected input and publication identities of an explicit Task.
use super::{Messages, Turn};
use crate::codex::turn::output::{self, Capture, Continuation};
use cantrip_wire::{JsString, Value, value::json};
use std::sync::Arc;

pub(in crate::codex::turn) struct Checkpoint {
    receipt: Value,
    project: Value,
    observer: Continuation,
    messages: Arc<Messages>,
    protected_input: Value,
    pub evidence: tokio::sync::Mutex<Option<(u64, Value)>>,
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
        Checkpoint {
            receipt: command["taskInferenceInput"].clone(),
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
    pub(in crate::codex::turn) fn matches_round(&self, scope: &Value) -> bool {
        let receipt = &self.receipt;
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

    pub(in crate::codex::turn) fn source(&self, thread: &JsString) -> Value {
        json!({
            "chatId":self.receipt["chatId"],"threadId":thread,"contextKind":"project",
            "projectId":self.project,"placementId":self.receipt["worktreeId"],
            "modelRouteId":self.receipt["modelRouteId"],"providerAccountId":self.receipt["providerAccountId"],
            "taskInput":self.receipt,
        })
    }

    pub(in crate::codex::turn) fn actor(&self, worker: &str, runtime: &JsString) -> Value {
        json!({
            "workerGeneration":worker,"runtimeGeneration":runtime,
            "operationId":self.receipt["operationId"],"operationGeneration":self.receipt["operationId"],
        })
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
