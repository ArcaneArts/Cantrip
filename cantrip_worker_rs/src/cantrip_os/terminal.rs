//! The workspace executor owns the PTY and its retained output.
use super::{
    assert_scope,
    carrier::Transport,
    operations::{digest, save},
    process,
    session::{Session, file_uri},
    text,
};
use crate::{filesystem::Scope, run_definitions::repository::read_bounded};
use anyhow::{Result, anyhow, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use codex_utils_pty::TerminalSize;
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const READ_LIMIT: u64 = 64 * 1024;
const CONTROL: Duration = Duration::from_secs(10);

pub(crate) struct Store(PathBuf);

pub(crate) struct Target {
    execution: Value,
    cwd: String,
    pub identity: String,
}

struct Descriptor {
    directory: PathBuf,
    identity: String,
    transport: Transport,
    binding: Value,
}

pub(crate) struct Pty {
    descriptor: Descriptor,
    record: Value,
    session: Session,
    pub recovering: bool,
}

pub(crate) enum Opened {
    Live(Pty),
    Exited(Value),
}

impl Target {
    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn new(
        command: &Value,
        directory: &Value,
        owner: &JsString,
        worker: &JsString,
    ) -> Result<Self> {
        let execution = checked("cantripOsExecutionSchema", &command["worktreePath"])?;
        let scope = &execution["scope"];
        ensure!(
            scope["ownerId"].as_js_string() == Some(owner)
                && scope["workerId"].as_js_string() == Some(worker),
            "The Linux terminal belongs to another account or worker."
        );
        let root = text(scope, "guestPath")?;
        let cwd = if directory["kind"] == "project-root" {
            root.to_owned()
        } else {
            let relative = text(directory, "path")?;
            let mut parts = root
                .split('/')
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>();
            let boundary = parts.len();
            for part in relative.split('/') {
                match part {
                    "" | "." => {}
                    ".." if parts.len() > boundary => {
                        parts.pop();
                    }
                    ".." => anyhow::bail!("The protected terminal directory escapes its worktree."),
                    _ => parts.push(part),
                }
            }
            format!("/{}", parts.join("/"))
        };
        let identity = placement(
            &command["terminalId"],
            &execution,
            &cwd,
            &command["serverId"],
        );
        Ok(Self {
            execution,
            cwd,
            identity,
        })
    }
}

fn placement(terminal: &Value, execution: &Value, cwd: &str, server: &Value) -> String {
    digest(json!({"terminalId":terminal,"execution":execution,"cwd":cwd,"serverId":server}))
}

impl Store {
    pub fn new(data: &Path) -> Self {
        Self(data.join("os-terminal-carriers"))
    }

    fn index(&self, terminal: &JsString, authority: &(JsString, JsString)) -> PathBuf {
        let key = digest(json!({"terminalId":terminal,"owner":authority.0,"server":authority.1}));
        self.0.join("index").join(format!("{key}.json"))
    }

    pub fn assert_host(&self, terminal: &JsString, authority: &(JsString, JsString)) -> Result<()> {
        ensure!(
            read(&self.index(terminal, authority))?.is_none(),
            "This terminal is already assigned to a Linux workspace."
        );
        Ok(())
    }

    pub async fn open(
        &self,
        terminal: &JsString,
        authority: &(JsString, JsString),
        target: Target,
        size: TerminalSize,
        lifetime: &Scope,
    ) -> Result<Opened> {
        let index = self.index(terminal, authority);
        let directory = self.0.join(&target.identity);
        let scope = &target.execution["scope"];
        let transport = Transport::from_value(&target.execution["transport"])?;
        assert_scope(&transport, scope, true, lifetime).await?;
        let binding = Session::capture_binding(&transport, scope, lifetime).await?;
        let contents = json!({
            "version":1,"terminalId":terminal,"identity":target.identity,"execution":target.execution,
            "binding":binding,"cwd":target.cwd,"cols":size.cols,"rows":size.rows,
        });
        match save(&index, &json!({"identity":target.identity}), true) {
            Ok(()) => {}
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|cause| cause.kind() == ErrorKind::AlreadyExists) =>
            {
                ensure!(
                    read(&index)?.is_some_and(|value| value["identity"] == target.identity),
                    "The terminal's captured source or directory changed. Create a new terminal."
                );
            }
            Err(error) => return Err(error),
        }
        let descriptor = Descriptor {
            directory,
            identity: target.identity,
            transport,
            binding,
        };
        let prior = descriptor.admission()?;
        if prior.is_none() {
            save(
                &descriptor.directory.join("descriptor.json"),
                &contents,
                false,
            )?;
        }
        if let Some(record) = prior.as_ref().filter(|record| !record["exited"].is_null()) {
            return Ok(Opened::Exited(saved_exit(record)));
        }
        let recovering = prior.is_some();
        // The command scope controls initial admission. A detached request
        // does not own the retained Linux session after this point.
        let (mut session, id) = descriptor
            .connect(prior.as_ref(), &Scope::default())
            .await?;
        let outcome = async {
            let record = if let Some(record) = prior {
                record
            } else {
                let record = json!({
                    "identity":descriptor.identity,"sessionId":id,"processId":Uuid::new_v4().to_string(),
                    "executorGeneration":descriptor.binding["executor_generation"],
                });
                save(&descriptor.directory.join("native.json"), &record, true)?;
                session.request(
                    "process/start",
                    json!({
                        "processId":record["processId"],"argv":["/bin/bash","--login"],
                        "cwd":file_uri(&target.cwd)?.as_str(),"env":json!({"TERM":"xterm-256color","COLORTERM":"truecolor"}),
                        "tty":true,"arg0":Value::Null,"sandbox":Value::Null,
                    }),
                ).await?;
                record
            };
            resize(&mut session, &record, size).await?;
            Ok::<_, anyhow::Error>(record)
        }.await;
        match outcome {
            Ok(record) => Ok(Opened::Live(Pty {
                descriptor,
                record,
                session,
                recovering,
            })),
            Err(error) => {
                session.close().await;
                Err(error)
            }
        }
    }

    pub async fn close(
        &self,
        terminal: &JsString,
        authority: &(JsString, JsString),
        worker: &JsString,
    ) -> Result<()> {
        let Some(index) = read(&self.index(terminal, authority))? else {
            return Ok(());
        };
        let identity = text(&index, "identity")?;
        ensure!(
            identity.len() == 64
                && identity
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Invalid Linux terminal cleanup identity."
        );
        let directory = self.0.join(identity);
        let Some(saved) = read(&directory.join("descriptor.json"))? else {
            ensure!(
                read(&directory.join("native.json"))?.is_none(),
                "Missing Linux terminal descriptor."
            );
            return Ok(());
        };
        let execution = checked("cantripOsExecutionSchema", &saved["execution"])?;
        let server = json!(authority.1);
        ensure!(
            saved["version"] == 1
                && saved["identity"] == identity
                && saved["terminalId"].as_js_string() == Some(terminal)
                && execution["scope"]["ownerId"].as_js_string() == Some(&authority.0)
                && execution["scope"]["workerId"].as_js_string() == Some(worker)
                && placement(
                    &saved["terminalId"],
                    &execution,
                    text(&saved, "cwd")?,
                    &server
                ) == identity,
            "Linux terminal cleanup authority changed."
        );
        let descriptor = Descriptor {
            directory,
            identity: identity.to_owned(),
            transport: Transport::from_value(&execution["transport"])?,
            binding: saved["binding"].clone(),
        };
        let Some(record) = descriptor
            .admission()?
            .filter(|record| record["exited"].is_null())
        else {
            return Ok(());
        };
        let (session, _) = descriptor.connect(Some(&record), &Scope::default()).await?;
        let mut pty = Pty {
            descriptor,
            record,
            session,
            recovering: true,
        };
        let result = async {
            let id = pty.process().to_owned();
            process::terminate(&mut pty.session, &id).await?;
            let page = pty.read(None, 0).await?;
            ensure!(
                page["exited"] == true && page["closed"] == true,
                "Linux terminal termination outcome is unknown."
            );
            pty.finish(&page["exitCode"], true)?;
            Ok(())
        }
        .await;
        pty.disconnect().await;
        result
    }
}

