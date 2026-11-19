use super::{Active, Binding, Capture, Ordering, Selection, Turns, output};
use crate::{
    codex::{suspension_store::Commit, turn::receipt::Receipt},
    http::checked,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use std::time::Duration;
use tokio::sync::oneshot;

pub(super) const BOUNDARY_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

impl Binding {
    pub(in crate::codex::turn) fn capture(&self, command: &Value, channel: output::Capture) {
        // All fields tracked by the Rust observer come from the ordered
        // stream. The other fields use the Node continuation's empty values.
        let empty = Value::Array(Vec::new());
        let mut model = command["model"].clone();
        // Keep the original worker model identity even on an inherited route.
        model["routeId"] = self.session["modelRouteId"].clone();
        let seed = json!({
            "version":1, "chatId":self.session["chatId"], "cwd":command["cwd"],
            "startedAtMs":chrono::Utc::now().timestamp_millis(), "executionKind":"chat",
            "providerId":command["provider"]["id"], "providerKind":command["provider"]["kind"],
            "model":model, "baseline":empty, "initialSettings":Value::Null,
            "nativeModelAttribution":Value::Null,"inheritThreadSettings":true,
            "collaborationMode":Value::Null,"contextUsage":Value::Null,"contextUsageUpdatedAtMs":Value::Null,
            "durationMs":Value::Null,"diffChanges":empty,"commandTelemetry":empty,"completedCommandIds":empty,
            "fileStartedAtMs":empty,"itemStartedAtMs":empty,"liveAgentMessageFingerprints":empty,
            "observedActivityFingerprints":empty,"pendingActivities":empty,"pendingAgentMessage":Value::Null,
            "streamingAgentMessage":Value::Null,"reasoningSummaries":empty,"structuredChat":false,
            "structuredOutputSchema":Value::Null,"goalCompletion":Value::Null,
        });
        self.restore_capture(channel, seed);
    }

    pub(super) fn restore_capture(&self, channel: output::Capture, seed: Value) {
        let _ = self.checkpoint.set(Capture {
            events: channel,
            seed,
        });
    }

    async fn continuation(&self) -> Result<Value> {
        let capture = self
            .checkpoint
            .get()
            .context("The native turn observer was not attached.")?;
        let (answer, receive) = oneshot::channel();
        capture
            .events
            .send(output::Event::Checkpoint(capture.seed.clone(), answer))
            .map_err(|_| anyhow!("The native turn observer ended before capture."))?;
        receive
            .await
            .context("The native turn observer ended before capture.")
    }

    pub(super) fn matches_checkpoint<'a>(
        &self,
        command: &'a Value,
        selected: &Selection,
    ) -> Result<&'a Value> {
        let session = &command["session"];
        let placement = if session["contextKind"] == "project" {
            "worktreeId"
        } else {
            "scratchRootId"
        };
        let checkpoint = &command["checkpoint"]["suspension"];
        if session.get("osExecution").is_some()
            || ["chatId", "contextKind", "projectId"]
                .iter()
                .any(|key| session[*key] != self.session[*key])
            || session[placement] != self.session["placementId"]
            || checkpoint["threadId"].as_js_string() != Some(&selected.thread)
            || checkpoint["turnId"].as_js_string() != Some(&selected.turn)
        {
            bail!("The saved suspension belongs to a different active native execution.");
        }
        Ok(checkpoint)
    }

    fn suspension_source(&self) -> Value {
        json!({
            "chatId":self.session["chatId"], "threadId":self.session["threadId"],
            "contextKind":self.session["contextKind"], "projectId":self.session["projectId"],
            "placementId":self.session["placementId"], "modelRouteId":self.session["modelRouteId"],
            "providerAccountId":self.session["providerAccountId"],
        })
    }
}

