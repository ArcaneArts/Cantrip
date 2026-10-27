//! A native owner survives the main server long enough to stop and reap its
//! database. The server holds the only write end of the owner's stdin pipe.
use super::{Credentials, binary, private_file};
use anyhow::{Context, Result, bail};
use clap::Parser;
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::oneshot,
};
use uuid::Uuid;

const FLAG: &str = "--internal-postgres-owner";

pub(super) struct PostgresProcess {
    child: Child,
}

impl PostgresProcess {
    pub(super) fn start(
        program: &Path,
        root: &Path,
        binaries: &Path,
        port: u16,
        log: File,
    ) -> Result<Self> {
        let mut command = Command::new(program);
        command
            .arg(FLAG)
            .arg("--data-dir")
            .arg(root)
            .arg("--postgres-bin-dir")
            .arg(binaries)
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::piped())
            .stdout(log.try_clone()?)
            .stderr(log)
            // Killing the owner on Drop would defeat its parent-death cleanup.
            // Dropping Child's stdin instead closes the server's private pipe.
            .kill_on_drop(false);
        // Terminal Ctrl-C belongs to the server. It must drain its database
        // work before closing this pipe; the owner must survive that signal.
        command.as_std_mut().process_group(0);
        let child = command.spawn().context("launch native PostgreSQL owner")?;
        Ok(Self { child })
    }
    pub(super) fn release(&mut self) {
        drop(self.child.stdin.take());
    }
    pub(super) fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        Ok(self.child.try_wait()?)
    }
    pub(super) async fn wait(&mut self) -> Result<ExitStatus> {
        Ok(self.child.wait().await?)
    }
    pub(super) async fn kill(&mut self) -> Result<()> {
        self.release();
        self.wait().await?;
        Ok(())
    }
}

#[derive(Parser)]
struct Arguments {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    postgres_bin_dir: PathBuf,
    #[arg(long)]
    port: u16,
}

fn parent_pipe() -> Result<oneshot::Receiver<()>> {
    let mut input = os_pipe::dup_stdin()?;
    let (send, receive) = oneshot::channel();
    // Tokio's blocking stdin reader cannot be cancelled and can keep runtime
    // teardown waiting after PostgreSQL itself exits. This plain reader thread
    // owns only the pipe; it need not be joined before the owner process exits.
    std::thread::Builder::new()
        .name("postgres-parent-pipe".into())
        .spawn(move || {
            let mut buffer = [0; 256];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = send.send(());
        })?;
    Ok(receive)
}

fn signal(child: &Child, signal: i32, group: bool) -> Result<()> {
    let pid = i32::try_from(child.id().context("owned PostgreSQL process identity")?)?;
    // The unreaped child handle retains this PID; the initdb process group was
    // created by us. No identity is inferred from a directory's PID file.
    if unsafe { libc::kill(if group { -pid } else { pid }, signal) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    Ok(())
}

async fn initialize(args: &Arguments, parent: &mut oneshot::Receiver<()>) -> Result<bool> {
    let data = args.data_dir.join("data");
    if data.join("PG_VERSION").try_exists()? {
        return Ok(true);
    }
    let credentials: Credentials =
        serde_json::from_slice(&std::fs::read(args.data_dir.join("credentials.json"))?)?;
    let stage = args
        .data_dir
        .join(format!("initializing-{}", Uuid::new_v4()));
    let password = args
        .data_dir
        .join(format!("init-password-{}", Uuid::new_v4()));
    writeln!(private_file(&password)?, "{}", credentials.password)?;
    let mut command = Command::new(binary(&args.postgres_bin_dir, "initdb"));
    command
        .arg("-D")
        .arg(&stage)
        .arg("-U")
        .arg(&credentials.username)
        .args(["--auth=scram-sha-256", "--encoding=UTF8", "--locale=C"])
        .arg("--pwfile")
        .arg(&password)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let outcome: Result<Option<ExitStatus>> = async {
        let mut child = command.spawn().context("launch bundled initdb")?;
        tokio::select! {
            status = child.wait() => Ok(Some(status?)),
            _ = parent => {
                signal(&child, libc::SIGKILL, true)?;
                child.wait().await?;
                Ok(None)
            }
        }
    }
    .await;
    let removed = std::fs::remove_file(&password);
    let status = match outcome {
        Ok(status) => {
            removed?;
            status
        }
        Err(error) => {
            let _ = removed;
            return Err(error);
        }
    };
    match status {
        Some(status) if status.success() => {
            // initdb syncs its output before returning. Promote only a complete
            // new cluster; never erase or reset an existing data directory.
            if let Err(error) = std::fs::rename(&stage, &data) {
                // initdb has exited. This is our new, unused cluster; the
                // existing target remains untouched after promotion failed.
                let _ = std::fs::remove_dir_all(&stage);
                return Err(error).context("promote initialized private PostgreSQL cluster");
            }
            File::open(&args.data_dir)?.sync_all()?;
            Ok(true)
        }
        status => {
            if stage.exists() {
                std::fs::remove_dir_all(&stage)?;
            }
            if let Some(status) = status {
                bail!("initdb failed ({status}); see postgres.log");
            }
            Ok(false)
        }
    }
}

pub(super) async fn run_if_requested() -> Result<bool> {
    let mut raw = std::env::args_os();
    let executable = raw.next().context("owner executable")?;
    if raw.next().as_deref() != Some(OsStr::new(FLAG)) {
        return Ok(false);
    }
    let args = Arguments::try_parse_from(std::iter::once(executable).chain(raw))?;
    let mut parent = parent_pipe()?;
    if !initialize(&args, &mut parent).await? {
        return Ok(true);
    }
    let mut child = Command::new(binary(&args.postgres_bin_dir, "postgres"))
        .arg("-D")
        .arg(args.data_dir.join("data"))
        .args(["-h", "127.0.0.1", "-p"])
        .arg(args.port.to_string())
        .args([
            "-c",
            "unix_socket_directories=",
            "-c",
            "log_min_messages=fatal",
            "-c",
            "log_min_error_statement=panic",
            "-c",
            "log_error_verbosity=terse",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("launch owned PostgreSQL")?;
    let status = tokio::select! {
        status = child.wait() => status?,
        _ = parent => {
            if let Some(status) = child.try_wait()? { status } else {
                signal(&child, libc::SIGINT, false)?;
                match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
                    Ok(status) => status?,
                    Err(_) => {
                        child.kill().await?;
                        bail!("owned PostgreSQL did not finish fast shutdown within 30 seconds");
                    }
                }
            }
        }
    };
    if !status.success() {
        bail!("owned PostgreSQL exited unsuccessfully ({status})");
    }
    Ok(true)
}
