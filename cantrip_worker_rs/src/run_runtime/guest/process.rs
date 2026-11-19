//! Own the carrier, sequence guest process receipts and drain bounded output.
use super::{DEFAULT_GRACE, incomplete, journal::Journal, started};
use crate::{
    cantrip_os::{
        assert_scope,
        carrier::{DeliveryUnknown, Transport},
        session::{Session, file_uri},
        text,
    },
    filesystem::Scope,
    run_runtime::{LaunchJob, Manager},
    terminal_services::output::Utf8,
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{Value, value::json};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

const CLIENT: &str = "cantrip-run-execution";
const OWNER: &str = "/usr/lib/cantrip-os-executor/process-owner";
const RPC: Duration = Duration::from_secs(5);
const TERMINATION: Duration = Duration::from_secs(10);
const PREPARATION_LIMIT: usize = 8 * 1024 * 1024;

pub(super) struct Executor<'a> {
    manager: &'a Manager,
    transport: Transport,
    binding: Value,
    lifetime: &'a Scope,
    session: Option<Session<'a>>,
}

#[derive(Default)]
pub(super) struct Observation {
    pub code: Option<i32>,
    pub stdout: String,
}

impl<'a> Executor<'a> {
    pub async fn capture(manager: &'a Manager, input: &Value, lifetime: &'a Scope) -> Result<Self> {
        let transport = Transport::from_value(&input["target"]["transport"])?;
        let source = &input["definitions"]["scope"];
        let target = &input["target"]["scope"];
        assert_scope(&transport, target, true, lifetime).await?;
        let definition = Session::capture_binding(&transport, source, lifetime).await?;
        let binding = Session::capture_binding(&transport, target, lifetime).await?;
        ensure!(
            definition == binding,
            "The Linux Run executor changed while capturing the workspace."
        );
        Ok(Self {
            manager,
            transport,
            binding,
            lifetime,
            session: None,
        })
    }

    pub async fn open(&mut self, journal: &mut Journal) -> Result<()> {
        let (session, id) = Session::connect(
            &self.transport,
            self.binding.clone(),
            CLIENT,
            None,
            self.lifetime,
        )
        .await?;
        self.session = Some(session);
        journal.record["native"] =
            json!({"sessionId":id,"executorGeneration":self.binding["executor_generation"]});
        journal.save()
    }

    pub async fn resume(&mut self, journal: &Journal) -> Result<()> {
        let native = &journal.record["native"];
        let expected = text(native, "sessionId")?;
        ensure!(
            native["executorGeneration"] == self.binding["executor_generation"],
            "The Linux Run executor generation changed."
        );
        if let Some(previous) = self.session.take() {
            previous.close().await;
        }
        let (session, actual) = Session::connect(
            &self.transport,
            self.binding.clone(),
            CLIENT,
            Some(expected),
            self.lifetime,
        )
        .await?;
        self.session = Some(session);
        ensure!(
            actual == expected,
            "The retained Linux Run session changed."
        );
        Ok(())
    }

