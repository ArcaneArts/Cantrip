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

#[derive(Clone, Copy)]
pub(super) struct Limits {
    pub deadline: Duration,
    pub output: usize,
}

pub(super) struct Invocation<'a> {
    pub argv: &'a [&'a str],
    pub cwd: &'a str,
    pub env: Value,
    pub input: Option<&'a [u8]>,
}

pub(super) struct Output {
    pub stdout: String,
    pub stderr: String,
    pub successful: bool,
    exit_code: Value,
}

pub(super) async fn command(
    session: &mut Session,
    journal: Option<&mut Journal<'_>>,
    argv: &[&str],
    cwd: &str,
) -> Result<String> {
    let output = run(
        session,
        journal,
        Invocation {
            argv,
            cwd,
            env: json!({"GIT_TERMINAL_PROMPT":"0","GIT_OPTIONAL_LOCKS":"0"}),
            input: None,
        },
        Limits {
            deadline: Duration::from_secs(30 * 60),
            output: 4 * 1024 * 1024,
        },
    )
    .await?;
    ensure!(
        output.successful,
        "Linux source command exited {}.",
        output.exit_code.stringify()
    );
    let mut stdout = output.stdout;
    // Keep significant path bytes and remove only the final Linux delimiter.
    if stdout.ends_with('\n') {
        stdout.pop();
    }
    Ok(stdout)
}

pub(super) async fn run(
    session: &mut Session,
    journal: Option<&mut Journal<'_>>,
    invocation: Invocation<'_>,
    limits: Limits,
) -> Result<Output> {
    let id = Uuid::new_v4().to_string();
    if let Some(journal) = journal {
        journal.prepare_process(&id, invocation.argv)?;
    }
    run_owned(session, &id, invocation, limits).await
}

pub(super) async fn run_owned(
    session: &mut Session,
    id: &str,
    invocation: Invocation<'_>,
    limits: Limits,
) -> Result<Output> {
    let deadline = Instant::now() + limits.deadline;
    let result = async {
        start(
            session,
            id,
            invocation.argv,
            invocation.cwd,
            invocation.env,
            invocation.input.is_some(),
        )
        .await?;
        if let Some(input) = invocation.input {
            write(session, id, input).await?;
        }
        read(session, id, deadline, limits.output, false).await
    }
    .await;
    result.map_err(|error| uncertain(id, error))
}

pub(super) async fn start(
    session: &mut Session,
    id: &str,
    argv: &[&str],
    cwd: &str,
    env: Value,
    pipe_stdin: bool,
) -> Result<()> {
    let cwd = file_uri(cwd)?;
    session
        .request(
            "process/start",
            json!({
                "processId":id,"argv":argv,"cwd":cwd.as_str(),"env":env,
                "tty":false,"pipeStdin":pipe_stdin,"arg0":Value::Null,"sandbox":Value::Null,
            }),
        )
        .await?;
    Ok(())
}

pub(super) async fn write(session: &mut Session, id: &str, input: &[u8]) -> Result<()> {
    for chunk in input.chunks(32768) {
        let result = session.request("process/write", json!({
            "processId":id,"writeId":Uuid::new_v4().to_string(),"chunk":STANDARD.encode(chunk),
        })).await?;
        ensure!(
            result["status"] == "accepted",
            "Linux process input was not acknowledged."
        );
    }
    Ok(())
}

pub(super) async fn terminate(session: &mut Session, id: &str) -> Result<()> {
    let request_timeout = Duration::from_secs(5);
    let result = session
        .request_with_timeout(
            "process/terminate",
            json!({"processId":id}),
            request_timeout,
        )
        .await?;
    if result["running"] == false {
        return Ok(());
    }
    ensure!(
        result["running"] == true,
        "Invalid native process termination receipt."
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let page = session
            .request_with_timeout(
                "process/read",
                json!({
                    "processId":id,"afterSeq":Value::Null,"maxBytes":1,"waitMs":200,
                }),
                request_timeout,
            )
            .await?;
        if page["exited"] == true && page["closed"] == true {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "The previous Linux process did not confirm termination."
        );
    }
}

pub(super) async fn observe(session: &mut Session, id: &str, limits: Limits) -> Result<Output> {
    read(
        session,
        id,
        Instant::now() + limits.deadline,
        limits.output,
        true,
    )
    .await
    .map_err(|error| uncertain(id, error))
}

fn uncertain(id: &str, error: anyhow::Error) -> anyhow::Error {
    DeliveryUnknown(format!(
        "Linux process {id} has an unknown outcome; inspect its native session: {error}"
    ))
    .into()
}

async fn read(
    session: &mut Session,
    id: &str,
    deadline: Instant,
    capacity: usize,
    observe_only: bool,
) -> Result<Output> {
    let mut after = None::<u64>;
    let mut termination = None;
    let mut exited = false;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut bytes = 0_usize;
    let mut truncated = false;
    loop {
        let expired = Instant::now() >= deadline;
        let over_capacity = bytes > capacity;
        if observe_only {
            ensure!(
                !expired && !over_capacity,
                "Guest process observation reached its bound."
            );
        } else if termination.is_none() && (expired || (!exited && over_capacity)) {
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
        truncated |= page["outputEvictedThroughSeq"]
            .as_u64()
            .is_some_and(|seq| seq > after.unwrap_or(0));
        for chunk in chunks {
            let data = STANDARD.decode(text(chunk, "chunk")?)?;
            let retained = &data[..data.len().min(capacity.saturating_sub(bytes))];
            match text(chunk, "stream")? {
                "stdout" => stdout.extend_from_slice(retained),
                "stderr" => stderr.extend_from_slice(retained),
                _ => {}
            }
            bytes = bytes.saturating_add(data.len());
        }
        after = Some(cursor);
        // The exit flag can arrive before the last page of output.
        if exited && closed && chunks.is_empty() {
            ensure!(
                !truncated && bytes <= capacity,
                "Guest process output is incomplete."
            );
            return Ok(Output {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                successful: page["exitCode"].as_u64() == Some(0)
                    && page["failure"].is_null()
                    && termination.is_none(),
                exit_code: page["exitCode"].clone(),
            });
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
