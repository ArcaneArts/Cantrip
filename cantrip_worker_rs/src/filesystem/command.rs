//! Owned read-only Git/gh children, with bounded buffered output or incremental
//! history records. Dropping an HTTP response never cancels an accepted
//! operation; only its runtime stop receiver does.
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
    /// Stream delimited read-only Git output without buffering the repository's
    /// entire history. `consume` may stop the owned child after enough records;
    /// that successful early stop still drains pipes and reaps the process.
    pub async fn records(
        &self,
        program: &OsStr,
        args: &[OsString],
        delimiter: u8,
        final_record: bool,
        mut consume: impl FnMut(&[u8]) -> bool,
    ) -> Result<()> {
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
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut buffer = Vec::new();
        let mut errors = Vec::new();
        let mut out_chunk = [0; 8192];
        let mut err_chunk = [0; 8192];
        let mut early = false;
        let mut out_open = true;
        let mut err_open = true;
        let result = async {
            while out_open || err_open {
                tokio::select! {
                    biased;
                    _=self.stopped()=>return Err(anyhow!("Worker workspace operation stopped.")),
                    read=stdout.read(&mut out_chunk),if out_open=>{
                        let count = read?;
                        if count == 0 {
                            out_open = false;
                            if final_record && !early { early = consume(&buffer); }
                            buffer.clear();
                        } else if !early {
                            buffer.extend_from_slice(&out_chunk[..count]);
                            let mut start = 0;
                            for end in 0..buffer.len() {
                                if buffer[end] == delimiter {
                                    if consume(&buffer[start..end]) { early = true; break; }
                                    start = end + 1;
                                }
                            }
                            if early {buffer.clear();}else{buffer.drain(..start);}
                            if early {
                                #[cfg(unix)]
                                let _ = cantrip_host::process::signal_owned(&child,libc::SIGTERM,false,"Owned Explorer Git child");
                                #[cfg(windows)]
                                let _ = child.start_kill();
                            }
                        }
                    },
                    read=stderr.read(&mut err_chunk),if err_open=>{
                        let count = read?;
                        err_open = count != 0;
                        errors.extend_from_slice(&err_chunk[..count]);
                        if errors.len() > 64 * 1024 {errors.drain(..errors.len()-64*1024);}
                    },
                }
            }
            let status = tokio::select! {
                biased;
                _=self.stopped()=>return Err(anyhow!("Worker workspace operation stopped.")),
                status=child.wait()=>status?,
            };
            if status.success() || early {Ok(())}else{Err(anyhow!("{}",String::from_utf8_lossy(&errors).trim()))}
        }.await;
        if result.is_err() && child.id().is_some() {
            #[cfg(unix)]
            let _ = cantrip_host::process::signal_owned(
                &child,
                libc::SIGKILL,
                true,
                "Owned Explorer Git child",
            );
            #[cfg(windows)]
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        result
    }
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
        self.run_with_timeout(program, args, maximum, Some(timeout_ms))
            .await
    }
    /// A missing timeout preserves the current gh API behavior. Output remains
    /// bounded, and the child still belongs to its runtime's stop/join lifetime.
    pub async fn run_with_timeout(
        &self,
        program: &OsStr,
        args: &[OsString],
        maximum: usize,
        timeout_ms: Option<u64>,
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
        let deadline =
            timeout_ms.map(|ms| tokio::time::Instant::now() + Duration::from_millis(ms.max(1)));
        let output = tokio::select! {
            biased;
            _=self.stopped()=>Err(anyhow!("Worker workspace operation stopped.")),
            _=expired(deadline)=>Err(anyhow!(ProcessError{missing:false,exit:None,reason:"Workspace subprocess timed out."})),
            result=async{tokio::try_join!(bounded(stdout,maximum),bounded(stderr,maximum))}=>result,
        };
        let result = match output {
            Ok((stdout, _stderr)) => {
                let waited = tokio::select! {
                    biased;
                    _=self.stopped()=>Err(anyhow!("Worker workspace operation stopped.")),
                    _=expired(deadline)=>Err(anyhow!(ProcessError{missing:false,exit:None,reason:"Workspace subprocess timed out."})),
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
async fn expired(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn streamed_git_children_stop_and_join_on_completion_or_runtime_stop() {
        let args = ["-c".into(), "printf 'ready\\000'; exec sleep 30".into()];
        let (stop, receiver) = watch::channel(false);
        let scope = Scope::with_stop(receiver);
        let mut observed = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            scope.records(OsStr::new("sh"), &args, 0, false, |record| {
                observed.push(record.to_vec());
                true
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(observed, vec![b"ready".to_vec()]);
        let stopped = tokio::time::timeout(
            Duration::from_secs(5),
            scope.records(OsStr::new("sh"), &args, 0, false, |_| {
                stop.send(true).unwrap();
                false
            }),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(stopped.to_string(), "Worker workspace operation stopped.");
    }
}
