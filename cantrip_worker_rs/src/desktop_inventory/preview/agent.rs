//! Authorized JavaScript host actions on the turn's assigned desktop.
#[cfg(all(test, unix))]
mod tests;

use super::{DEADLINE, DesktopRequest, Previews, Request, guest, native};
use crate::{
    computer_use::{HostError, Javascript},
    http::checked,
    metadata::{Abort, Signal},
};
use anyhow::{Result, ensure};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};

const MAX_IMAGES: usize = 2;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// The policy operation and target come from worker-owned context. A wait
/// needs current authority without a separate approval operation.
pub struct HostAction {
    pub operation: Option<&'static str>,
    pub target: Value,
}

pub struct HostSnapshot {
    pub metadata: Value,
    pub pixels: Zeroizing<Vec<u8>>,
}

pub struct HostEvaluation {
    pub value: Value,
    pub images: Vec<HostSnapshot>,
    pub input_receipts: Vec<Value>,
}

#[derive(Default)]
struct EvaluationFrames {
    images: Vec<HostSnapshot>,
    input_receipts: Vec<Value>,
}

pub struct DesktopTurn {
    desktop: Previews,
    authority: Value,
    execution: Option<Value>,
    bound: Value,
    epoch: u64,
    abort: Arc<Abort>,
    signal: Signal,
    attachment: Arc<Mutex<Arc<Attachment>>>,
}

struct Attachment {
    native: Arc<native::Attachment>,
    guest: Mutex<Option<guest::GuestLease>>,
}

impl Attachment {
    fn new(authority: &Value, binding: &Value) -> Self {
        Self {
            native: Arc::new(native::Attachment::new(authority, Some(binding))),
            guest: Mutex::default(),
        }
    }

    fn retire(&self, manager: &super::Manager, in_guest: bool) {
        if in_guest {
            manager.guests.release(&self.guest, self.native.clone());
        } else {
            let _ = manager.retirements.send(self.native.clone());
        }
    }
}

struct EvaluationAttachment<'a> {
    desktop: &'a DesktopTurn,
    attachment: Arc<Attachment>,
    keep: bool,
}

impl Drop for EvaluationAttachment<'_> {
    fn drop(&mut self) {
        if !self.keep {
            self.desktop.retire(&self.attachment);
        }
    }
}

impl Previews {
    /// Binds an observed evaluator to the exact Host or guest placement.
    pub fn bind_turn(
        &self,
        authority: &Value,
        javascript: &Javascript,
        epoch: u64,
    ) -> Result<DesktopTurn> {
        let authority = checked("cuaAgentAuthoritySchema", authority)?;
        self.authorize(&authority)?;
        let binding = javascript.binding();
        ensure!(
            self.0.outgoing.stream_current(epoch)
                && binding["chatId"] == authority["chatId"]
                && binding["workerId"] == authority["workerId"],
            "Computer use is outside the assigned execution."
        );
        let execution = self.0.guests.placement(&authority)?;
        let in_guest = execution.is_some();
        let (abort, signal) = Abort::new();
        let abort = Arc::new(abort);
        let signal = Signal::any(vec![signal, javascript.turn(), self.0.running.clone()]);
        signal.check()?;
        let attachment = Arc::new(Mutex::new(Arc::new(Attachment::new(&authority, binding))));
        let manager = Arc::downgrade(&self.0);
        let mut connection = self.0.outgoing.stream_epoch();
        tokio::spawn({
            let attachment = attachment.clone();
            let signal = signal.clone();
            let abort = abort.clone();
            async move {
                tokio::select! {
                    _ = signal.cancelled() => {},
                    _ = connection.wait_for(|current| *current != epoch) => {
                        abort.abort(anyhow::anyhow!("Computer-use worker connection changed."));
                    },
                }
                let attachment = attachment.lock().unwrap().clone();
                if let Some(manager) = manager.upgrade() {
                    attachment.retire(&manager, in_guest);
                }
            }
        });
        Ok(DesktopTurn {
            desktop: self.clone(),
            authority,
            execution,
            bound: binding.clone(),
            epoch,
            abort,
            signal,
            attachment,
        })
    }
}

impl DesktopTurn {
    /// The coordinator refreshes Core authority and waits for any required
    /// approval. Only this callback can authorize a native action.
    pub async fn evaluate<F, A>(
        &self,
        javascript: &mut Javascript,
        source: &JsString,
        request: Signal,
        authorize: A,
    ) -> Result<HostEvaluation>
    where
        F: Future<Output = Result<(), HostError>>,
        A: Fn(HostAction, Signal) -> F,
    {
        ensure!(
            javascript.binding() == &self.bound,
            "The evaluator belongs to another native turn."
        );
        self.signal.check()?;
        ensure!(
            self.placement_current(),
            "The computer-use placement changed."
        );
        let mut owned = self.evaluation_attachment();
        let frames = Mutex::new(EvaluationFrames::default());
        let value = javascript
            .evaluate(
                source,
                0,
                Signal::any(vec![request, self.signal.clone()]),
                |action, signal| {
                    self.action(&owned.attachment, action, signal, &frames, &authorize)
                },
            )
            .await;
        owned.keep = value.is_ok()
            || value.as_ref().is_err_and(|error| {
                error
                    .downcast_ref::<crate::computer_use::NativeError>()
                    .is_some_and(|error| {
                        matches!(
                            error.code(),
                            "capture-failed"
                                | "capture-inventory-timeout"
                                | "capture-image-timeout"
                                | "script-syntax"
                                | "script-evaluation"
                                | "script-action"
                                | "control-not-found"
                                | "control-ambiguous"
                                | "control-inspection-incomplete"
                                | "unsupported"
                        )
                    })
            });
        let value = value?;
        let EvaluationFrames {
            images,
            input_receipts,
        } = frames.into_inner().unwrap();
        Ok(HostEvaluation {
            value,
            images,
            input_receipts,
        })
    }

