//! Test-only observer around the real native pg_dump. Pause only after an actual
//! fixture-table INSERT has arrived, so interruption cannot precede SQL reading.
use anyhow::{Context, Result, ensure};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
#[tokio::main]
async fn main() -> Result<()> {
    let real = std::env::var_os("CANTRIP_TEST_REAL_PG_DUMP").context("real pg_dump")?;
    let witness =
        PathBuf::from(std::env::var_os("CANTRIP_TEST_DUMP_WITNESS").context("witness path")?);
    let release = witness.with_extension("release");
    let mut child = Command::new(real)
        .args(std::env::args_os().skip(1))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = BufReader::new(child.stdout.take().context("dump stdout")?);
    let mut stderr = child.stderr.take().context("dump stderr")?;
    let errors = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let mut output = tokio::io::stdout();
    let mut line = Vec::new();
    let mut observed = false;
    let copying:Result<()>=async {
        while input.read_until(b'\n',&mut line).await?>0 {
            output.write_all(&line).await?;output.flush().await?;
            if !observed && line.starts_with(b"INSERT INTO public.migration_probe ") {
                observed=true;
                std::fs::write(witness.with_extension("pids"),serde_json::to_vec(&serde_json::json!({"observer":std::process::id(),"pgDump":child.id().context("dump pid")?,"actualFixtureRowObserved":true}))?)?;
                std::fs::write(&witness,b"1\n")?;
                while !release.try_exists()? {tokio::time::sleep(Duration::from_millis(10)).await;}
            }
            line.clear();
        }
        Ok(())
    }.await;
    if copying.is_err() {
        let _ = child.start_kill();
    }
    let status = child.wait().await?;
    let errors = errors.await??;
    copying?;
    ensure!(
        status.success(),
        "real pg_dump failed: {}",
        String::from_utf8_lossy(&errors)
    );
    ensure!(observed, "real fixture row was never observed");
    Ok(())
}