impl Descriptor {
    fn admission(&self) -> Result<Option<Value>> {
        let record = read(&self.directory.join("native.json"))?;
        if let Some(record) = &record {
            ensure!(
                record["identity"] == self.identity,
                "Linux terminal admission identity changed."
            );
            Uuid::parse_str(text(record, "processId")?)?;
            Uuid::parse_str(text(record, "sessionId")?)?;
        }
        Ok(record)
    }

    async fn connect(&self, prior: Option<&Value>, scope: &Scope) -> Result<(Session, String)> {
        let resume = prior.map(|record| text(record, "sessionId")).transpose()?;
        ensure!(
            prior.is_none_or(
                |record| record["executorGeneration"] == self.binding["executor_generation"]
            ),
            "The previous Linux terminal has an unknown outcome on another executor."
        );
        let (session, id) = Session::connect(
            &self.transport,
            self.binding.clone(),
            "cantrip-terminal",
            resume,
            scope,
        )
        .await?;
        if resume.is_some_and(|expected| id != expected) {
            session.close().await;
            anyhow::bail!("The Linux terminal session changed.");
        }
        Ok((session, id))
    }
}

impl Pty {
    fn process(&self) -> &str {
        self.record["processId"]
            .as_str()
            .expect("validated process identifier")
    }

