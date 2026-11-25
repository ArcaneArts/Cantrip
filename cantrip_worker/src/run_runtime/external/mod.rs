//! A bounded worker-owned lifetime for externally admitted sandboxed commands.
mod journal;
mod sandbox;

use super::{Control, process};
use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, ensure};
pub(crate) use cantrip_protocol::external_mcp::execution::CommandIdentity as Identity;
use cantrip_protocol::external_mcp::{
    execution::{
        CommandReceipt as Receipt, CommandSnapshot as Snapshot, CommandStart,
        CommandState as Phase, ExecutionPolicy,
    },
    orchestration::resource_id,
};
use cantrip_wire::{Value, value::json};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use uuid::Uuid;

const ACTIVE_LIMIT: usize = 8;
const RETAINED_OUTPUTS: usize = 64;
const OUTPUT_LIMIT: usize = 128 * 1024;
const MAX_RESPONSE_TEXT: usize = 20 * 1024;

pub(crate) struct Manager {
    data: PathBuf,
    slots: Mutex<IndexMap<Uuid, Arc<Slot>>>,
    lifetime: Scope,
}

fn status(snapshot: &Snapshot) -> Value {
    let mut value = Value::from_serialize(snapshot);
    value["terminal"] = json!(!snapshot.phase.active());
    value["outputTruncated"] = json!(snapshot.output_start != 0);
    value
}

struct Slot {
    identity: Identity,
    state: Mutex<Snapshot>,
    output: Mutex<String>,
    changed: watch::Sender<u64>,
    stop: watch::Sender<bool>,
}

impl Manager {
    pub(crate) fn new(data: &Path, lifetime: Scope) -> Self {
        Self {
            data: data.join("external-mcp-commands"),
            slots: Mutex::new(IndexMap::new()),
            lifetime,
        }
    }

    pub(crate) fn start(
        &self,
        identity: Identity,
        generation: &str,
        codex: &Path,
        root: &Path,
        policy: ExecutionPolicy,
        input: CommandStart,
    ) -> Result<Value> {
        self.lifetime.check()?;
        let id = resource_id(
            &identity.owner,
            &identity.principal,
            input.operation_id,
            "worker-command",
        );
        let fingerprint = cantrip_crypto::encode(&Sha256::digest(input.encode()?));
        let mut slots = self.slots.lock().unwrap();
        if let Some(receipt) = journal::read(&self.data, id)? {
            ensure!(
                receipt.identity == identity && receipt.fingerprint == fingerprint,
                "The command operation ID was already used for a different request."
            );
            return Ok(slots.get(&id).map_or_else(
                || status(&journal::retained(receipt, generation)),
                |slot| status(&slot.snapshot()),
            ));
        }
        ensure!(
            slots
                .values()
                .filter(|slot| slot.snapshot().phase.active())
                .count()
                < ACTIVE_LIMIT,
            "The worker is already running its maximum number of external commands."
        );
        if slots.len() >= RETAINED_OUTPUTS {
            let completed = slots
                .values()
                .find(|slot| !slot.snapshot().phase.active())
                .map(|slot| slot.snapshot().command_id)
                .context("External command output capacity")?;
            slots.shift_remove(&completed);
        }
        cantrip_host::files::private_directory(&self.data)?;
        journal::maintain(&self.data)?;
        let invocation = sandbox::prepare(&self.data, codex, root, policy, &input)?;
        let snapshot = Snapshot {
            command_id: id,
            phase: Phase::Starting,
            revision: 1,
            exit_code: None,
            signal: None,
            summary: "Accepted the external command.".to_owned(),
            output_start: 0,
            output_end: 0,
        };
        let receipt = Receipt {
            identity: identity.clone(),
            fingerprint,
            generation: generation.to_owned(),
            snapshot: snapshot.clone(),
        };
        journal::write(&self.data, &receipt, true)?;
        let slot = Arc::new(Slot {
            identity,
            state: Mutex::new(snapshot.clone()),
            output: Mutex::new(String::new()),
            changed: watch::channel(snapshot.revision).0,
            stop: watch::channel(false).0,
        });
        slots.insert(id, slot.clone());
        tokio::spawn(run(
            self.data.clone(),
            self.lifetime.clone(),
            slot,
            receipt,
            invocation,
            Duration::from_millis(input.timeout_ms),
        ));
        Ok(status(&snapshot))
    }

    pub(crate) async fn shutdown(&self) {
        let active: Vec<_> = self
            .slots
            .lock()
            .unwrap()
            .values()
            .filter(|slot| slot.snapshot().phase.active())
            .cloned()
            .collect();
        futures::future::join_all(active.iter().map(|slot| {
            slot.observe(Observation::Wait {
                after: None,
                timeout: Duration::from_secs(3),
            })
        }))
        .await;
    }

    pub(crate) async fn observe(
        &self,
        identity: &Identity,
        generation: &str,
        command_id: Uuid,
        operation: Observation,
    ) -> Result<Value> {
        let slot = self.slots.lock().unwrap().get(&command_id).cloned();
        let missing = || anyhow!("The command is unavailable for this integration and checkout.");
        if let Some(slot) = slot {
            ensure!(&slot.identity == identity, missing());
            return slot.observe(operation).await;
        }
        let receipt = journal::read(&self.data, command_id)?
            .filter(|receipt| &receipt.identity == identity)
            .ok_or_else(missing)?;
        let retained = journal::retained(receipt, generation);
        Ok(match operation {
            Observation::Output { offset, max_bytes } => page(&retained, "", offset, max_bytes)?,
            Observation::Wait { .. } => {
                let mut value = status(&retained);
                value["timedOut"] = json!(false);
                value
            }
            _ => status(&retained),
        })
    }
}

