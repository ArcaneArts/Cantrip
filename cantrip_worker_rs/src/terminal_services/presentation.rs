use super::{Recovery, Resize, replay::Replay};
use crate::{
    connection::Outbound, encryption::Service, protected_content::protect_surface_content,
};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::TerminalSize;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, oneshot, watch};

pub(super) struct Attachment {
    pub(super) complete: oneshot::Sender<Result<Value>>,
    pub(super) transport: Transport,
    pub(super) binding: Value,
    pub(super) encryption: Arc<Service>,
    pub(super) owner: JsString,
    pub(super) discard: bool,
    pub(super) sequence: u64,
}

pub(super) enum Transport {
    Command {
        outbound: Arc<Outbound>,
        request_id: JsString,
        epoch: u64,
    },
    WorkerLink(mpsc::Sender<Value>),
}

pub(super) fn detached() -> Value {
    json!({"status":"detached"})
}

impl Attachment {
    fn emit(&self, mut event: Value) -> Result<()> {
        let (owner, server) = self.encryption.bound_identity()?;
        anyhow::ensure!(
            owner == self.owner && server == self.binding["serverId"],
            "Terminal owner changed."
        );
        match &self.transport {
            Transport::Command {
                outbound,
                request_id,
                epoch,
            } => {
                anyhow::ensure!(
                    outbound.send_for_epoch(
                        *epoch,
                        json!({"kind":"event","requestId":request_id,"event":event}),
                    )?,
                    "Terminal output attachment closed."
                );
            }
            Transport::WorkerLink(events) => {
                event["type"] = json!(if event["type"] == "terminal.ready" {
                    "ready"
                } else {
                    "output"
                });
                events
                    .try_send(event)
                    .map_err(|_| anyhow!("Terminal output attachment closed."))?;
            }
        }
        Ok(())
    }

    fn output(&mut self, data: &JsString, mut hydration: Option<Value>) -> Result<()> {
        if self.discard {
            return Ok(());
        }
        let chunk = match self.transport {
            Transport::Command { .. } => 32 * 1024,
            // A JSON-escaped UTF-16 unit can occupy six bytes before
            // encryption and Base64 expansion. Keep that case frameable.
            Transport::WorkerLink(_) => 8 * 1024,
        };
        let chunks = output_chunks(data, chunk);
        if let Some(metadata) = &mut hydration {
            metadata["snapshotCharacters"] = json!(data.len());
            metadata["snapshotChunks"] = json!(chunks.clone().count());
        }
        for units in chunks {
            self.binding["sequence"] = json!(self.sequence);
            let protected = protect_surface_content(
                &self.encryption,
                &self.binding,
                &json!({"type":"terminal.output","data":JsString::new(units.to_vec())}),
                "terminalOutputContentSchema",
            )?;
            let mut event = json!({
                "type":"terminal.output","operationId":self.binding["operationId"],
                "sequence":self.sequence,"protectedData":protected,
            });
            if let Some(metadata) = hydration.take() {
                event["hydration"] = metadata;
            }
            self.emit(event)?;
            self.sequence += 1;
        }
        Ok(())
    }
}

fn output_chunks(data: &JsString, max: usize) -> impl Iterator<Item = &[u16]> + Clone {
    let units = data.units();
    let mut offset = Some(0);
    std::iter::from_fn(move || {
        let start = offset?;
        let mut end = (start + max).min(units.len());
        if end < units.len()
            && (0xd800..=0xdbff).contains(&units[end - 1])
            && (0xdc00..=0xdfff).contains(&units[end])
        {
            end -= 1;
        }
        offset = (end < units.len()).then_some(end);
        Some(&units[start..end])
    })
}

pub(super) enum Attaching {
    Complete(Option<Value>),
    Redrawing {
        view: Box<Attachment>,
        result: watch::Receiver<Option<Recovery>>,
    },
}

pub(super) struct Display {
    pub(super) replay: Replay,
    views: HashMap<JsString, Attachment>,
    resize: Option<mpsc::WeakSender<Resize>>,
    recovery: Option<watch::Receiver<Option<Recovery>>>,
    pub(super) exited: Option<Value>,
}

impl Display {
    pub(super) fn new(size: TerminalSize, process_generation: u64) -> Self {
        Self {
            replay: Replay::new(size, process_generation),
            views: HashMap::new(),
            resize: None,
            recovery: None,
            exited: None,
        }
    }

    pub(super) fn reset(&mut self, size: TerminalSize, process_generation: u64) {
        self.replay = Replay::new(size, process_generation);
        self.resize = None;
        self.recovery = None;
        self.exited = None;
    }

    pub(super) fn bind_resize(&mut self, resize: &mpsc::Sender<Resize>) {
        self.resize = Some(resize.downgrade());
    }

    fn request_recovery(&mut self) -> &watch::Receiver<Option<Recovery>> {
        self.recovery.get_or_insert_with(|| {
            let (done, result) = watch::channel(None);
            if let Some(resize) = self.resize.as_ref().and_then(mpsc::WeakSender::upgrade) {
                if let Err(mpsc::error::TrySendError::Full(_)) =
                    resize.try_send(Resize::Redraw(done.clone()))
                {
                    done.send_replace(Some(Recovery::ResizeFailed));
                }
            }
            result
        })
    }

    pub(super) fn attach(&mut self, id: &JsString, mut view: Attachment) -> Result<Attaching> {
        if let Some(exited) = &self.exited {
            return Ok(Attaching::Complete(Some(exited.clone())));
        }
        anyhow::ensure!(
            !self.views.contains_key(id),
            "Terminal attachment already exists."
        );
        if !view.discard {
            let with_metadata = matches!(view.transport, Transport::WorkerLink(_));
            let mut snapshot = self.replay.attachment(with_metadata);
            if snapshot.needs_redraw {
                let result = self.request_recovery();
                let recovery = *result.borrow();
                let recovery = match recovery {
                    Some(recovery) => recovery,
                    None if result.has_changed().is_err() => {
                        (*result.borrow()).unwrap_or(Recovery::NoLiveProcess)
                    }
                    None => {
                        return Ok(Attaching::Redrawing {
                            view: Box::new(view),
                            result: result.clone(),
                        });
                    }
                };
                if let Some(metadata) = &mut snapshot.metadata {
                    recovery.describe(metadata);
                }
            } else if let Some(metadata) = &mut snapshot.metadata {
                if metadata["format"] == "legacy-raw" {
                    metadata["recovery"] = json!("not-needed");
                }
            }
            view.output(&snapshot.data, snapshot.metadata)?;
        }
        view.emit(json!({"type":"terminal.ready"}))?;
        self.views.insert(id.clone(), view);
        Ok(Attaching::Complete(None))
    }

    pub(super) fn detach(&mut self, id: &JsString) -> Option<Value> {
        let view = self.views.remove(id)?;
        let mut binding = view.binding;
        binding["direction"] = json!("input");
        let _ = view.complete.send(Ok(detached()));
        Some(binding)
    }

    pub(super) fn write(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.replay.write(text);
        let text = JsString::from(text);
        for (_, view) in self
            .views
            .extract_if(|_, view| view.output(&text, None).is_err())
        {
            let _ = view
                .complete
                .send(Err(anyhow!("Terminal output attachment closed.")));
        }
    }

    pub(super) fn finish(&mut self, result: Value) {
        for (_, view) in self.views.drain() {
            let _ = view.complete.send(Ok(result.clone()));
        }
        self.exited = Some(result);
    }
}