    pub async fn read(&mut self, after: Option<u64>, wait: u64) -> Result<Value> {
        let request = json!({"processId":self.process(),"afterSeq":after,"maxBytes":READ_LIMIT,"waitMs":wait});
        self.session
            .request_with_timeout("process/read", request, CONTROL)
            .await
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        let id = self.process().to_owned();
        process::write(&mut self.session, &id, data).await
    }

    pub async fn resize(&mut self, size: TerminalSize) -> Result<()> {
        resize(&mut self.session, &self.record, size).await
    }

    pub async fn terminate(&mut self) -> Result<()> {
        let request = json!({"processId":self.process()});
        self.session
            .request_with_timeout("process/terminate", request, CONTROL)
            .await?;
        Ok(())
    }

    pub fn finish(&mut self, exit_code: &Value, interrupted: bool) -> Result<Value> {
        let outcome = if interrupted {
            "interrupted"
        } else if exit_code.is_null() {
            "unknown"
        } else {
            "exited"
        };
        self.record["exited"] = json!({"code":exit_code,"outcome":outcome});
        save(
            &self.descriptor.directory.join("native.json"),
            &self.record,
            false,
        )?;
        self.observe_outcome(outcome)?;
        Ok(saved_exit(&self.record))
    }

    pub fn observe_outcome(&self, state: &str) -> Result<()> {
        save(
            &self.descriptor.directory.join("outcome.json"),
            &json!({
                "identity":self.record["identity"],"processId":self.record["processId"],"state":state,
            }),
            false,
        )
    }

    pub async fn disconnect(self) {
        self.session.close().await;
    }
}

async fn resize(session: &mut Session, record: &Value, size: TerminalSize) -> Result<()> {
    session
        .request_with_timeout(
            "process/resize",
            json!({"processId":record["processId"],"cols":size.cols,"rows":size.rows}),
            CONTROL,
        )
        .await?;
    Ok(())
}

fn saved_exit(record: &Value) -> Value {
    let exit = &record["exited"];
    let outcome = exit["outcome"]
        .as_str()
        .unwrap_or(if exit["code"].is_null() {
            "unknown"
        } else {
            "exited"
        });
    let code = if outcome == "interrupted" {
        json!(197)
    } else if exit["code"].is_null() {
        json!(198)
    } else {
        exit["code"].clone()
    };
    json!({"status":"exited","exitCode":code,"signal":Value::Null,"executionOutcome":outcome})
}

fn read(path: &Path) -> Result<Option<Value>> {
    match read_bounded(path, 1024 * 1024) {
        Ok(raw) => Ok(Some(
            parse_json_text(std::str::from_utf8(&raw)?)
                .map_err(|_| anyhow!("Invalid saved Linux terminal record."))?,
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
