use super::{Lease, Request, retire};
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
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Rejected {}

pub(super) fn reject(code: &str, message: &'static str) -> anyhow::Error {
    Rejected {
        code: code.into(),
        message,
    }
    .into()
}

pub(super) fn authorize(lease: &Lease, operation: &str) -> Result<()> {
    match operation {
        "session.close" => return Ok(()),
        "capabilities.get" => {}
        "targets.list"
        | "session.open"
        | "session.state"
        | "target.attach"
        | "target.detach"
        | "observation.snapshot"
        | "cursor.configure"
        | "cursor.move"
        | "controls.inspect" => {
            if lease.authority["profile"]["selectedId"] != ":yolo" {
                return Err(reject(
                    "approval-required",
                    "Computer use requires approval through the active permission profile.",
                ));
            }
        }
        _ => {
            return Err(reject(
                "unavailable",
                "This computer-use preview operation is unavailable.",
            ));
        }
    }
    if !lease.authority["osPlacement"].is_null() {
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

pub(super) struct ResultData {
    pub(super) data: Value,
    pub(super) pixels: Zeroizing<Vec<u8>>,
}

pub(in crate::desktop_inventory) async fn run(
    request: Request,
    process: &mut Option<Helper>,
    binary: &Path,
) {
    if Instant::now() >= request.deadline {
        let _ = request.reply.send(Err(reject(
            "timeout",
            "The native computer-use operation timed out.",
        )));
        return;
    }
    let result = match timeout_at(
        request.deadline,
        execute(process, binary, &request.lease, request.action),
    )
    .await
    {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) if error.is::<Rejected>() => Err(error),
        Ok(Err(error)) if error.is::<NativeError>() => {
            let error = error.downcast::<NativeError>().unwrap();
            Err(reject(
                error.code(),
                "The native helper rejected the computer-use operation.",
            ))
        }
        Ok(Err(_)) => {
            retire(process).await;
            Err(reject(
                "protocol-error",
                "The native desktop helper could not confirm the operation.",
            ))
        }
        Err(_) => {
            retire(process).await;
            Err(reject(
                "timeout",
                "The native computer-use operation timed out.",
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
        return Err(reject(
            "cancelled",
            "Computer-use preview authority expired.",
        ));
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
    let child = helper(process, binary).await?;
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
        return Err(reject(
            "cancelled",
            "Computer-use preview authority expired.",
        ));
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
                    )
                )
            });
        }
        result["nativeInput"] = json!(false);
        result["javascript"] = json!(false);
    } else if method == "session.close" {
        ensure!(
            result["closed"] == true,
            "The native helper did not confirm the session close."
        );
        *lease.session.lock().unwrap() = None;
    } else if method != "targets.list" {
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
    Ok(ResultData {
        data: result,
        pixels,
    })
}