    pub async fn reset(&self, javascript: &mut Javascript) -> Result<()> {
        ensure!(
            javascript.binding() == &self.bound,
            "The evaluator belongs to another native turn."
        );
        let _attachment = self.evaluation_attachment();
        javascript.reset().await
    }

    fn evaluation_attachment(&self) -> EvaluationAttachment<'_> {
        EvaluationAttachment {
            desktop: self,
            attachment: self.attachment.lock().unwrap().clone(),
            keep: false,
        }
    }

    fn retire(&self, attachment: &Arc<Attachment>) {
        let mut current = self.attachment.lock().unwrap();
        if Arc::ptr_eq(&current, attachment) {
            let previous = std::mem::replace(
                &mut *current,
                Arc::new(Attachment::new(&self.authority, &self.bound)),
            );
            previous.retire(&self.desktop.0, self.execution.is_some());
        }
    }

    fn placement_current(&self) -> bool {
        self.desktop.0.outgoing.stream_current(self.epoch)
            && self.desktop.authorize(&self.authority).is_ok()
            && self
                .desktop
                .0
                .guests
                .placement(&self.authority)
                .is_ok_and(|current| current == self.execution)
    }

    fn current(&self, signal: &Signal) -> Result<(), HostError> {
        signal.check().map_err(|_| HostError::new("cancelled"))?;
        if self.placement_current() {
            Ok(())
        } else {
            Err(HostError::new("ownership-mismatch"))
        }
    }

    async fn action<F: Future<Output = Result<(), HostError>>>(
        &self,
        attachment: &Attachment,
        action: Value,
        signal: Signal,
        frames: &Mutex<EvaluationFrames>,
        authorize: &impl Fn(HostAction, Signal) -> F,
    ) -> Result<Value, HostError> {
        self.current(&signal)?;
        let session = attachment.native.data(None);
        let (policy, command) = command(&action, &session)?;
        authorize(policy, signal.clone()).await?;
        self.current(&signal)?;
        match action["operation"].as_str() {
            Some("wait") => {
                let ms = action["ms"].as_u64().expect("validated wait duration");
                tokio::select! {
                    biased;
                    _ = signal.cancelled() => return Err(HostError::new("cancelled")),
                    _ = tokio::time::sleep(Duration::from_millis(ms)) => {},
                }
                self.current(&signal)?;
                return Ok(json!({"waitedMs":ms}));
            }
            Some("state") if session.is_null() => return Ok(json!({"session":session})),
            _ => {}
        }
        if command.is_null() {
            return Err(HostError::new(if session.is_null() {
                "session-not-found"
            } else {
                "target-not-found"
            }));
        }
        let snapshot = command["operation"] == "observation.snapshot";
        if snapshot && frames.lock().unwrap().images.len() >= MAX_IMAGES {
            return Err(HostError::new("capacity"));
        }
        let response = self.dispatch(attachment, command, &signal).await?;
        self.current(&signal)?;
        let mut data = response.data;
        if action["operation"] == "cursor" {
            return Ok(data["session"]["cursor"].clone());
        }
        let mut frames = frames.lock().unwrap();
        if let Some(input) = data.get("input") {
            frames.input_receipts.push(input.clone());
        }
        if snapshot {
            let total = frames
                .images
                .iter()
                .map(|image| image.pixels.len())
                .sum::<usize>();
            if total + response.pixels.len() > MAX_IMAGE_BYTES {
                return Err(HostError::new("capacity"));
            }
            let index = frames.images.len();
            frames.images.push(HostSnapshot {
                metadata: data.clone(),
                pixels: response.pixels,
            });
            data["imageIndex"] = json!(index);
        }
        Ok(data)
    }

    async fn dispatch(
        &self,
        attachment: &Attachment,
        action: Value,
        signal: &Signal,
    ) -> Result<native::ResultData, HostError> {
        let mutating = native::mutates_desktop(&action);
        let (reply, result) = oneshot::channel();
        let request = Request {
            attachment: attachment.native.clone(),
            epoch: self.epoch,
            signal: signal.clone(),
            allow_cantrip_app: self.authority["cantripAppAllowed"] == true,
            deadline: (action["operation"] != "input.perform").then(|| Instant::now() + DEADLINE),
            action,
            reply,
        };
        if let Some(execution) = &self.execution {
            self.desktop
                .0
                .guests
                .submit(&self.authority, &attachment.guest, execution, request)
                .map_err(|error| dispatch_error(error, mutating))?;
        } else {
            self.desktop
                .0
                .requests
                .try_send(DesktopRequest::ComputerUse(request))
                .map_err(|_| HostError::new("capacity"))?;
        }
        result
            .await
            .map_err(|_| HostError::new("cancelled"))?
            .map_err(|error| dispatch_error(error, mutating))
    }
}