    pub async fn close(mut self) {
        if let Some(session) = self.session.take() {
            session.close().await;
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.session
            .as_mut()
            .context("Linux Run executor is disconnected.")?
            .request_with_timeout(method, params, RPC)
            .await
    }

    pub async fn start(
        &mut self,
        job: &LaunchJob,
        journal: &mut Journal,
        command: &Value,
        environment: &Value,
        phase: &str,
        input: Option<&[u8]>,
    ) -> Result<Observation> {
        if job.stopping() {
            return Ok(Observation::default());
        }
        let id = Uuid::new_v4().to_string();
        let tty = phase != "prepare";
        let cwd = file_uri(text(command, "workingDirectory")?)?;
        let mut argv = vec![json!(OWNER), command["executable"].clone()];
        argv.extend(command["arguments"].as_array().unwrap().iter().cloned());
        journal
            .processes_mut()
            .push(json!({"id":id,"phase":phase,"tty":tty,"exited":false}));
        journal.save()?;
        // This ID is durable before any mutating message. A lost receipt can
        // reopen observation of this ID only, with no input sent a second time.
        let dispatched = self
            .dispatch(
                job,
                &id,
                &json!({
                    "processId":id,"argv":argv,"cwd":cwd.as_str(),"env":environment,
                    "tty":tty,"pipeStdin":input.is_some(),"arg0":Value::Null,"sandbox":Value::Null,
                }),
                input,
            )
            .await;
        if let Err(error) = dispatched {
            if !error.is::<DeliveryUnknown>() {
                return Err(error);
            }
            self.resume(journal).await?;
        }
        self.observe(job, journal, false).await
    }

    async fn dispatch(
        &mut self,
        job: &LaunchJob,
        id: &str,
        request: &Value,
        input: Option<&[u8]>,
    ) -> Result<()> {
        self.request("process/start", request.clone()).await?;
        if request["tty"] == true
            && let Err(error) = self
                .request(
                    "process/resize",
                    json!({"processId":id,"cols":120,"rows":40}),
                )
                .await
        {
            if error.is::<DeliveryUnknown>() {
                return Err(error);
            }
            let page = self.read(id, None, 1, 0).await?;
            if !terminal(&page) {
                return Err(error);
            }
        }
        if let Some(input) = input {
            for chunk in input.chunks(32768) {
                if job.stopping() {
                    break;
                }
                let receipt = self.write(id, &Uuid::new_v4().to_string(), chunk).await?;
                if receipt["status"] != "accepted" {
                    // The send was attempted. Treat an unexpected acknowledgement
                    // like delivery loss, and only observe this process ID.
                    return Err(DeliveryUnknown(
                        "Linux preparation input was not acknowledged.".into(),
                    )
                    .into());
                }
            }
        }
        Ok(())
    }

    async fn write(&mut self, id: &str, write_id: &str, bytes: &[u8]) -> Result<Value> {
        self.request(
            "process/write",
            json!({"processId":id,"writeId":write_id,"chunk":STANDARD.encode(bytes)}),
        )
        .await
    }

    async fn read(
        &mut self,
        id: &str,
        sequence: Option<u64>,
        maximum: u64,
        wait: u64,
    ) -> Result<Value> {
        self.request(
            "process/read",
            json!({"processId":id,"afterSeq":sequence,"maxBytes":maximum,"waitMs":wait}),
        )
        .await
    }

    pub async fn observe(
        &mut self,
        job: &LaunchJob,
        journal: &mut Journal,
        recovering: bool,
    ) -> Result<Observation> {
        let process = journal
            .processes()
            .last()
            .context("The Linux Run process admission is missing.")?;
        let id = text(process, "id")?.to_owned();
        let phase = text(process, "phase")?.to_owned();
        let tty = process["tty"] == true;
        let already_settled = process["exited"] == true;
        let capture = phase == "prepare";
        let deadline = match phase.as_str() {
            "prepare" => Some(Instant::now() + Duration::from_secs(180)),
            "before-launch" => Some(Instant::now() + Duration::from_secs(30 * 60)),
            _ => None,
        };
        let mut termination = Termination::default();
        let mut cursor = None;
        let mut output = ProcessOutput::new(capture);
        let mut timed_out = false;
        loop {
            let now = Instant::now();
            timed_out |= deadline.is_some_and(|deadline| now >= deadline) && !job.stopping();
            if !already_settled
                && (job.stopping() || journal.record["stopRequested"] == true || timed_out)
            {
                let force = !tty
                    || timed_out
                    || recovering && journal.record["stopRequested"] == true
                    || job.control.force.load(Ordering::Acquire);
                self.stop(journal, &id, &mut termination, force, !timed_out)
                    .await?;
            }
            let page = match self.read(&id, cursor, 65536, 200).await {
                Err(error) if error.is::<DeliveryUnknown>() => {
                    self.resume(journal).await?;
                    self.read(&id, cursor, 65536, 200).await?
                }
                result => result?,
            };
            let evicted = page["outputEvictedThroughSeq"].as_u64();
            if let Some(end) = evicted.filter(|&end| end > cursor.unwrap_or(0)) {
                output.finish(job);
                incomplete(
                    job,
                    journal,
                    &format!(
                        "\r\n[Earlier Linux command output through native sequence {end} was evicted; the command was not repeated.]\r\n"
                    ),
                )?;
                ensure!(!capture, "Linux preparation output was evicted.");
            } else if cursor.is_none() && recovering && evicted.is_none() {
                incomplete(
                    job,
                    journal,
                    "\r\n[The native executor did not report whether earlier Linux output was retained.]\r\n",
                )?;
            }
            if cursor.is_none()
                && phase == "runtime"
                && page["exited"] == false
                && journal.record["stopRequested"] != true
            {
                started(job, journal, self.manager);
            }
            cursor = Some(
                page["nextSeq"]
                    .as_u64()
                    .context("Invalid Linux Run output cursor.")?
                    .saturating_sub(1),
            );
            let chunks = page["chunks"]
                .as_array()
                .context("Invalid Linux Run output.")?;
            for chunk in chunks {
                output.push(job, chunk)?;
            }
            if terminal(&page) && chunks.is_empty() {
                output.finish(job);
                journal.processes_mut().last_mut().unwrap()["exited"] = json!(true);
                journal.save()?;
                ensure!(!timed_out, "Linux Run preparation timed out.");
                return Ok(Observation {
                    code: exit_code(&page),
                    stdout: output.stdout,
                });
            }
            ensure!(
                page["failure"].is_null() && (page["closed"] != true || page["exited"] == true),
                "Linux Run process closed without a confirmed exit."
            );
            ensure!(
                termination
                    .forced
                    .is_none_or(|until| Instant::now() < until),
                "Linux Run process termination could not be confirmed."
            );
        }
    }

    async fn stop(
        &mut self,
        journal: &mut Journal,
        id: &str,
        timing: &mut Termination,
        force: bool,
        user_stop: bool,
    ) -> Result<()> {
        if timing.forced.is_some() {
            return Ok(());
        }
        if user_stop && journal.record["stopRequested"] != true {
            journal.record["stopRequested"] = json!(true);
            journal.save()?;
        }
        if !force && timing.grace.is_none() && journal.record["gracefulWriteId"].is_null() {
            let write_id = Uuid::new_v4().to_string();
            journal.record["gracefulWriteId"] = json!(write_id);
            journal.save()?;
            let ack = match self.write(id, &write_id, &[3]).await {
                Err(error) if error.is::<DeliveryUnknown>() => {
                    self.resume(journal).await?;
                    // A delivery-unknown interrupt is never repeated.
                    Value::Null
                }
                result => result.unwrap_or(Value::Null),
            };
            if ack["status"] == "accepted" {
                let ms = journal.record["stopGracePeriodMs"]
                    .as_u64()
                    .unwrap_or(DEFAULT_GRACE);
                timing.grace = Some(Instant::now() + Duration::from_millis(ms));
                return Ok(());
            }
        }
        if force || timing.grace.is_none_or(|until| Instant::now() >= until) {
            match self
                .request("process/terminate", json!({"processId":id}))
                .await
            {
                Err(error) if error.is::<DeliveryUnknown>() => self.resume(journal).await?,
                result => {
                    result?;
                }
            }
            timing.forced = Some(Instant::now() + TERMINATION);
        }
        Ok(())
    }

    pub async fn terminate(&mut self, id: &str) -> Result<Option<i32>> {
        let terminated = self
            .request("process/terminate", json!({"processId":id}))
            .await?;
        if terminated["running"] == false {
            return Ok(None);
        }
        ensure!(
            terminated["running"] == true,
            "Invalid Linux Run termination receipt."
        );
        let until = Instant::now() + TERMINATION;
        loop {
            let page = self.read(id, None, 1, 200).await?;
            if terminal(&page) {
                return Ok(exit_code(&page));
            }
            if Instant::now() >= until {
                bail!("Linux Run process termination could not be confirmed.");
            }
        }
    }
}

#[derive(Default)]
struct Termination {
    grace: Option<Instant>,
    forced: Option<Instant>,
}

struct ProcessOutput {
    capture: bool,
    stdout: String,
    bytes: usize,
    decoders: [Utf8; 3],
}

impl ProcessOutput {
    fn new(capture: bool) -> Self {
        Self {
            capture,
            stdout: String::new(),
            bytes: 0,
            decoders: Default::default(),
        }
    }

