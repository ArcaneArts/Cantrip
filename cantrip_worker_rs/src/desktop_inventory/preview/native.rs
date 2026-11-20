use super::{Lease, Request, input, retire};
use crate::desktop_inventory::{DEADLINE, Helper, helper, process::NativeError};
use crate::http::checked;
use crate::metadata::Signal;
use anyhow::{Result, ensure};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{Value, value::json};
use image::{ImageDecoder, codecs::png::PngDecoder};
use sha2::{Digest, Sha256};
use std::{io::Cursor, path::Path, sync::Mutex};
use tokio::time::{Instant, timeout, timeout_at};

#[derive(Debug)]
pub(super) struct Rejected {
    pub(super) code: String,
    pub(super) message: &'static str,
    pub(super) outcome: &'static str,
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Rejected {}

pub(super) fn reject(code: &str, message: &'static str) -> anyhow::Error {
    rejection(code, message, "rejected")
}

pub(super) fn cancelled(outcome: &'static str) -> anyhow::Error {
    rejection(
        "cancelled",
        "Computer-use preview authority expired.",
        outcome,
    )
}

fn rejection(code: &str, message: &'static str, outcome: &'static str) -> anyhow::Error {
    Rejected {
        code: code.into(),
        message,
        outcome,
    }
    .into()
}

#[derive(Clone)]
struct Session {
    helper: uuid::Uuid,
    lifetime: Signal,
    data: Value,
}

/// Fixed worker ownership and the native session on the current helper.
pub(in crate::desktop_inventory) struct Attachment {
    scope: Value,
    session: Mutex<Option<Session>>,
}

impl Attachment {
    pub(super) fn new(authority: &Value, turn: Option<&Value>) -> Self {
        let missing_turn = Value::Null;
        let turn = turn.unwrap_or(&missing_turn);
        Self {
            scope: json!({
                "workerId":authority["workerId"],"chatId":authority["chatId"],
                "taskId":turn["taskId"],"threadId":turn["threadId"],"turnId":turn["turnId"],
            }),
            session: Mutex::default(),
        }
    }

    fn new_binding(&self) -> Value {
        let mut binding = self.scope.clone();
        binding["sessionId"] = json!(uuid::Uuid::new_v4().to_string());
        binding
    }

    pub(super) fn data(&self, session_id: Option<&Value>) -> Value {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .filter(|session| {
                session_id
                    .is_none_or(|requested| session.data["binding"]["sessionId"] == *requested)
            })
            .map_or(Value::Null, |session| session.data.clone())
    }

    pub(super) fn observation_signal(&self, captured: &Value) -> Option<Signal> {
        let session = self.session.lock().unwrap();
        let current = session.as_ref()?;
        let latest = &current.data;
        (current.lifetime.check().is_ok()
            && !captured["target"].is_null()
            && ["binding", "observationRevision"]
                .into_iter()
                .all(|field| latest[field] == captured[field])
            && ["id", "generation"]
                .into_iter()
                .all(|field| latest["target"][field] == captured["target"][field])
            && latest["cursor"]["revision"] == captured["cursor"]["revision"])
            .then(|| current.lifetime.clone())
    }

