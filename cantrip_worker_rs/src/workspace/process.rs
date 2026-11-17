//! Owned bounded read-only Git/gh children. Dropping an HTTP response never
//! cancels an accepted operation; only its runtime stop receiver does.
use anyhow::{Result, anyhow};
use std::{
    ffi::{OsStr, OsString},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::watch,
};
#[derive(Debug)]
pub struct ProcessError {
    pub missing: bool,
    pub exit: Option<i32>,
    pub reason: &'static str,
}
impl std::fmt::Display for ProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for ProcessError {}
#[derive(Clone, Default)]
pub struct Scope {
    stop: Option<watch::Receiver<bool>>,
}
impl Scope {
    pub fn with_stop(stop: watch::Receiver<bool>) -> Self {
        Self { stop: Some(stop) }
    }
    pub fn check(&self) -> Result<()> {
        if self
            .stop
            .as_ref()
            .is_some_and(|stop| *stop.borrow() || stop.has_changed().is_err())
        {
            return Err(anyhow!("Worker workspace operation stopped."));
        }
        Ok(())
    }
    async fn stopped(&self) {
        let Some(mut stop) = self.stop.clone() else {
            std::future::pending::<()>().await;
            return;
        };
        loop {
            if *stop.borrow() {
                return;
            }
            if stop.changed().await.is_err() {
                return;
            }
        }
    }
    pub async fn run(
        &self,
        program: &OsStr,
        args: &[OsString],
        maximum: usize,
        timeout_ms: u64,
    ) -> Result<String> {
        self.check()?;
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| ProcessError {
            missing: error.kind() == std::io::ErrorKind::NotFound,
            exit: None,
            reason: "Workspace subprocess could not be started.",
        })?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.max(1));
        let output = tokio::select! {
            biased;
            _=self.stopped()=>Err(anyhow!("Worker workspace operation stopped.")),
            _=tokio::time::sleep_until(deadline)=>Err(anyhow!(ProcessError{missing:false,exit:None,reason:"Workspace subprocess timed out."})),
            result=async{tokio::try_join!(bounded(stdout,maximum),bounded(stderr,maximum))}=>result,
        };
        let result = match output {
            Ok((stdout, _stderr)) => {
                let waited = tokio::select! {
                    biased;
                    _=self.stopped()=>Err(anyhow!("Worker workspace operation stopped.")),
                    _=tokio::time::sleep_until(deadline)=>Err(anyhow!(ProcessError{missing:false,exit:None,reason:"Workspace subprocess timed out."})),
                    result=child.wait()=>result.map_err(anyhow::Error::from),
                };
                match waited {
                    Ok(status) if status.success() => {
                        Ok(String::from_utf8_lossy(&stdout).into_owned())
                    }
                    Ok(status) => Err(anyhow!(ProcessError {
                        missing: false,
                        exit: status.code(),
                        reason: "Workspace subprocess failed."
                    })),
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        };
        if result.is_err() && child.id().is_some() {
            #[cfg(unix)]
            {
                let _ = cantrip_host::process::signal_owned(
                    &child,
                    libc::SIGKILL,
                    true,
                    "Owned workspace child",
                );
            }
            #[cfg(windows)]
            {
                let _ = child.start_kill();
            }
            let _ = child.wait().await;
        }
        result
    }
}
async fn bounded(mut reader: impl AsyncRead + Unpin, maximum: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(bytes);
        }
        if count > maximum.saturating_sub(bytes.len()) {
            return Err(anyhow!(ProcessError {
                missing: false,
                exit: None,
                reason: "Workspace subprocess output exceeded its limit."
            }));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}