pub(crate) enum Observation {
    Status,
    Output {
        offset: Option<u64>,
        max_bytes: u16,
    },
    Wait {
        after: Option<u64>,
        timeout: Duration,
    },
    Cancel,
}

impl Slot {
    fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap().clone()
    }

    fn update(&self, modify: impl FnOnce(&mut Snapshot)) {
        let mut snapshot = self.state.lock().unwrap();
        modify(&mut snapshot);
        snapshot.revision += 1;
        self.changed.send_replace(snapshot.revision);
    }

    fn append(&self, fragment: &str) {
        if fragment.is_empty() {
            return;
        }
        let mut output = self.output.lock().unwrap();
        output.push_str(fragment);
        let dropped = output.ceil_char_boundary(output.len().saturating_sub(OUTPUT_LIMIT));
        if dropped > 0 {
            output.drain(..dropped);
        }
        self.update(|snapshot| {
            snapshot.output_end += fragment.len() as u64;
            snapshot.output_start += dropped as u64;
        });
    }

    async fn observe(&self, observation: Observation) -> Result<Value> {
        match observation {
            Observation::Status => Ok(status(&self.snapshot())),
            Observation::Output { offset, max_bytes } => {
                let output = self.output.lock().unwrap();
                page(&self.snapshot(), &output, offset, max_bytes)
            }
            Observation::Wait { after, timeout } => {
                let deadline = tokio::time::Instant::now() + timeout;
                let mut changed = self.changed.subscribe();
                loop {
                    let snapshot = self.snapshot();
                    let ready =
                        !snapshot.phase.active() || after.is_some_and(|r| snapshot.revision > r);
                    if ready || tokio::time::Instant::now() >= deadline {
                        let mut value = status(&snapshot);
                        value["timedOut"] = json!(!ready);
                        return Ok(value);
                    }
                    let _ = tokio::time::timeout_at(deadline, changed.changed()).await;
                }
            }
            Observation::Cancel => {
                {
                    let mut state = self.state.lock().unwrap();
                    if state.phase.active() && state.phase != Phase::Cancelling {
                        state.phase = Phase::Cancelling;
                        state.summary = "Stopping the external command.".to_owned();
                        state.revision += 1;
                        self.changed.send_replace(state.revision);
                        self.stop.send_replace(true);
                    }
                }
                Ok(status(&self.snapshot()))
            }
        }
    }
}

fn page(snapshot: &Snapshot, output: &str, offset: Option<u64>, limit: u16) -> Result<Value> {
    let start = offset
        .unwrap_or(snapshot.output_start)
        .max(snapshot.output_start);
    ensure!(
        start <= snapshot.output_end,
        "The output offset is beyond the recorded output."
    );
    let local = (start - snapshot.output_start) as usize;
    ensure!(
        output.is_char_boundary(local),
        "Use the returned nextOffset at a UTF-8 character boundary."
    );
    let end = output.floor_char_boundary((local + usize::from(limit)).min(output.len()));
    let available = &output[local..end];
    let text = if json!(available).stringify().len() > MAX_RESPONSE_TEXT {
        &available[..available.floor_char_boundary(3000)]
    } else {
        available
    };
    let mut result = status(&snapshot);
    result["summary"] = json!(format!("Read {} bytes of command output.", text.len()));
    result["text"] = json!(text);
    result["offset"] = json!(start);
    result["nextOffset"] = json!(start + text.len() as u64);
    Ok(result)
}

async fn run(
    data: PathBuf,
    lifetime: Scope,
    slot: Arc<Slot>,
    mut receipt: Receipt,
    invocation: sandbox::Prepared,
    timeout: Duration,
) {
    let control = Control {
        stop: slot.stop.subscribe(),
        force: Arc::new(AtomicBool::new(false)),
    };
    let command = process::run(
        &invocation.command,
        &invocation.environment,
        &control,
        Duration::from_millis(500),
        Some(timeout),
        |fragment| slot.append(fragment),
        || {
            slot.update(|snapshot| {
                if snapshot.phase == Phase::Starting {
                    snapshot.phase = Phase::Running;
                    snapshot.summary = "The worker is running the external command.".to_owned();
                }
            });
        },
    );
    tokio::pin!(command);
    let (result, interrupted) = tokio::select! {
        biased;
        _ = lifetime.stopped() => {
            control.force.store(true, Ordering::Release);
            slot.stop.send_replace(true);
            (command.await, true)
        }
        result = &mut command => (result, false),
    };
    let mut snapshot = slot.state.lock().unwrap();
    if let Ok(Some(exit)) = &result {
        snapshot.exit_code = exit.code;
        snapshot.signal = exit.signal.clone();
    }
    let (phase, summary) = if interrupted {
        (
            Phase::Interrupted,
            "The worker interrupted the external command.",
        )
    } else if snapshot.phase == Phase::Cancelling {
        (Phase::Cancelled, "The external command was cancelled.")
    } else {
        match result {
            Ok(Some(_)) => (Phase::Exited, "The external command exited."),
            Ok(None) => (
                Phase::Interrupted,
                "The external command was interrupted before launch.",
            ),
            Err(error) if error.code == "codex-environment-setup-timeout" => (
                Phase::TimedOut,
                "The external command reached its time limit.",
            ),
            Err(_) => (
                Phase::Failed,
                "The worker could not launch the sandboxed command.",
            ),
        }
    };
    snapshot.phase = phase;
    snapshot.summary = summary.to_owned();
    snapshot.revision += 1;
    receipt.snapshot = snapshot.clone();
    if journal::write(&data, &receipt, false).is_err() {
        snapshot
            .summary
            .push_str(" The terminal state could not be saved to the worker receipt.");
    }
    slot.changed.send_replace(snapshot.revision);
}
