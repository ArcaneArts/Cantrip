use super::Coordinator;
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::external_mcp::Exchange;
use cantrip_protocol::external_mcp::orchestration::Call;
use cantrip_wire::{JsString, Value, value::json};
use std::sync::Arc;
use tokio::task::AbortHandle;
use uuid::Uuid;

mod orchestration;
pub(super) use orchestration::Client;

pub(super) struct Channel {
    token: Uuid,
    task: Option<AbortHandle>,
    request: Request,
}

#[derive(Clone)]
struct Request {
    binding: Value,
    channel: Value,
    descriptor: Value,
    encryption: Arc<crate::encryption::Service>,
}

impl Channel {
    pub fn new(
        grant: &Value,
        channel: &Value,
        encryption: Arc<crate::encryption::Service>,
    ) -> Self {
        let binding = grant["binding"].clone();
        Self {
            token: Uuid::new_v4(),
            task: None,
            request: Request {
                binding,
                channel: channel.clone(),
                descriptor: grant["externalMcp"].clone(),
                encryption,
            },
        }
    }

    pub fn token(&self) -> Uuid {
        self.token
    }

    pub fn submit(
        &mut self,
        coordinator: &Arc<Coordinator>,
        id: JsString,
        record: &[u8],
    ) -> Result<(), &'static str> {
        if self.task.is_some() {
            return Err("protocol-error");
        }
        let request = self.request.clone();
        let client = coordinator.external_mcp.get().cloned();
        let weak = Arc::downgrade(coordinator);
        let token = self.token;
        let record = record.to_vec();
        self.task = Some(
            tokio::spawn(async move {
                let result = request.reply(client.as_ref(), &record).await;
                if let Some(coordinator) = weak.upgrade() {
                    coordinator.update_channels(|channels| {
                        channels.external_mcp_reply(&id, token, result)
                    });
                }
            })
            .abort_handle(),
        );
        Ok(())
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

impl Request {
    async fn reply(&self, client: Option<&Client>, record: &[u8]) -> Result<Vec<u8>, &'static str> {
        let exchange = Exchange::new(&self.binding, &self.channel);
        let (key, plaintext) = self
            .encryption
            .open_external_mcp(
                &self.binding,
                &self.descriptor["workerPrincipalId"],
                &exchange,
                record,
            )
            .map_err(|_| "protocol-error")?;
        let result = if self.descriptor["tool"].is_null() {
            if plaintext.as_slice() != b"worker-context" {
                return Err("protocol-error");
            }
            self.context()
        } else {
            match self.run(client, &plaintext).await {
                Ok(result) => result,
                Err(error) => json!({
                    "projectId":self.binding["resource"]["resourceId"],
                    "summary":format!("{error}"),"isError":true,
                }),
            }
        };
        exchange
            .seal_response(&key, result.stringify().as_bytes())
            .map_err(|_| "protocol-error")
    }

    async fn run(&self, client: Option<&Client>, plaintext: &[u8]) -> Result<Value> {
        let call =
            Call::decode(plaintext).map_err(|_| anyhow::anyhow!("Invalid external MCP input."))?;
        call.validate().map_err(anyhow::Error::msg)?;
        let selector = call.selector();
        ensure!(
            self.descriptor["tool"] == Value::from_serialize(&call.tool())
                && self.descriptor["chatId"] == Value::from_serialize(&selector.chat_id)
                && self.binding["resource"]["resourceId"] == call.project().to_string(),
            "The external MCP call does not match its WorkerLink grant."
        );
        client
            .context("Cantrip worker orchestration is unavailable.")?
            .run(&self.binding, self.encryption.clone(), call)
            .await
    }

    fn context(&self) -> Value {
        json!({
            "summary":"Read execution context from the assigned worker.",
            "projectId":self.binding["resource"]["resourceId"],
            "worktreeId":self.binding["resource"]["attachmentId"],
            "workerId":self.binding["identity"]["workerId"],
            "processGeneration":self.binding["identity"]["workerProcessGeneration"],
            "platform":std::env::consts::OS,
            "architecture":std::env::consts::ARCH,
        })
    }
}
