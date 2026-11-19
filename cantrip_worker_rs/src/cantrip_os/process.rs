//! Finite guest commands with durable native identifiers and bounded output.
use super::{
    carrier::DeliveryUnknown,
    operations::Journal,
    session::{Session, file_uri},
    text,
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{Value, value::json};
use std::time::Duration;
use tokio::time::Instant;
use uuid::Uuid;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

pub(super) async fn command(
    session: &mut Session<'_>,
    journal: Option<&mut Journal<'_>>,
    argv: &[&str],
    cwd: &str,
) -> Result<String> {
    let cwd = file_uri(cwd)?;
    let id = Uuid::new_v4().to_string();
    if let Some(journal) = journal {
        journal.prepare_process(&id, argv)?;
    }
    let receipt = async {
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        session
            .request(
                "process/start",
                json!({"processId":id,"argv":argv,"cwd":cwd.as_str(),
                    "env":json!({"GIT_TERMINAL_PROMPT":"0","GIT_OPTIONAL_LOCKS":"0"}),
                    "tty":false,"pipeStdin":false,"arg0":Value::Null,"sandbox":Value::Null}),
            )
            .await?;
        let mut after = None::<u64>;
        let mut termination = None;
        let mut exited = false;
        let mut output = Vec::new();
        let mut bytes = 0_usize;
        let mut truncated = false;
        loop {
            let expired = Instant::now() >= deadline;
            if termination.is_none() && (expired || (!exited && bytes > MAX_OUTPUT)) {
                session
                    .request("process/terminate", json!({"processId":id}))
                    .await?;
                termination = Some(Instant::now() + Duration::from_secs(10));
            }
            let page = session
                .request(
                    "process/read",
                    json!({"processId":id,"afterSeq":after,"maxBytes":65536,"waitMs":200}),
                )
                .await?;
            let chunks = page["chunks"].as_array().context("Guest process output")?;
            let cursor = page["nextSeq"]
                .as_u64()
                .context("Guest process cursor")?
                .saturating_sub(1);
            ensure!(
                cursor >= after.unwrap_or(0),
                "Guest process cursor moved backwards."
            );
            exited = page["exited"]
                .as_bool()
                .context("Guest process exit flag")?;
            let closed = page["closed"]
                .as_bool()
                .context("Guest process close flag")?;
            if page["outputEvictedThroughSeq"]
                .as_u64()
                .is_some_and(|seq| seq > after.unwrap_or(0))
            {
                truncated = true;
            }
            for chunk in chunks {
                let data = STANDARD.decode(text(chunk, "chunk")?)?;
                if text(chunk, "stream")? == "stdout" {
                    output.extend_from_slice(
                        &data[..data.len().min(MAX_OUTPUT.saturating_sub(bytes))],
                    );
                }
                bytes = bytes.saturating_add(data.len());
            }
            after = Some(cursor);
            if exited && closed && chunks.is_empty() {
                ensure!(
                    !truncated && bytes <= MAX_OUTPUT,
                    "Guest process output is incomplete."
                );
                return Ok::<_, anyhow::Error>((page, output, termination.is_some()));
            }
            ensure!(
                (!closed || exited) && page["failure"].is_null(),
                "Guest process closed without an observed exit."
            );
            if termination.is_some_and(|deadline| Instant::now() >= deadline) {
                bail!("Guest process did not close after termination.");
            }
        }
    }
    .await
    .map_err(|error| {
        DeliveryUnknown(format!(
            "Linux process {id} has an unknown outcome; inspect its native session: {error}"
        ))
    })?;
    let (page, output, terminated) = receipt;
    ensure!(
        page["exitCode"].as_u64() == Some(0) && page["failure"].is_null() && !terminated,
        "Linux source command exited {}.",
        page["exitCode"].stringify()
    );
    // Keep significant path bytes and remove only the final Linux delimiter.
    let output = output.strip_suffix(b"\n").unwrap_or(&output);
    Ok(String::from_utf8_lossy(output).into_owned())
}
