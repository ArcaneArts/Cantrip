use super::replay::Replay;
use crate::{
    connection::Outbound, encryption::Service, protected_content::protect_surface_content,
};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::TerminalSize;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::oneshot;

pub(super) struct Attachment {
    pub(super) complete: oneshot::Sender<Result<Value>>,
    pub(super) outbound: Arc<Outbound>,
    pub(super) request_id: JsString,
    pub(super) epoch: u64,
    pub(super) binding: Value,
    pub(super) encryption: Arc<Service>,
    pub(super) owner: JsString,
    pub(super) discard: bool,
    pub(super) sequence: u64,
}

pub(super) fn detached() -> Value {
    json!({"status":"detached"})
}

impl Attachment {
    fn emit(&self, event: Value) -> Result<()> {
        let (owner, server) = self.encryption.bound_identity()?;
        anyhow::ensure!(
            owner == self.owner && server == self.binding["serverId"],
            "Terminal owner changed."
        );
        anyhow::ensure!(
            self.outbound.terminal_event(
                self.epoch,
                json!({"kind":"event","requestId":self.request_id,"event":event}),
            )?,
            "Terminal output attachment closed."
        );
        Ok(())
    }

    fn output(&mut self, data: &JsString) -> Result<()> {
        if self.discard {
            return Ok(());
        }
        let mut offset = 0;
        loop {
            let units = data.units();
            let mut end = (offset + 32 * 1024).min(units.len());
            if end < units.len()
                && (0xd800..=0xdbff).contains(&units[end - 1])
                && (0xdc00..=0xdfff).contains(&units[end])
            {
                end -= 1;
            }
            self.binding["sequence"] = json!(self.sequence);
            let protected = protect_surface_content(
                &self.encryption,
                &self.binding,
                &json!({"type":"terminal.output","data":JsString::new(units[offset..end].to_vec())}),
                "terminalOutputContentSchema",
            )?;
            self.emit(json!({
                "type":"terminal.output","operationId":self.binding["operationId"],
                "sequence":self.sequence,"protectedData":protected,
            }))?;
            self.sequence += 1;
            offset = end;
            if offset == units.len() {
                return Ok(());
            }
        }
    }
}

pub(super) struct Display {
    pub(super) replay: Replay,
    views: HashMap<JsString, Attachment>,
    pub(super) exited: Option<Value>,
}

impl Display {
    pub(super) fn new(size: TerminalSize) -> Self {
        Self {
            replay: Replay::new(size),
            views: HashMap::new(),
            exited: None,
        }
    }

    pub(super) fn reset(&mut self, size: TerminalSize) {
        self.replay = Replay::new(size);
        self.exited = None;
    }

    pub(super) fn attach(&mut self, id: &JsString, mut view: Attachment) -> Result<Option<Value>> {
        if let Some(exited) = &self.exited {
            return Ok(Some(exited.clone()));
        }
        anyhow::ensure!(
            !self.views.contains_key(id),
            "Terminal attachment already exists."
        );
        if !view.discard {
            view.output(&self.replay.attachment())?;
        }
        view.emit(json!({"type":"terminal.ready"}))?;
        self.views.insert(id.clone(), view);
        Ok(None)
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
        for (_, view) in self.views.extract_if(|_, view| view.output(&text).is_err()) {
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
