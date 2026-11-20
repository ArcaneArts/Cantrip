use super::{Lease, Request, input, retire};
use crate::desktop_inventory::{DEADLINE, Helper, helper, process::NativeError};
use crate::http::checked;
use anyhow::{Result, ensure};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{Value, value::json};
use image::{ImageDecoder, codecs::png::PngDecoder};
use std::{io::Cursor, path::Path};
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

pub(super) fn require_host(lease: &Lease, action: &Value) -> Result<()> {
    if action["operation"] != "session.close" && !lease.authority["osPlacement"].is_null() {
        return Err(reject(
            "unavailable",
            "This preview requires its Cantrip OS desktop.",
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub(super) struct Session {
    helper: uuid::Uuid,
    data: Value,
}

pub(super) fn activity_session(lease: &Lease, session_id: Option<&Value>) -> Value {
    lease
        .session
        .lock()
        .unwrap()
        .as_ref()
        .filter(|session| {
            session_id.is_none_or(|requested| session.data["binding"]["sessionId"] == *requested)
        })
        .map_or(Value::Null, |session| session.data.clone())
}

pub(super) struct ResultData {
    pub(super) data: Value,
    pub(super) pixels: Zeroizing<Vec<u8>>,
}

pub(in crate::desktop_inventory) async fn run(
    request: Request,
    process: &mut Option<Helper>,
    binary: &Path,
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
    let mutating_input = matches!(
        request.action["operation"].as_str(),
        Some(
            "input.press" | "input.click" | "input.perform" | "clipboard.write" | "desktop.resize"
        )
    );
    let work = execute(process, binary, &request.lease, request.action);
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
        Ok(Ok(_)) if request.lease.signal.check().is_err() => Err(cancelled(uncertain)),
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

pub(in crate::desktop_inventory) async fn release(lease: &Lease, process: &mut Option<Helper>) {
    let Some(session) = lease.session.lock().unwrap().take() else {
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
    binary: &Path,
    lease: &Lease,
    mut action: Value,
) -> Result<ResultData> {
    if lease.signal.check().is_err() {
        return Err(cancelled("not-sent"));
    }
    let method = action["operation"].as_str().unwrap().to_owned();
    let opening = method == "session.open";
    if process.as_mut().is_some_and(|child| child.process.exited()) {
        retire(process).await;
    }
    let mut session = lease.session.lock().unwrap().clone().filter(|session| {
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
    let child = timeout(DEADLINE, helper(process, binary)).await??;
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
    if lease.signal.check().is_err() {
        return Err(cancelled("not-sent"));
    }
    let binding = if opening {
        action["operation"] = json!("target.attach");
        session.as_ref().map_or_else(
            || json!({
                "sessionId":uuid::Uuid::new_v4().to_string(),"workerId":lease.authority["workerId"],
                "chatId":lease.authority["chatId"],"taskId":Value::Null,"threadId":Value::Null,"turnId":Value::Null,
            }),
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
        action["allowCantripApp"] = json!(true);
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
    let (mut result, pixels) = child
        .process
        .cancellable(action, method == "observation.snapshot", async {
            let _ = lease.signal.cancelled().await;
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
        *lease.session.lock().unwrap() = None;
    } else if method != "targets.list" {
        if let Some(expected) = input {
            result = checked("cuaInputResultSchema", &result)?;
            expected.validate(&result["input"])?;
        } else if method == "clipboard.read" {
            result = checked("cuaClipboardResultSchema", &result)?;
        }
        let session = checked("cuaSessionSchema", &result["session"])?;
        ensure!(
            session["binding"] == binding
                && (target.0.is_null()
                    || (session["target"]["id"] == target.0
                        && session["target"]["generation"] == target.1)),
            "The native helper returned another session or target."
        );
        *lease.session.lock().unwrap() = Some(Session {
            helper: child.identity,
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
    if lease.signal.check().is_err() {
        return Err(cancelled("unknown"));
    }
    Ok(ResultData {
        data: result,
        pixels,
    })
}
