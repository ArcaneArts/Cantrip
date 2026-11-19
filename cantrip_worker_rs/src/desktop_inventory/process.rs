//! Private pipe to the worker-owned cantrip-cua executable.
use anyhow::{Context, Result, bail, ensure};
use cantrip_interaction::geometry::MAX_SEQUENCE;
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

const VERSION: i32 = 1;
const MAX_HEADER: usize = 16 * 1024 * 1024;
const SHUTDOWN: Duration = Duration::from_secs(2);

pub(super) struct Process {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    sequence: u64,
}

#[derive(Debug)]
pub(super) struct NativeError(&'static str);

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for NativeError {}

impl Process {
    pub(super) fn spawn(binary: &Path, args: &[&str]) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Native diagnostics can contain protected target details.
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .context("Could not start the Cantrip capture helper.")?;
        let input = child
            .stdin
            .take()
            .context("Capture helper input is unavailable.")?;
        let output = child
            .stdout
            .take()
            .context("Capture helper output is unavailable.")?;
        Ok(Self {
            child,
            input,
            output,
            sequence: 0,
        })
    }

    pub(super) fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub(super) async fn initialize(&mut self) -> Result<()> {
        let data = self
            .request(json!({"operation":"capabilities.get"}))
            .await?;
        ensure!(
            data["protocolVersion"] == VERSION
                && data["operations"]
                    .as_array()
                    .is_some_and(|ops| ops.iter().any(|op| op == "targets.list")),
            "Unsupported Cantrip capture helper protocol."
        );
        Ok(())
    }

    pub(super) async fn request(&mut self, operation: Value) -> Result<Value> {
        let sequence = self.sequence + 1;
        ensure!(
            sequence <= MAX_SEQUENCE,
            "Capture helper request IDs exhausted."
        );
        self.sequence = sequence;
        let header = json!({
            "version":VERSION,
            "message":json!({"kind":"request", "requestId":sequence, "operation":operation})
        })
        .stringify();
        ensure!(
            header.len() <= MAX_HEADER,
            "Capture helper request is too large."
        );
        self.input.write_u32(header.len() as u32).await?;
        self.input.write_u32(0).await?;
        self.input.write_all(header.as_bytes()).await?;
        self.input.flush().await?;

        let size = self
            .output
            .read_u32()
            .await
            .context("Capture helper stopped before replying.")? as usize;
        let payload = self.output.read_u32().await?;
        ensure!(
            size > 0 && size <= MAX_HEADER && payload == 0,
            "Invalid capture helper inventory frame."
        );
        let mut bytes = vec![0; size];
        self.output.read_exact(&mut bytes).await?;
        let frame = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| parse_json_text(text).ok())
            .context("Invalid capture helper response encoding.")?;
        let message = &frame["message"];
        ensure!(
            frame.as_object().is_some_and(|fields| fields.len() == 2)
                && frame["version"] == VERSION
                && message.as_object().is_some_and(|fields| fields.len() == 3)
                && message["kind"] == "response"
                && message["requestId"].as_u64() == Some(sequence),
            "Invalid capture helper response correlation."
        );
        let result = &message["result"];
        ensure!(
            result.as_object().is_some_and(|fields| fields.len() == 2),
            "Invalid capture helper response outcome."
        );
        match result["status"].as_str() {
            Some("ok") => result
                .get("data")
                .cloned()
                .context("Capture helper response is missing data."),
            Some("error") => {
                let error = &result["error"];
                ensure!(
                    error.as_object().is_some_and(|fields| fields.len() == 2)
                        && error["message"].as_js_string().is_some(),
                    "Invalid capture helper error."
                );
                let message = match error["code"].as_str() {
                    Some("permission-denied") => {
                        "The OS denied access to desktop target discovery."
                    }
                    Some("unsupported") => "Managed desktop target discovery is unavailable.",
                    Some("capture-inventory-timeout") => "Desktop target discovery timed out.",
                    Some("capture-failed") => "Desktop target discovery failed.",
                    Some("cancelled") => "Desktop target discovery was cancelled.",
                    _ => bail!("Unexpected capture helper inventory error."),
                };
                Err(NativeError(message).into())
            }
            _ => bail!("Invalid capture helper response status."),
        }
    }

    pub(super) async fn close(self) {
        let Self {
            mut child,
            input,
            output,
            ..
        } = self;
        drop(input);
        drop(output);
        if timeout(SHUTDOWN, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}
