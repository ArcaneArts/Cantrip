//! Attach data-plane views to the same owned PTY and replay used by control views.
use super::{Attachment, Display, Key, Shells, Transport, authority, binding, not_running, size};
use crate::{encryption::Service, protected_content::SurfaceStreamReplayGuard};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

pub(crate) struct LinkTarget {
    key: Key,
    id: JsString,
    binding: Value,
}

pub(crate) enum LinkedTerminal {
    Attached(LinkView),
    Exited(Value),
}

pub(crate) struct LinkView {
    display: Arc<Mutex<Display>>,
    id: JsString,
    binding: Value,
    replay: Arc<Mutex<SurfaceStreamReplayGuard>>,
}

impl Drop for LinkView {
    fn drop(&mut self) {
        self.display.lock().unwrap().detach(&self.id);
        self.replay.lock().unwrap().release(&self.binding);
    }
}

impl LinkTarget {
    pub(crate) fn new(grant: &Value, id: JsString, encryption: &Service) -> Result<Self> {
        let resource = &grant["resource"];
        let operation = checked(
            "workerLinkTerminalGrantRequestSchema",
            &json!({"operationId":resource["attachmentId"]}),
        )?;
        let command = json!({
            "serverId":grant["identity"]["serverId"],
            "terminalId":resource["resourceId"],
            "operationId":operation["operationId"],
        });
        Self::for_operation(&grant["identity"]["ownerId"], &command, id, encryption)
    }

    pub(crate) fn direct(
        owner: &Value,
        terminal: &Value,
        server: &Value,
        operation: JsString,
        encryption: &Service,
    ) -> Result<Self> {
        let command = json!({"serverId":server,"terminalId":terminal,"operationId":operation});
        Self::for_operation(
            owner,
            &command,
            format!("direct:{}", uuid::Uuid::new_v4()).into(),
            encryption,
        )
    }

    fn for_operation(
        owner: &Value,
        command: &Value,
        id: JsString,
        encryption: &Service,
    ) -> Result<Self> {
        let key = Shells::key(command, encryption)?;
        anyhow::ensure!(
            owner.as_js_string() == Some(&key.authority.0),
            "Terminal owner changed."
        );
        Ok(Self {
            key,
            id,
            binding: binding(command, "input"),
        })
    }
}

impl Shells {
    pub(crate) async fn attach_link(
        &self,
        target: &LinkTarget,
        encryption: Arc<Service>,
        events: mpsc::Sender<Value>,
        complete: oneshot::Sender<Result<Value>>,
    ) -> Result<LinkedTerminal> {
        let _transition = self.transition().await;
        let key = &target.key;
        anyhow::ensure!(
            authority(&encryption)? == key.authority,
            "Terminal owner changed."
        );
        let display =
            if let Some(service) = self.services.view(&key.terminal, &key.authority).await? {
                anyhow::ensure!(service.cwd.is_some(), "Terminal service is stopping.");
                service.state.lock().unwrap().display.clone()
            } else {
                let inner = self.inner.lock().await;
                inner
                    .entries
                    .get(key)
                    .ok_or_else(|| not_running(key))?
                    .state
                    .clone()
            };
        let mut output = target.binding.clone();
        output["direction"] = json!("output");
        let view = Attachment {
            complete,
            transport: Transport::WorkerLink(events),
            binding: output,
            encryption,
            owner: key.authority.0.clone(),
            discard: false,
            sequence: 0,
        };
        let exited = display.lock().unwrap().attach(&target.id, view)?;
        Ok(match exited {
            Some(result) => LinkedTerminal::Exited(result),
            None => LinkedTerminal::Attached(LinkView {
                display,
                id: target.id.clone(),
                binding: target.binding.clone(),
                replay: self.replay.clone(),
            }),
        })
    }

    pub(crate) async fn write_link(
        &self,
        target: &LinkTarget,
        message: &Value,
        encryption: &Service,
    ) -> Result<()> {
        anyhow::ensure!(
            authority(encryption)? == target.key.authority,
            "Terminal owner changed."
        );
        if message["type"] == "resize" {
            return self.resize(&target.key, size(message)).await;
        }
        anyhow::ensure!(
            message["operationId"] == target.binding["operationId"],
            "Terminal WorkerLink input targets another operation."
        );
        let command = json!({
            "serverId":target.binding["serverId"],"terminalId":target.key.terminal,
            "operationId":target.binding["operationId"],"sequence":message["sequence"],
            "protectedData":message["protectedData"],
        });
        self.input(&command, &target.key, encryption, false).await?;
        Ok(())
    }
}