impl Turns {
    pub(super) async fn pause(
        &self,
        active: &Active,
        binding: &Binding,
        selected: Selection,
        receipt: &Receipt<'_>,
        paused: bool,
        checkpoint: Option<&Value>,
    ) -> Result<Value> {
        receipt.dispatch_durable().await?;
        if let Some(checkpoint) = checkpoint {
            let ready = selected.confirm_held(checkpoint).await;
            if let Err(error) = ready {
                receipt.settle_durable("uncertain", None, None).await?;
                return Err(error);
            }
        }
        let chat = binding.session["chatId"].as_js_string().unwrap();
        receipt.scope().identity()?;
        let request = (|| {
            // Enqueue the already admitted mutation under the current phase lock.
            let phase = active.phase.lock().unwrap();
            if !selected.current(&phase) || active.logical_finished.load(Ordering::Relaxed) {
                return Ok(None);
            }
            if paused {
                selected.runtime.admission().set_chat_paused(chat, true)?;
            }
            let (method, params) = if paused {
                (
                    "turn/suspension",
                    json!({
                        "threadId":selected.thread,"operation":json!({"type":"pause","turnId":selected.turn}),
                    }),
                )
            } else {
                (
                    "turn/pause",
                    json!({"threadId":selected.thread,"turnId":selected.turn,"paused":false}),
                )
            };
            Ok::<_, anyhow::Error>(Some(selected.runtime.request(
                method.into(),
                Some(params),
                Some(BOUNDARY_TIMEOUT),
                None,
            )))
        })();
        let request = match request {
            Ok(Some(request)) => request,
            Ok(None) => {
                receipt.settle_durable("rejected", Some(&json!({"error":json!({
                    "code":-32000,"message":"The native turn ended before Pause was forwarded.",
                })})), None).await?;
                return result(paused, None);
            }
            Err(error) => {
                receipt.settle_durable("uncertain", None, None).await?;
                return Err(error);
            }
        };

        let outcome = async {
            let reply = request
                .await?
                .context("Codex did not acknowledge the Pause control.")?;
            receipt.scope().identity()?;
            if !selected.current(&active.phase.lock().unwrap()) {
                bail!("The native turn changed during the Pause control.");
            }
            if reply["paused"] != paused {
                bail!("Codex acknowledged a different Pause control.");
            }
            let evidence = if paused {
                Some(
                    self.capture_suspension(binding, &selected, receipt, &reply)
                        .await?,
                )
            } else {
                None
            };
            if !selected.current(&active.phase.lock().unwrap()) {
                bail!("The native turn changed during the Pause control.");
            }
            Ok::<_, anyhow::Error>((reply, evidence))
        }
        .await;

        let (reply, evidence) = match outcome {
            Ok(value) => value,
            Err(error) => {
                // A failed capture can leave the Core checkpoint held. Record
                // uncertainty and keep the local hold until the owner resolves it.
                let settlement = receipt.settle_durable("uncertain", None, None).await;
                if selected.runtime.is_live()
                    && let Ok(history) = selected.runtime.read_history(&selected.thread).await
                    && history["thread"]["turns"].as_array().is_some_and(|turns| {
                        turns.iter().any(|turn| {
                            turn["id"].as_js_string() == Some(&selected.turn)
                                && matches!(
                                    turn["status"].as_str(),
                                    Some("completed" | "failed" | "interrupted")
                                )
                        })
                    })
                {
                    return result(paused, None);
                }
                settlement?;
                return Err(error);
            }
        };
        receipt
            .settle_durable("applied", Some(&json!({"result":reply})), evidence.as_ref())
            .await?;
        if !paused {
            receipt.scope().identity()?;
            selected.runtime.admission().set_chat_paused(chat, false)?;
        }
        result(paused, Some(&selected))
    }

    async fn capture_suspension(
        &self,
        binding: &Binding,
        selected: &Selection,
        receipt: &Receipt<'_>,
        reply: &Value,
    ) -> Result<Value> {
        let suspension = checked("nativeTurnSuspensionSchema", &reply["suspension"])?;
        if suspension["threadId"].as_js_string() != Some(&selected.thread)
            || suspension["turnId"].as_js_string() != Some(&selected.turn)
        {
            bail!("Codex suspended a different native turn.");
        }
        let continuation = binding.continuation().await?;
        let scope = receipt.scope();
        let evidence = self
            .suspensions
            .commit(Commit {
                source: &binding.suspension_source(),
                home: selected.runtime.codex_home(),
                suspension: &suspension,
                runtime_version: selected.runtime.version_raw(),
                runtime_fingerprint: &Value::Null,
                continuation: Some(&continuation),
                task_continuation: None,
                binding: Some((&scope.owner, &scope.server)),
            })
            .await?;
        selected.confirm_held(&suspension).await?;
        Ok(evidence)
    }
}

impl Selection {
    pub(super) async fn confirm_held(&self, suspension: &Value) -> Result<()> {
        let result = self
            .runtime
            .request(
                "turn/suspension".into(),
                Some(json!({"threadId":self.thread,"operation":json!({"type":"read"})})),
                None,
                None,
            )
            .await?
            .context("Codex did not confirm the saved suspension.")?;
        if !self.transport_current()
            || result["paused"] != true
            || &result["suspension"] != suspension
        {
            bail!("The native runtime no longer holds the requested checkpoint.");
        }
        Ok(())
    }
}

pub(super) fn result(paused: bool, active: Option<&Selection>) -> Result<Value> {
    let active = active.map(|selected| json!({"threadId":selected.thread,"turnId":selected.turn}));
    checked(
        "chatPauseRuntimeStateSchema",
        &json!({"paused":paused,"active":active}),
    )
}
