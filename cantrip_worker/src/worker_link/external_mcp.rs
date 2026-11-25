use cantrip_crypto::content::external_mcp::Exchange;
use cantrip_wire::{Value, value::json};
use std::sync::Arc;

pub(super) struct Channel {
    binding: Value,
    worker_principal: Value,
    exchange: Exchange,
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
            exchange: Exchange::new(&binding, channel),
            binding,
            worker_principal: grant["externalMcp"]["workerPrincipalId"].clone(),
            encryption,
        }
    }

    pub fn reply(&self, record: &[u8]) -> Result<Vec<u8>, &'static str> {
        let (key, plaintext) = self
            .encryption
            .open_external_mcp(
                &self.binding,
                &self.worker_principal,
                &self.exchange,
                record,
            )
            .map_err(|_| "protocol-error")?;
        if plaintext.as_slice() != b"worker-context" {
            return Err("protocol-error");
        }
        let result = json!({
            "summary":"Read execution context from the assigned worker.",
            "projectId":self.binding["resource"]["resourceId"],
            "worktreeId":self.binding["resource"]["attachmentId"],
            "workerId":self.binding["identity"]["workerId"],
            "processGeneration":self.binding["identity"]["workerProcessGeneration"],
            "platform":std::env::consts::OS,
            "architecture":std::env::consts::ARCH,
        });
        self.exchange
            .seal_response(&key, result.stringify().as_bytes())
            .map_err(|_| "protocol-error")
    }
}