impl Drop for DesktopTurn {
    fn drop(&mut self) {
        self.abort
            .abort(anyhow::anyhow!("Computer-use desktop execution ended."));
    }
}

fn dispatch_error(error: anyhow::Error, mutating: bool) -> HostError {
    let rejected = error.downcast_ref::<native::Rejected>();
    let code = match rejected {
        Some(failed) if mutating && failed.outcome == "unknown" => "input-unknown",
        Some(failed) if failed.code == "timeout" => "cancelled",
        Some(failed) if failed.code == "unavailable" => "unsupported",
        Some(failed) => &failed.code,
        None if error.is::<crate::metadata::Cancelled>() => "cancelled",
        None => "invalid-request",
    };
    HostError::new(code)
}

fn command(action: &Value, session: &Value) -> Result<(HostAction, Value), HostError> {
    let name = action["operation"].as_str().unwrap_or_default();
    let (operation, fields, from_session) = match name {
        "wait" => {
            ensure_shape(action, &["ms"])?;
            if action["ms"].as_u64().is_none_or(|ms| ms > 10_000) {
                return Err(HostError::new("script-action"));
            }
            return Ok((
                HostAction {
                    operation: None,
                    target: Value::Null,
                },
                Value::Null,
            ));
        }
        "state" | "cursor" => ("session.state", &[][..], false),
        "targets" => ("targets.list", &["after"][..], false),
        "attach" => ("target.attach", &["target"][..], false),
        "detach" => ("target.detach", &[][..], false),
        "snapshot" => ("observation.snapshot", &[][..], true),
        "readClipboard" => ("clipboard.read", &[][..], true),
        "writeClipboard" => ("clipboard.write", &["text"][..], true),
        "resizeDesktop" => ("desktop.resize", &["width", "height"][..], true),
        "configureCursor" => ("cursor.configure", &["appearance"][..], true),
        "moveCursor" => ("cursor.move", &["point"][..], true),
        "controls" => ("controls.inspect", &["point"][..], true),
        "click" | "globalClick" | "processClick" | "backgroundClick" => {
            ("input.click", &["point"][..], true)
        }
        "press" => ("input.press", &["reference"][..], true),
        "perform" => ("input.perform", &["command"][..], true),
        _ => return Err(HostError::new("script-action")),
    };
    ensure_shape(action, fields)?;
    let target = if name == "attach" {
        let target = &action["target"];
        if !target.as_object().is_some_and(|fields| fields.len() == 2) {
            return Err(HostError::new("script-action"));
        }
        target.clone()
    } else if session["target"].is_null() {
        Value::Null
    } else {
        json!({"targetId":session["target"]["id"],"targetGeneration":session["target"]["generation"]})
    };
    let policy = HostAction {
        operation: Some(operation),
        target: target.clone(),
    };
    if !matches!(name, "targets" | "attach") && session.is_null() {
        return Ok((policy, Value::Null));
    }
    if from_session && target.is_null() {
        return Ok((policy, Value::Null));
    }
    // Opening and reattaching use the same native operation, with the existing
    // attachment reused when the actor still owns it on this helper.
    let mut command =
        json!({"operation": if name == "attach" { "session.open" } else { operation }});
    if !matches!(name, "attach" | "targets") {
        command["sessionId"] = session["binding"]["sessionId"].clone();
    }
    if from_session || name == "attach" {
        command["targetId"] = target["targetId"].clone();
        command["targetGeneration"] = target["targetGeneration"].clone();
    }
    for field in fields.iter().copied().filter(|field| *field != "target") {
        if let Some(value) = action.get(field) {
            command[if field == "point" { "position" } else { field }] = value.clone();
        }
    }
    if operation == "input.click" {
        command["globalInput"] = json!(name == "globalClick");
        match name {
            "globalClick" if command.get("position").is_none() => {
                return Err(HostError::new("script-action"));
            }
            "processClick" => command["delivery"] = json!("process"),
            "backgroundClick" => command["delivery"] = json!("background"),
            _ => {}
        }
    }
    let command = checked("computerUseNativePreviewActionSchema", &command)
        .map_err(|_| HostError::new("script-action"))?;
    Ok((policy, command))
}

fn ensure_shape(action: &Value, fields: &[&str]) -> Result<(), HostError> {
    if action.as_object().is_some_and(|keys| {
        keys.keys().all(|key| {
            key.as_str()
                .is_some_and(|name| name == "operation" || fields.contains(&name))
        })
    }) {
        Ok(())
    } else {
        Err(HostError::new("script-action"))
    }
}
