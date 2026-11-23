//! Root recovery carrier. A network loss never retries a guest mutation.
use crate::{
    cantrip_os::carrier::{DeliveryUnknown, Program, Transport},
    filesystem::Scope,
};
use anyhow::{Result, ensure};
use cantrip_wire::{Value, parse_json_text};
use std::{fs::File, process::Stdio};
use tokio::{
    io::AsyncReadExt,
    process::{ChildStdout, Command},
};

pub(super) async fn control(
    transport: &Transport,
    arguments: &[&str],
    scope: &Scope,
    input: Option<File>,
) -> Result<Value> {
    let (program, args) = transport.spec(Program::Recovery, arguments);
    let result = scope
        .capture_file(program, &args, 32 * 1024 * 1024, input)
        .await
        .map_err(|error| DeliveryUnknown(format!("Recovery carrier failed: {error}")))?;
    if result.code != Some(0) || result.overflow.is_some() {
        let stderr = &result.stderr[result.stderr.len().saturating_sub(4096)..];
        return Err(DeliveryUnknown(format!(
            "Recovery carrier did not return a complete receipt: {}",
            String::from_utf8_lossy(stderr)
        ))
        .into());
    }
    let value = parse_json_text(&String::from_utf8_lossy(&result.stdout))
        .map_err(|_| DeliveryUnknown("Recovery carrier returned an unreadable receipt.".into()))?;
    let valid_version = if value["action"] == "reset" {
        value["version"] == 2
            && matches!(
                value["state"].as_str(),
                Some("admitted" | "restoring" | "reset" | "failed" | "unknown")
            )
    } else {
        value["version"] == 1
            && matches!(
                value["action"].as_str(),
                Some("capture" | "restore" | "rollback")
            )
            && matches!(
                value["state"].as_str(),
                Some(
                    "admitted"
                        | "capturing"
                        | "captured"
                        | "receiving"
                        | "received"
                        | "restoring"
                        | "restored"
                        | "rolled-back"
                        | "failed"
                        | "forgotten"
                        | "unknown"
                )
            )
    };
    ensure!(
        valid_version
            && value["operation_id"].as_str().is_some()
            && value["active"].as_bool().is_some()
            && (value["error"].is_null() || value["error"].is_string())
            && (value["receipt"].is_null() || value["receipt"].is_object())
            && (value["maintenance"].is_null() || value["maintenance"].is_object()),
        "Invalid guest recovery receipt."
    );
    Ok(value)
}

/// Stream the archive to its consumer, then require the real export exit
/// receipt. A rejected consumer cancels and reaps the owned carrier.
pub(super) async fn export<T>(
    transport: &Transport,
    args: &[&str],
    scope: &Scope,
    consume: impl AsyncFnOnce(&mut ChildStdout) -> Result<T>,
) -> Result<T> {
    scope.check()?;
    let (program, args) = transport.spec(Program::Recovery, args);
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| DeliveryUnknown(format!("Recovery exporter failed: {error}")))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let result = tokio::select! {
        biased;
        _ = scope.stopped() => Err(DeliveryUnknown("Worker stopped while receiving the archive.".into()).into()),
        result = async {
            let (value, tail) = tokio::try_join!(consume(&mut stdout), async {
                let mut tail = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = stderr.read(&mut buffer).await?;
                    if count == 0 {
                        return Ok::<_, anyhow::Error>(tail);
                    }
                    tail.extend_from_slice(&buffer[..count]);
                    if tail.len() > 4096 {
                        tail.drain(..tail.len() - 4096);
                    }
                }
            })?;
            let status = child.wait().await?;
            if !status.success() {
                return Err(DeliveryUnknown(format!("Recovery exporter ended {status}: {}",
                    String::from_utf8_lossy(&tail))).into());
            }
            Ok(value)
        } => result,
    };
    if result.is_err() && child.id().is_some() {
        #[cfg(unix)]
        let _ =
            cantrip_host::process::signal_owned(&child, libc::SIGKILL, true, "Recovery exporter");
        #[cfg(windows)]
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    result
}