    pub(super) fn matches_observation(&self, captured: &Value) -> bool {
        self.observation_signal(captured).is_some()
    }
}

pub(super) fn activity_session(lease: &Lease, session_id: Option<&Value>) -> Value {
    lease.attachment.data(session_id)
}

pub(super) struct ResultData {
    pub(super) data: Value,
    pub(super) pixels: Zeroizing<Vec<u8>>,
}

pub(super) fn mutates_desktop(action: &Value) -> bool {
    matches!(
        action["operation"].as_str(),
        Some(
            "input.press" | "input.click" | "input.perform" | "clipboard.write" | "desktop.resize"
        )
    )
}

pub(in crate::desktop_inventory) async fn run(
    request: Request,
    process: &mut Option<Helper>,
    binary: Option<&Path>,
) {
    if request
        .deadline
        .is_some_and(|deadline| Instant::now() >= deadline)
    {
        let _ = request.reply.send(Err(rejection(
            "timeout",
            "The native computer-use operation timed out.",
            "not-sent",
        )));
        return;
    }
    let mutating_input = mutates_desktop(&request.action);
    let work = execute(
        process,
        binary,
        &request.attachment,
        &request.signal,
        request.allow_cantrip_app,
        request.action,
    );
    let completed = match request.deadline {
        Some(deadline) => timeout_at(deadline, work).await,
        None => Ok(work.await),
    };
    let uncertain = if mutating_input {
        "unknown"
    } else {
        "rejected"
    };
    let result = match completed {
        Ok(Ok(_)) if request.signal.check().is_err() => Err(cancelled(uncertain)),
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) if error.is::<Rejected>() => Err(error),
        Ok(Err(error)) if error.is::<NativeError>() => {
            let error = error.downcast::<NativeError>().unwrap();
            if error.code() == "input-unknown" {
                Err(rejection(
                    "input-unknown",
                    "Input outcome is unknown. Do not retry or fall back; take a fresh snapshot to inspect the result.",
                    "unknown",
                ))
            } else {
                Err(reject(
                    error.code(),
                    "The native helper rejected the computer-use operation.",
                ))
            }
        }
        Ok(Err(_)) => {
            retire(process).await;
            Err(rejection(
                "protocol-error",
                "The native desktop helper could not confirm the operation.",
                uncertain,
            ))
        }
        Err(_) => {
            retire(process).await;
            Err(rejection(
                "timeout",
                "The native computer-use operation timed out.",
                uncertain,
            ))
        }
    };
    let _ = request.reply.send(result);
}

pub(in crate::desktop_inventory) async fn release(
    attachment: &Attachment,
    process: &mut Option<Helper>,
) {
    let Some(session) = attachment.session.lock().unwrap().take() else {
        return;
    };
    let Some(child) = process
        .as_mut()
        .filter(|child| child.identity == session.helper)
    else {
        return;
    };
    let result = timeout(
        DEADLINE,
        child.process.request(json!({
            "operation":"session.close","binding":session.data["binding"],
        })),
    )
    .await;
    if !matches!(result, Ok(Ok(_)))
        && !matches!(result, Ok(Err(ref error)) if error.is::<NativeError>())
    {
        retire(process).await;
    }
}

