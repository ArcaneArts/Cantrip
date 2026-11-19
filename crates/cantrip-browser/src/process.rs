use super::Launch;
use anyhow::{Context, Result, anyhow, ensure};
use std::{ffi::OsString, io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::oneshot,
    task::{JoinHandle, JoinSet},
};
use url::Url;

const EXIT_GRACE: Duration = Duration::from_secs(2);
const ENDPOINT_LINE: &str = "DevTools listening on ";
const STDERR_WINDOW: usize = 16 * 1024;

pub(super) struct Process {
    stop: oneshot::Sender<()>,
    wait: JoinHandle<Result<Exit>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Exit {
    Exited,
    Terminated,
    Forced,
}

impl Process {
    pub fn launch(options: Launch<'_>) -> Result<(Self, oneshot::Receiver<Result<Url>>)> {
        let mut user_data = OsString::from("--user-data-dir=");
        user_data.push(options.profile);
        let mut command = Command::new(options.executable);
        command
            .args([
                "--headless=new",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-sync",
                "--disable-features=Translate",
            ])
            .arg(user_data)
            .arg(format!(
                "--window-size={},{}",
                options.viewport.0, options.viewport.1
            ))
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(environment) = options.environment {
            command
                .env_clear()
                .envs(environment.iter().map(|(key, value)| (key, value)));
        }
        let mut process = ChildTree::spawn(&mut command).context("Could not launch Chromium.")?;
        let stderr = process
            .child
            .stderr
            .take()
            .context("Chromium stderr is unavailable.")?;
        let (ready, endpoint) = oneshot::channel();
        let (stop, stopped) = oneshot::channel();
        let wait = tokio::spawn(async move {
            let mut monitor = JoinSet::new();
            monitor.spawn(report_endpoint(stderr, ready));
            let outcome = tokio::select! {
                status = process.child.wait() => {
                    let status = status?;
                    ensure!(status.success(), "Chromium exited with {status}.");
                    Ok(Exit::Exited)
                }
                _ = stopped => {
                    process.shutdown().await
                }
            };
            monitor.shutdown().await;
            outcome
        });
        Ok((Self { stop, wait }, endpoint))
    }

    pub async fn stop(self) -> Result<Exit> {
        let _ = self.stop.send(());
        self.wait.await?
    }
}

struct ChildTree {
    child: Child,
    #[cfg(windows)]
    job: Option<codex_utils_pty::JobObject>,
}

impl ChildTree {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        {
            command.process_group(0);
            Ok(Self {
                child: command.spawn()?,
            })
        }
        #[cfg(windows)]
        {
            let (child, job) = codex_utils_pty::JobObject::spawn_background(command)?;
            Ok(Self { child, job })
        }
    }

    async fn shutdown(&mut self) -> Result<Exit> {
        if let Ok(status) = tokio::time::timeout(EXIT_GRACE, self.child.wait()).await {
            let status = status?;
            ensure!(status.success(), "Chromium exited with {status}.");
            return Ok(Exit::Exited);
        }
        #[cfg(unix)]
        {
            // The legacy launcher also asks its owned process to terminate.
            // Some Chromium builds acknowledge Browser.close and stay alive.
            use std::os::unix::process::ExitStatusExt;
            cantrip_host::process::signal_owned(
                &self.child,
                libc::SIGTERM,
                false,
                "Chromium process is no longer owned.",
            )?;
            if let Ok(status) = tokio::time::timeout(EXIT_GRACE, self.child.wait()).await {
                let status = status?;
                ensure!(
                    status.success() || status.signal() == Some(libc::SIGTERM),
                    "Chromium exited with {status}."
                );
                return Ok(Exit::Terminated);
            }
        }
        self.kill()?;
        tokio::time::timeout(EXIT_GRACE, self.child.wait())
            .await
            .context("Timed out reaping the terminated Chromium process.")??;
        Ok(Exit::Forced)
    }

    fn kill(&mut self) -> Result<()> {
        if self.child.id().is_some() {
            #[cfg(unix)]
            cantrip_host::process::signal_owned(
                &self.child,
                libc::SIGKILL,
                true,
                "Chromium process is no longer owned.",
            )?;
            #[cfg(windows)]
            if let Some(job) = &self.job {
                job.terminate()?;
            } else {
                self.child.start_kill()?;
            }
        }
        Ok(())
    }
}

impl Drop for ChildTree {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

async fn report_endpoint(mut stderr: impl AsyncRead + Unpin, ready: oneshot::Sender<Result<Url>>) {
    let endpoint = read_endpoint(&mut stderr).await;
    let _ = ready.send(endpoint);
    let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
}

async fn read_endpoint(stderr: &mut (impl AsyncRead + Unpin)) -> Result<Url> {
    let mut tail = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let received = stderr.read(&mut buffer).await?;
        if received == 0 {
            return Err(anyhow!(
                "Chromium exited before remote debugging was ready."
            ));
        }
        tail.extend_from_slice(&buffer[..received]);
        if let Some(last) = tail.iter().rposition(|&byte| byte == b'\n') {
            let lines = String::from_utf8_lossy(&tail[..=last]);
            for line in lines.lines() {
                if let Some(address) = line.trim().strip_prefix(ENDPOINT_LINE) {
                    return super::cdp::loopback_endpoint(address);
                }
            }
            tail.drain(..=last);
        }
        if tail.len() > STDERR_WINDOW {
            tail.drain(..tail.len() - STDERR_WINDOW);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn recognizes_only_a_loopback_browser_endpoint_in_split_stderr() {
        let (mut stderr, mut browser) = tokio::io::duplex(512);
        let writing = tokio::spawn(async move {
            browser
                .write_all(b"diagnostic\nDevTools lis")
                .await
                .unwrap();
            browser.write_all(b"tening on ws://127.0.0.1:9000/devtools/browser/3c958bc9-df95-4aae-9852-48027e6ccc58\n").await.unwrap();
        });
        assert_eq!(read_endpoint(&mut stderr).await.unwrap().port(), Some(9000));
        writing.await.unwrap();
        let mut bad = b"DevTools listening on ws://192.0.2.1:9000/devtools/browser/3c958bc9-df95-4aae-9852-48027e6ccc58\n".as_slice();
        assert!(read_endpoint(&mut bad).await.is_err());
    }
}
