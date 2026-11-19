//! Per-channel terminal tasks serialize input and detach with the channel.
use super::{Coordinator, id};
use crate::{
    encryption::Service,
    http::checked,
    run_runtime::Manager as Runs,
    terminal_services::interactive::{LinkTarget, LinkedTerminal, Shells},
};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::sync::{Arc, Mutex, Weak};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};
use uuid::Uuid;

pub(super) struct Adapter {
    shells: Arc<Shells>,
    runs: Arc<Runs>,
    encryption: Arc<Service>,
    tasks: Mutex<JoinSet<()>>,
}

pub(super) struct Terminal {
    pub token: Uuid,
    pub input: mpsc::Sender<Vec<u8>>,
    stop: watch::Sender<bool>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

struct Channel {
    gateway: Weak<Coordinator>,
    id: JsString,
    token: Uuid,
}

impl Adapter {
    pub fn new(shells: Arc<Shells>, runs: Arc<Runs>, encryption: Arc<Service>) -> Self {
        Self {
            shells,
            runs,
            encryption,
            tasks: Mutex::default(),
        }
    }

    pub fn open(
        self: &Arc<Self>,
        gateway: &Arc<Coordinator>,
        header: &Value,
        grant: &Value,
    ) -> anyhow::Result<Terminal> {
        let terminal = &grant["resource"]["resourceId"];
        let id = id(&header["channel"], "channelId");
        let target = LinkTarget::new(grant, format!("worker-link:{id}").into(), &self.encryption)?;
        let (input, inbound) = mpsc::channel(128);
        let (stop, stopped) = watch::channel(false);
        let token = Uuid::new_v4();
        let channel = Channel {
            gateway: Arc::downgrade(gateway),
            id: id.clone(),
            token,
        };
        let adapter = self.clone();
        let terminal = terminal.clone();
        let mut tasks = self.tasks.lock().unwrap();
        while tasks.try_join_next().is_some() {}
        tasks.spawn(async move {
            adapter
                .serve(channel, target, terminal, inbound, stopped)
                .await
        });
        Ok(Terminal { token, input, stop })
    }

    async fn serve(
        &self,
        channel: Channel,
        target: LinkTarget,
        terminal: Value,
        mut inbound: mpsc::Receiver<Vec<u8>>,
        mut stopped: watch::Receiver<bool>,
    ) {
        // Runs can publish observations while holding their runtime state.
        // Check terminal ownership here, outside the gateway state lock.
        if self.runs.owns_terminal(&terminal) {
            channel.fail("payload-invalid", "endpoint-disconnected");
            return;
        }
        let (events, mut output) = mpsc::channel(256);
        let (complete, finish) = oneshot::channel();
        let attached = tokio::select! {
            biased;
            _ = stopped.changed() => return,
            result = self.shells.attach_link(&target, self.encryption.clone(), events, complete) => result,
        };
        let view = match attached {
            Ok(LinkedTerminal::Attached(view)) => view,
            Ok(LinkedTerminal::Exited(result)) => {
                channel.ready();
                channel.ended(result);
                return;
            }
            Err(_) => {
                channel.fail("io-error", "endpoint-disconnected");
                return;
            }
        };
        channel.ready();
        // Display drops its output sender after settling completion. Drain the
        // buffered output before the terminal exit message.
        loop {
            tokio::select! {
                biased;
                _ = stopped.changed() => break,
                next = output.recv() => match next {
                    Some(event) => channel.output(event),
                    None => {
                        match finish.await {
                            Ok(Ok(value)) if value["status"] == "exited" => channel.ended(value),
                            _ => channel.fail("io-error", "endpoint-disconnected"),
                        }
                        break;
                    }
                },
                next = inbound.recv() => {
                    let Some(payload) = next else { break; };
                    let message = {
                        std::str::from_utf8(&payload)
                            .ok()
                            .and_then(|text| parse_json_text(text.strip_prefix('\u{feff}').unwrap_or(text)).ok())
                            .and_then(|message| checked("terminalClientMessageSchema", &message).ok())
                    };
                    let Some(message) = message else {
                        channel.fail("payload-invalid", "protocol-error");
                        break;
                    };
                    if self.runs.owns_terminal(&terminal) {
                        channel.fail("payload-invalid", "protocol-error");
                        break;
                    }
                    let result = tokio::select! {
                        biased;
                        _ = stopped.changed() => break,
                        result = self.shells.write_link(&target, &message, &self.encryption) => result,
                    };
                    if result.is_err() {
                        channel.fail("payload-invalid", "protocol-error");
                        break;
                    }
                    channel.credit(payload.len());
                }
            }
        }
        drop(view);
    }

    pub async fn close(&self) {
        let mut tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        while tasks.join_next().await.is_some() {}
    }
}

impl Channel {
    fn ready(&self) {
        if let Some(gateway) = self.gateway.upgrade() {
            gateway.terminal_ready(&self.id, self.token);
        }
    }

    fn output(&self, event: Value) {
        if let Some(gateway) = self.gateway.upgrade() {
            if let Ok(event) = checked("terminalServerMessageSchema", &event) {
                gateway.terminal_output(
                    &self.id,
                    self.token,
                    event.stringify().into_bytes(),
                    false,
                );
            } else {
                gateway.terminal_error(&self.id, self.token, "io-error", "protocol-error");
            }
        }
    }

    fn ended(&self, mut result: Value) {
        if let Value::Object(fields) = &mut result {
            fields.shift_remove("status");
        }
        result["type"] = json!("exit");
        if let Some(gateway) = self.gateway.upgrade() {
            if let Ok(message) = checked("terminalServerMessageSchema", &result) {
                gateway.terminal_output(
                    &self.id,
                    self.token,
                    message.stringify().into_bytes(),
                    true,
                );
            } else {
                gateway.terminal_error(&self.id, self.token, "io-error", "protocol-error");
            }
        }
    }

    fn credit(&self, bytes: usize) {
        if let Some(gateway) = self.gateway.upgrade() {
            gateway.terminal_credit(&self.id, self.token, bytes);
        }
    }

    fn fail(&self, error: &str, close: &str) {
        if let Some(gateway) = self.gateway.upgrade() {
            gateway.terminal_error(&self.id, self.token, error, close);
        }
    }
}
