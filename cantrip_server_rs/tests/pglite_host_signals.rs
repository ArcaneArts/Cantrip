#![cfg(unix)]

use anyhow::{Context, Result, bail, ensure};
use std::{io::Write, os::fd::AsFd, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

const CASE: &str = "CANTRIP_PGLITE_HOST_SIGNAL_CASE";
const ROOT: &str = "CANTRIP_PGLITE_HOST_SIGNAL_ROOT";
const READY: &str = "CANTRIP_PGLITE_HOST_SIGNAL_READY";

#[tokio::test]
async fn native_pglite_preserves_host_interrupts_and_post_signal_writes() -> Result<()> {
    if let Ok(case) = std::env::var(CASE) {
        // PostgreSQL owns process-global stdio while its engine is active.
        // Keep the same independent parent-output descriptor as the server.
        let mut output = std::fs::File::from(std::io::stdout().as_fd().try_clone_to_owned()?);
        let (order, number) = case.split_once(':').context("owned signal case")?;
        let kind = tokio::signal::unix::SignalKind::from_raw(number.parse()?);
        let mut host = if order == "before" {
            Some(tokio::signal::unix::signal(kind)?)
        } else {
            None
        };
        let database = pglite::PGlite::open(PathBuf::from(std::env::var(ROOT)?)).await?;
        database
            .exec("CREATE TABLE host_signal_write(value integer NOT NULL)")
            .await?;
        if host.is_none() {
            host = Some(tokio::signal::unix::signal(kind)?);
        }
        writeln!(output, "{READY}")?;
        output.flush()?;
        tokio::time::timeout(Duration::from_secs(10), host.as_mut().unwrap().recv())
            .await?
            .context("host signal stream closed")?;
        // Shutdown drains may still have durable work after the host receives
        // its signal. It must not become PostgreSQL termination/cancellation.
        database.exec("SET statement_timeout='25ms'").await?;
        // The current Source PGlite completes this single-backend sleep despite
        // statement_timeout. Keep that observed behavior after a host signal.
        database.exec("SELECT pg_sleep(0.1)").await?;
        database.exec("RESET statement_timeout").await?;
        let transaction = database.transaction().await?;
        transaction
            .exec("INSERT INTO host_signal_write VALUES(7)")
            .await?;
        transaction.commit().await?;
        let rows = database
            .query("SELECT value FROM host_signal_write", &[])
            .await?;
        ensure!(rows.len() == 1 && rows[0].get::<i32>(0)? == 7);
        database.close().await?;
        return Ok(());
    }

    // Every native backend owns process-global PostgreSQL state. Exercise real
    // signals only in an owned child, including a pre-existing host listener.
    let root = tempfile::Builder::new()
        .prefix("cantrip-pglite-host-signals-")
        .tempdir()?;
    for order in ["before", "after"] {
        for number in [libc::SIGTERM, libc::SIGINT] {
            let case = format!("{order}:{number}");
            let mut child = tokio::process::Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "native_pglite_preserves_host_interrupts_and_post_signal_writes",
                    "--nocapture",
                ])
                .env(CASE, &case)
                .env(ROOT, root.path().join(format!("{order}-{number}")))
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()?;
            let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
            let mut errors = child.stderr.take().unwrap();
            let stderr = tokio::spawn(async move {
                let mut tail = Vec::new();
                let mut buffer = [0; 8192];
                while let Ok(count) = errors.read(&mut buffer).await {
                    if count == 0 {
                        break;
                    }
                    tail.extend_from_slice(&buffer[..count]);
                    if tail.len() > 4096 {
                        drop(tail.drain(..tail.len() - 4096));
                    }
                }
                String::from_utf8_lossy(&tail).into_owned()
            });
            let outcome: Result<()> = async {
                tokio::time::timeout(Duration::from_secs(60), async {
                    while let Some(line) = output.next_line().await? {
                        if line.contains(READY) {
                            return Ok::<_, anyhow::Error>(());
                        }
                    }
                    bail!("owned signal child ended before readiness")
                })
                .await??;
                let pid = child.id().context("owned signal child PID")?;
                // SAFETY: this is the live child spawned above, not a PID read
                // from a file or discovered among unrelated processes.
                if unsafe { libc::kill(pid as libc::pid_t, number) } != 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
                    .await
                    .context("host signal or post-signal database work did not finish")??;
                ensure!(status.success(), "owned signal child failed: {status}");
                Ok(())
            }
            .await;
            if let Err(error) = outcome {
                let _ = child.kill().await;
                let diagnostics = stderr.await?;
                let retained = root.keep();
                bail!(
                    "{case}: {error:#}; retained {}; stderr: {diagnostics}",
                    retained.display()
                );
            }
            let _ = stderr.await?;
        }
    }
    Ok(())
}
