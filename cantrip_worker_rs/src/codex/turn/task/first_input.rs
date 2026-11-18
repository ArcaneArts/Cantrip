//! Transfer the native producer to the server's exact first Goal input.
use super::super::{RPC_TIMEOUT, Signal, id};
use crate::codex::{
    preparation::command::Prepared, private_inference::FirstInput, rpc_requests::Response,
};
use anyhow::{Context, Result, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use std::time::Duration;

struct Hold<'a> {
    prepared: &'a Prepared,
    operation: &'a Value,
    revision: JsString,
}

struct Dispatching(FirstInput);
impl Drop for Dispatching {
    fn drop(&mut self) {
        self.0.set_dispatching(false);
    }
}

pub(in crate::codex::turn) async fn start(
    prepared: &Prepared,
    receipt: &Value,
    signal: &Signal,
    dispatch: impl FnOnce() -> Result<Work<Response>>,
) -> Result<Result<Response>> {
    let thread = prepared.thread.id();
    let runner = &prepared.runner_generation;
    let router = prepared.runtime.inference_router();
    let message = id(&receipt["clientMessageId"], "Task Goal input message")?;
    let first = router.task_first_input(thread, runner, &message)?;
    let operation = &receipt["operationId"];
    let observed = control(prepared, json!({"action":"read"})).await?;
    if !observed["heldBy"].is_null() && observed["heldBy"] != *operation {
        bail!("Another operation holds the native Goal producer.");
    }
    let hold = Hold {
        prepared,
        operation,
        revision: id(&observed["revision"], "native producer revision")?,
    };
    let result = async {
        signal.check()?;
        hold.acquire().await?;
        first.set_dispatching(true);
        let _dispatching = Dispatching(first.clone());
        let current = || -> Result<()> {
            prepared.thread.assert_current(&prepared.runtime)?;
            if !router
                .task_first_input(thread, runner, &message)?
                .same(&first)
            {
                bail!("The native Goal first input changed during dispatch.");
            }
            signal.check()
        };
        let ready = async {
            loop {
                current()?;
                for pending in router.pending() {
                    let gate = pending.gate();
                    if &gate.key.thread_id != thread
                        || &gate.key.runner_generation != runner
                        || !pending
                            .first_input()
                            .is_some_and(|owner| owner.same(&first))
                    {
                        continue;
                    }
                    let result = router
                        .deny_for_first_input(&pending, {
                            let router = router.clone();
                            let (thread, runner, message, first) = (
                                thread.clone(),
                                runner.clone(),
                                message.clone(),
                                first.clone(),
                            );
                            move || {
                                if !router
                                    .task_first_input(&thread, &runner, &message)?
                                    .same(&first)
                                {
                                    bail!("The Task input lost its native producer hold.");
                                }
                                Ok(())
                            }
                        })
                        .await;
                    if router.is_current(&pending) {
                        result?;
                    }
                }
                let observed = request(
                    prepared,
                    "thread/read",
                    json!({
                        "threadId":thread, "includeTurns":false,
                    }),
                )
                .await?;
                if observed["thread"]["id"].as_js_string() != Some(thread) {
                    bail!("Codex observed a different thread while starting the Goal.");
                }
                if observed["thread"]["status"]["type"] == "idle" {
                    return current();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(RPC_TIMEOUT, ready)
            .await
            .context("The native Goal did not settle its previous producer.")??;
        Ok::<_, anyhow::Error>(dispatch()?.await)
    }
    .await;
    // If the native input was sent, cleanup must never replace its outcome or
    // trigger another dispatch. The first-input reservation stays scoped to the
    // root while autonomous cycle delivery is wired separately.
    if prepared.runtime.is_live() && hold.release().await.is_err() {
        let _ = hold.release().await;
    }
    result
}

impl Hold<'_> {
    async fn acquire(&self) -> Result<()> {
        let held = control(
            self.prepared,
            json!({
                "action":"hold", "operationId":self.operation, "expectedRevision":self.revision,
            }),
        )
        .await?;
        if held["heldBy"] != *self.operation {
            bail!("Codex did not acknowledge the first Goal input's producer hold.");
        }
        Ok(())
    }

    async fn release(&self) -> Result<()> {
        let observed = control(self.prepared, json!({"action":"read"})).await?;
        if !observed["heldBy"].is_null() && observed["heldBy"] != *self.operation {
            bail!("Another operation now holds the native Goal producer.");
        }
        let released = control(self.prepared, json!({
            "action":"release", "operationId":self.operation,
            "expectedRevision":if observed["heldBy"].is_null() { json!(self.revision) } else { observed["revision"].clone() },
        })).await?;
        if !released["heldBy"].is_null() {
            bail!("Codex did not release the first Goal input's producer hold.");
        }
        Ok(())
    }
}

async fn control(prepared: &Prepared, mut params: Value) -> Result<Value> {
    params["threadId"] = json!(prepared.thread.id());
    params["runnerGeneration"] = json!(prepared.runner_generation);
    let state = request(prepared, "thread/managedExecution/handoff", params).await?;
    let revision = state["revision"]
        .as_str()
        .context("Missing native producer revision.")?;
    if revision
        .parse::<u64>()
        .map(|value| value.to_string())
        .ok()
        .as_deref()
        != Some(revision)
        || !state
            .get("heldBy")
            .is_some_and(|value| value.is_null() || value.is_string())
    {
        bail!("Invalid native Goal producer acknowledgment.");
    }
    Ok(state)
}

async fn request(prepared: &Prepared, method: &str, params: Value) -> Result<Value> {
    prepared.thread.assert_current(&prepared.runtime)?;
    let reply = prepared
        .runtime
        .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
        .await?;
    prepared.thread.assert_current(&prepared.runtime)?;
    reply.with_context(|| format!("Missing native response to {method}."))
}