async fn execute(
    process: &mut Option<Helper>,
    binary: Option<&Path>,
    attachment: &Attachment,
    signal: &Signal,
    allow_cantrip_app: bool,
    mut action: Value,
) -> Result<ResultData> {
    if signal.check().is_err() {
        return Err(cancelled("not-sent"));
    }
    let method = action["operation"].as_str().unwrap().to_owned();
    let opening = method == "session.open";
    if process.as_mut().is_some_and(|child| child.process.exited()) {
        retire(process).await;
    }
    let mut session = attachment
        .session
        .lock()
        .unwrap()
        .clone()
        .filter(|session| {
            process
                .as_ref()
                .is_some_and(|child| child.identity == session.helper)
        });
    if !opening && !matches!(method.as_str(), "capabilities.get" | "targets.list") {
        let Some(current) = &session else {
            return Err(reject(
                "session-not-found",
                "The computer-use session is unavailable.",
            ));
        };
        if current.data["binding"]["sessionId"] != action["sessionId"] {
            return Err(reject(
                "session-not-found",
                "The computer-use session is unavailable.",
            ));
        }
        if method == "session.state" {
            return Ok(ResultData {
                data: json!({"session":current.data}),
                pixels: Zeroizing::new(Vec::new()),
            });
        }
    }
    let child = match binary {
        Some(binary) => timeout(DEADLINE, helper(process, binary)).await??,
        None => process.as_mut().ok_or_else(|| {
            reject(
                "unavailable",
                "The captured Cantrip OS desktop is no longer available.",
            )
        })?,
    };
    if session
        .as_ref()
        .is_some_and(|session| session.helper != child.identity)
    {
        session = None;
        if !opening {
            return Err(reject(
                "session-not-found",
                "The computer-use session is unavailable.",
            ));
        }
    }
    if signal.check().is_err() {
        return Err(cancelled("not-sent"));
    }
    let binding = if opening {
        action["operation"] = json!("target.attach");
        session.as_ref().map_or_else(
            || attachment.new_binding(),
            |session| session.data["binding"].clone(),
        )
    } else {
        session
            .as_ref()
            .map_or(Value::Null, |session| session.data["binding"].clone())
    };
    if !matches!(method.as_str(), "capabilities.get" | "targets.list") {
        if let Value::Object(fields) = &mut action {
            fields.shift_remove("sessionId");
        }
        action["binding"] = binding.clone();
    }
    if opening || matches!(method.as_str(), "targets.list" | "target.attach") {
        action["allowCantripApp"] = json!(allow_cantrip_app);
    }
    let target = (
        action["targetId"].clone(),
        action["targetGeneration"].clone(),
    );
    let no_session = Value::Null;
    let before = session
        .as_ref()
        .map_or(&no_session, |session| &session.data);
    if method != "target.attach"
        && !opening
        && !target.0.is_null()
        && (before["target"]["id"] != target.0 || before["target"]["generation"] != target.1)
    {
        return Err(reject(
            "stale-target",
            "The selected computer-use target changed.",
        ));
    }
    if method == "input.click" && action.get("globalInput").is_none() {
        action["globalInput"] = json!(false);
    }
    let input = input::Expected::new(&action, before, child.process.backend());
    let after = action.get("after").and_then(Value::as_js_string).cloned();
    let (mut result, pixels) = child
        .process
        .cancellable(action, method == "observation.snapshot", async {
            let _ = signal.cancelled().await;
        })
        .await?;
    let pixels = Zeroizing::new(pixels);
    if method == "capabilities.get" {
        if let Value::Array(operations) = &mut result["operations"] {
            operations.retain(|name| {
                matches!(
                    name.as_str(),
                    Some(
                        "capabilities.get"
                            | "targets.list"
                            | "target.attach"
                            | "target.detach"
                            | "session.close"
                            | "cursor.configure"
                            | "cursor.move"
                            | "controls.inspect"
                            | "observation.snapshot"
                            | "input.press"
                            | "input.click"
                            | "input.perform"
                            | "clipboard.read"
                            | "clipboard.write"
                            | "desktop.resize"
                    )
                )
            });
        }
        result["javascript"] = json!(false);
    } else if method == "session.close" {
        ensure!(
            result["closed"] == true,
            "The native helper did not confirm the session close."
        );
        *attachment.session.lock().unwrap() = None;
    } else if method == "targets.list" {
        result = checked("cuaInventorySchema", &result)?;
        if let Some(after) = &after {
            ensure!(
                result["targets"].as_array().unwrap().iter().all(|target| {
                    target["id"]
                        .as_js_string()
                        .is_some_and(|id| id.units() > after.units())
                }),
                "The native inventory did not advance its cursor."
            );
        }
    } else {
        if let Some(expected) = input {
            result = checked("cuaInputResultSchema", &result)?;
            expected.validate(&result["input"])?;
        } else if method == "clipboard.read" {
            result = checked("cuaClipboardResultSchema", &result)?;
        } else if method == "controls.inspect" {
            result = checked("cuaControlsResultSchema", &result)?;
        } else if method == "observation.snapshot" {
            result = checked("cuaSnapshotSchema", &result)?;
            let digest = Sha256::digest(&*pixels);
            let digest: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            ensure!(
                result["image"]["byteCount"].as_u64() == Some(pixels.len() as u64)
                    && result["image"]["sha256"] == digest,
                "The native computer-use image did not match its metadata."
            );
        }
        let session = checked("cuaSessionSchema", &result["session"])?;
        ensure!(
            session["binding"] == binding
                && (target.0.is_null()
                    || (session["target"]["id"] == target.0
                        && session["target"]["generation"] == target.1)),
            "The native helper returned another session or target."
        );
        *attachment.session.lock().unwrap() = Some(Session {
            helper: child.identity,
            lifetime: child.lifetime.1.clone(),
            data: session,
        });
    }
    if !pixels.is_empty() {
        let image = PngDecoder::new(Cursor::new(&*pixels))?;
        let (width, height) = image.dimensions();
        ensure!(
            result["image"]["width"].as_u64() == Some(width.into())
                && result["image"]["height"].as_u64() == Some(height.into()),
            "The native desktop capture dimensions changed."
        );
    }
    // The retirement queue still needs a newly allocated binding to close it.
    // Its cached handle cannot authorize a revoked preview or expose the result.
    if signal.check().is_err() {
        return Err(cancelled("unknown"));
    }
    Ok(ResultData {
        data: result,
        pixels,
    })
}
