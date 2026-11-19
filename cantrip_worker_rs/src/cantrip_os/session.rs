//! A private, generation-bound executor session over the existing guest carrier.
use super::{
    carrier::{DeliveryUnknown, Program, Transport},
    text,
};
use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};
use url::Url;

const DEADLINE: Duration = Duration::from_secs(60);
const FRAME_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct RpcError {
    method: String,
    error: Value,
}

impl RpcError {
    pub(super) fn unknown_session(&self, expected: &str) -> bool {
        self.method == "initialize"
            && self.error["code"] == -32600
            && self.error["message"] == format!("unknown session id {expected}")
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Guest executor rejected {}: {}",
            self.method,
            self.error.stringify()
        )
    }
}

impl std::error::Error for RpcError {}

pub(crate) struct Session<'a> {
    pub binding: Value,
    lifetime: &'a Scope,
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    next_id: u64,
}

impl<'a> Session<'a> {
    pub async fn capture_binding(
        transport: &Transport,
        scope: &Value,
        lifetime: &Scope,
    ) -> Result<Value> {
        let workspace = text(scope, "guestWorkspaceId")?;
        let binding = transport
            .control(Program::Executor, &["open", workspace], lifetime)
            .await?;
        ensure!(
            [
                ("instance_id", "guestInstanceId"),
                ("generation", "runtimeGeneration"),
                ("owner_id", "ownerId"),
                ("worker_id", "workerId"),
                ("workspace_id", "guestWorkspaceId"),
                ("uid", "uid"),
                ("home", "homeGuestPath"),
            ]
            .into_iter()
            .all(|(native, admitted)| binding[native] == scope[admitted]),
            "The selected OS workspace identity changed."
        );
        Ok(binding)
    }

    pub async fn open(
        transport: &Transport,
        scope: &Value,
        client: &str,
        lifetime: &'a Scope,
    ) -> Result<(Self, String)> {
        let binding = Self::capture_binding(transport, scope, lifetime).await?;
        Self::connect(transport, binding, client, None, lifetime).await
    }

    pub async fn connect(
        transport: &Transport,
        binding: Value,
        client: &str,
        resume_session_id: Option<&str>,
        lifetime: &'a Scope,
    ) -> Result<(Self, String)> {
        let workspace = text(&binding, "workspace_id")?;
        let (program, args) = transport.spec(
            Program::Executor,
            &["connect", workspace, "--expect", &binding.stringify()],
        );
        lifetime.check()?;
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().context("Opening the OS executor carrier")?;
        let mut session = Self {
            input: child.stdin.take(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            binding,
            lifetime,
            next_id: 1,
        };
        let initialized = async {
            let receipt = session
                .request(
                    "initialize",
                    json!({"clientName":client,"resumeSessionId":resume_session_id}),
                )
                .await?;
            let id = text(&receipt, "sessionId")?.to_owned();
            session
                .exchange(
                    json!({"method":"initialized","params":Value::Null}),
                    None,
                    DEADLINE,
                )
                .await?;
            Ok(id)
        }
        .await;
        match initialized {
            Ok(id) => Ok((session, id)),
            Err(error) => {
                session.close().await;
                Err(error)
            }
        }
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, DEADLINE).await
    }

    pub async fn request_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let response = self
            .exchange(
                json!({"id":id,"method":method,"params":params}),
                Some(id),
                deadline,
            )
            .await?;
        if response["error"].is_object() {
            return Err(RpcError {
                method: method.to_owned(),
                error: response["error"].clone(),
            }
            .into());
        }
        Ok(response["result"].clone())
    }

    async fn exchange(
        &mut self,
        message: Value,
        id: Option<u64>,
        deadline: Duration,
    ) -> Result<Value> {
        let mut frame = message.stringify();
        frame.push('\n');
        ensure!(
            frame.len() <= FRAME_LIMIT,
            "Guest executor frame is too large."
        );
        self.lifetime.check()?;
        let input = self
            .input
            .as_mut()
            .context("Guest executor carrier is closed.")?;
        let output = &mut self.output;
        let exchange = timeout(deadline, async {
            input.write_all(frame.as_bytes()).await?;
            let Some(id) = id else {
                return Ok(Value::Null);
            };
            let mut line = Vec::new();
            loop {
                line.clear();
                (&mut *output)
                    .take(FRAME_LIMIT as u64)
                    .read_until(b'\n', &mut line)
                    .await?;
                ensure!(
                    line.last() == Some(&b'\n'),
                    "Incomplete guest executor frame."
                );
                let message = parse_json_text(std::str::from_utf8(&line)?)
                    .map_err(|_| anyhow!("Invalid guest executor frame."))?;
                if message.get("id").is_none() && message["method"].as_str().is_some() {
                    continue;
                }
                ensure!(
                    message["id"].as_u64() == Some(id)
                        && (message.get("result").is_some() != message["error"].is_object()),
                    "Uncorrelated guest executor receipt."
                );
                return Ok::<_, anyhow::Error>(message);
            }
        });
        let outcome = tokio::select! {
            biased;
            _ = self.lifetime.stopped() => Err(anyhow!("The worker is stopping.")),
            result = exchange => match result {
                Ok(response) => response,
                Err(_) => Err(anyhow!("Guest executor request timed out.")),
            },
        };
        outcome.map_err(|error| {
            self.input.take();
            DeliveryUnknown(format!("Guest executor delivery is uncertain: {error}")).into()
        })
    }

    pub async fn close(mut self) {
        drop(self.input.take());
        if timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            let _ = cantrip_host::process::signal_owned(
                &self.child,
                libc::SIGKILL,
                true,
                "Owned guest executor carrier",
            );
            #[cfg(windows)]
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }
    }
}

// Match encodeURIComponent on each POSIX path segment, even on Windows hosts.
const URI_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub(crate) fn file_uri(path: &str) -> Result<Url> {
    super::checked("cantripOsGuestPathSchema", json!(path))?;
    let encoded = path
        .split('/')
        .map(|part| utf8_percent_encode(part, URI_SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(Url::parse(&format!("file://{encoded}"))?)
}

pub(super) fn file_path(uri: &Url) -> Result<String> {
    ensure!(
        uri.scheme() == "file"
            && uri.host().is_none()
            && uri.query().is_none()
            && uri.fragment().is_none(),
        "Expected a local Linux guest file URI."
    );
    let path = percent_decode_str(uri.path()).decode_utf8()?;
    super::checked("cantripOsGuestPathSchema", json!(&*path))?;
    Ok(path.into_owned())
}
