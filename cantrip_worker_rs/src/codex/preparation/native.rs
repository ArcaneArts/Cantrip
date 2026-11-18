//! Native load and configuration while the managed preparation owns the chat.
//! The caller supplies worker-authorized model, placement and overlay values.
use super::{Identify, Intent, Selection};
use crate::codex::{managed::Runtime, rpc_requests::Failure};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::time::Duration;
use tokio::time::Instant;

const RPC_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Configuration {
    pub start: Value,
    pub configure_existing: Value,
    pub managed_overlay: Option<Value>,
    pub expected_suspension: Option<Value>,
}

#[derive(Clone)]
pub struct LoadedThread {
    id: JsString,
    generation: String,
    version: u64,
}

impl LoadedThread {
    pub fn id(&self) -> &JsString {
        &self.id
    }

    pub fn assert_current(&self, runtime: &Runtime) -> Result<()> {
        if !runtime.is_live() || runtime.generation() != self.generation {
            bail!("The native runtime changed during thread preparation.");
        }
        if runtime.thread_version(&self.id) != self.version {
            bail!("Codex thread closed or changed during preparation.");
        }
        Ok(())
    }
}

/// Start a new managed thread or reattach the requested identity. Existing
/// security and approval choices are owned by its native Core.
pub async fn load(
    runtime: &Runtime,
    selection: &Selection,
    configuration: &Configuration,
    identify: &Identify,
) -> Result<LoadedThread> {
    let overlay = overlay(configuration, selection.intent)?;
    let mut params = match (&selection.thread_id, selection.intent) {
        (None, _) => configuration.start.clone(),
        (Some(_), Intent::Configure) => configuration.configure_existing.clone(),
        (Some(_), Intent::Preserve) => json!({}),
    };
    let fields = params
        .as_object()
        .context("Managed native thread parameters")?;
    // The two inputs are base parameters; explicit ownership fields come
    // only from the admitted selection and verified suspension.
    if ["threadId", "managedConfig", "expectedSuspension"]
        .iter()
        .any(|name| fields.contains_key(&JsString::from(*name)))
    {
        bail!("Managed native thread parameters override the selected identity or overlay.");
    }
    if let Some(overlay) = overlay {
        params["managedConfig"] = overlay;
    }
    let thread = match &selection.thread_id {
        Some(expected) => {
            let Value::Object(fields) = &mut params else {
                unreachable!()
            };
            for field in [
                "permissions",
                "approvalPolicy",
                "approvalsReviewer",
                "sandbox",
            ] {
                fields.shift_remove(&JsString::from(field));
            }
            params["threadId"] = json!(expected);
            if let Some(suspension) = &configuration.expected_suspension {
                params["expectedSuspension"] = suspension.clone();
            }
            let thread = LoadedThread {
                id: expected.clone(),
                generation: runtime.generation().to_owned(),
                version: runtime.thread_version(expected),
            };
            identify(expected.clone()).await?;
            let loaded = resumed(runtime, params, &thread).await?;
            if thread_id(&loaded)? != expected {
                bail!("Codex resumed a different thread than requested.");
            }
            thread
        }
        None => {
            let started = request(runtime, "thread/start", params).await?;
            let thread = thread_id(&started)?.clone();
            identify(thread.clone()).await?;
            LoadedThread {
                id: thread,
                generation: runtime.generation().to_owned(),
                version: 0,
            }
        }
    };
    thread.assert_current(runtime)?;
    Ok(thread)
}

/// Refresh the managed overlay and require the native acknowledgment before
/// callers complete preparation. A preserving attach retains native defaults.
pub async fn configure(
    runtime: &Runtime,
    thread: &LoadedThread,
    intent: Intent,
    configuration: &Configuration,
) -> Result<()> {
    thread.assert_current(runtime)?;
    if let Some(mut params) = overlay(configuration, intent)? {
        params["threadId"] = json!(thread.id());
        let reply = request(runtime, "thread/managedConfig/update", params).await?;
        thread.assert_current(runtime)?;
        if reply["threadId"].as_js_string() != Some(thread.id()) || reply["applied"] != true {
            bail!("Codex did not acknowledge the managed configuration for the requested thread.");
        }
    }
    Ok(())
}

fn overlay(configuration: &Configuration, intent: Intent) -> Result<Option<Value>> {
    let Some(mut overlay) = configuration.managed_overlay.clone() else {
        return Ok(None);
    };
    if !overlay.is_object() || overlay.get("threadId").is_some() {
        bail!("Invalid managed native thread overlay.");
    }
    if intent == Intent::Preserve {
        overlay["preserveSubagentSettings"] = json!(true);
    }
    Ok(Some(overlay))
}

fn thread_id(result: &Value) -> Result<&JsString> {
    result["thread"]["id"]
        .as_js_string()
        .filter(|id| !id.trim().is_empty())
        .context("Codex returned an invalid thread identity.")
}

async fn resumed(runtime: &Runtime, params: Value, thread: &LoadedThread) -> Result<Value> {
    // A detached Codex writer can briefly survive worker loss. Retry the
    // actual lock rejection within the same interval as the Node worker.
    let deadline = Instant::now() + Duration::from_secs(3);
    let writer_error = format!("thread {} already has an active writer", thread.id.lossy());
    loop {
        thread.assert_current(runtime)?;
        let reply = request(runtime, "thread/resume", params.clone()).await;
        thread.assert_current(runtime)?;
        match reply {
            Err(error)
                if Instant::now() < deadline
                    && runtime.is_live()
                    && error
                        .downcast_ref::<Failure>()
                        .and_then(|error| error.native_error.as_ref())
                        .is_some_and(|native| {
                            native["code"].as_i64() == Some(-32600)
                                && native["message"] == writer_error
                        }) =>
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            result => return result,
        }
    }
}

async fn request(runtime: &Runtime, method: &str, params: Value) -> Result<Value> {
    runtime
        .request(method.into(), Some(params), Some(RPC_TIMEOUT), None)
        .await?
        .with_context(|| format!("Codex did not return a {method} result."))
}