    fn push(&mut self, job: &LaunchJob, chunk: &Value) -> Result<()> {
        let stream = match chunk["stream"].as_str() {
            Some("stdout") => 0,
            Some("stderr") => 1,
            Some("pty") => 2,
            _ => return Ok(()),
        };
        let bytes = STANDARD
            .decode(text(chunk, "chunk")?)
            .context("Invalid Linux Run output chunk.")?;
        if self.capture {
            self.bytes += bytes.len();
            ensure!(
                self.bytes <= PREPARATION_LIMIT,
                "Linux Run preparation output exceeded its bound."
            );
        }
        let text = self.decoders[stream].push(&bytes);
        self.emit(job, stream, &text);
        Ok(())
    }

    fn emit(&mut self, job: &LaunchJob, stream: usize, text: &str) {
        if !self.capture {
            job.append(text);
        } else if stream == 0 {
            self.stdout.push_str(text);
        }
    }

    fn finish(&mut self, job: &LaunchJob) {
        for stream in 0..self.decoders.len() {
            let tail = self.decoders[stream].finish();
            self.emit(job, stream, &tail);
        }
    }
}

fn terminal(value: &Value) -> bool {
    value["exited"] == true && value["closed"] == true
}

fn exit_code(value: &Value) -> Option<i32> {
    value["exitCode"]
        .as_i64()
        .and_then(|code| i32::try_from(code).ok())
}
