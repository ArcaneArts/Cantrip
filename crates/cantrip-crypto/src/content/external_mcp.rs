//! One encrypted exchange on an authorized external MCP WorkerLink channel.
use crate::{
    HpkeKeyPair, Zeroizing, decryption_error,
    hpke::{unwrap_key_bytes, wrap_key_bytes},
    open_aes_gcm, random_bytes, seal_aes_gcm,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};

const NONCE_BYTES: usize = 12;
const MAX_WRAPPED_KEY_BYTES: usize = 768;
const MAX_PLAINTEXT_BYTES: usize = 32 * 1024;

/// Both inputs come from the WorkerLink grant and its accepted channel.
pub struct Exchange {
    context: Value,
}

impl Exchange {
    pub fn new(binding: &Value, channel: &Value) -> Self {
        let identity = &binding["identity"];
        Self {
            context: json!({
                "purpose":"cantrip-worker-link-external-mcp-v1",
                "server":identity["serverId"],"serverGeneration":identity["serverGeneration"],
                "owner":identity["ownerId"],"integration":identity["accountSessionId"],
                "client":identity["clientInstanceId"],"worker":identity["workerId"],
                "workerGeneration":identity["workerProcessGeneration"],
                "session":binding["sessionId"],"grant":binding["grantId"],
                "grantGeneration":binding["grantGeneration"],
                "project":binding["resource"]["resourceId"],"placement":binding["resource"]["attachmentId"],
                "channel":channel["channelId"],"connection":channel["connectionId"],
            }),
        }
    }

    fn aad(&self, field: &str) -> Vec<u8> {
        json!({"channel":self.context,"field":field})
            .stringify()
            .into_bytes()
    }

    pub fn seal_request(
        &self,
        worker_key: &Value,
        plaintext: &[u8],
    ) -> Result<(Zeroizing<Vec<u8>>, Vec<u8>)> {
        let key = random_bytes(32)?;
        let wrapped = wrap_key_bytes(&key, worker_key, &self.aad("request-key"))?.stringify();
        ensure!(
            wrapped.len() <= MAX_WRAPPED_KEY_BYTES,
            "Wrapped MCP key exceeds its limit."
        );
        let mut record = (wrapped.len() as u16).to_be_bytes().to_vec();
        record.extend_from_slice(wrapped.as_bytes());
        record.extend_from_slice(&self.seal(&key, plaintext, "request")?);
        Ok((key, record))
    }

    pub fn open_request(
        &self,
        worker: &HpkeKeyPair,
        record: &[u8],
    ) -> Result<(Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>)> {
        let (length, record) = record
            .split_first_chunk::<2>()
            .context("Invalid MCP key record.")?;
        let length = u16::from_be_bytes(*length) as usize;
        ensure!(
            length <= MAX_WRAPPED_KEY_BYTES,
            "Wrapped MCP key exceeds its limit."
        );
        let (wrapped, ciphertext) = record
            .split_at_checked(length)
            .context("Invalid MCP key record.")?;
        let wrapped =
            parse_json_text(std::str::from_utf8(wrapped)?).map_err(|_| decryption_error())?;
        let key = unwrap_key_bytes(&wrapped, worker, &self.aad("request-key"))?;
        let plaintext = self.open(&key, ciphertext, "request")?;
        Ok((key, plaintext))
    }

    pub fn seal_response(&self, key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        self.seal(key, plaintext, "response")
    }

    pub fn open_response(&self, key: &[u8], record: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        self.open(key, record, "response")
    }

    fn seal(&self, key: &[u8], plaintext: &[u8], field: &str) -> Result<Vec<u8>> {
        ensure!(
            plaintext.len() <= MAX_PLAINTEXT_BYTES,
            "MCP payload exceeds its limit."
        );
        let nonce = random_bytes(NONCE_BYTES)?;
        let ciphertext = seal_aes_gcm(key, &nonce, plaintext, &self.aad(field))?;
        let mut record = nonce.to_vec();
        record.extend_from_slice(&ciphertext);
        Ok(record)
    }

    fn open(&self, key: &[u8], record: &[u8], field: &str) -> Result<Zeroizing<Vec<u8>>> {
        let (nonce, ciphertext) = record
            .split_first_chunk::<NONCE_BYTES>()
            .ok_or_else(decryption_error)?;
        ensure!(
            ciphertext.len() <= MAX_PLAINTEXT_BYTES + 16,
            "MCP payload exceeds its limit."
        );
        open_aes_gcm(key, nonce, ciphertext, &self.aad(field))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_authenticates_worker_key_grant_channel_and_direction() {
        let worker = HpkeKeyPair::generate();
        let binding = json!({"grantId":"grant-a","identity":json!({"workerProcessGeneration":"generation-a"})});
        let channel = json!({"channelId":"channel-a","connectionId":"connection-a"});
        let exchange = Exchange::new(&binding, &channel);
        let body = b"request private body";
        let (bridge_key, mut request) = exchange.seal_request(&worker.public_key(), body).unwrap();
        assert!(!request.windows(body.len()).any(|window| window == body));
        let (worker_key, opened) = exchange.open_request(&worker, &request).unwrap();
        assert_eq!(opened.as_slice(), body);
        assert!(
            exchange
                .open_request(&HpkeKeyPair::generate(), &request)
                .is_err()
        );
        let another_grant = Exchange::new(
            &json!({"grantId":"grant-b","identity":binding["identity"]}),
            &channel,
        );
        assert!(another_grant.open_request(&worker, &request).is_err());
        let another_channel = Exchange::new(
            &binding,
            &json!({"channelId":"channel-b","connectionId":"connection-a"}),
        );
        assert!(another_channel.open_request(&worker, &request).is_err());
        let response = exchange
            .seal_response(&worker_key, b"response private body")
            .unwrap();
        assert_eq!(
            exchange
                .open_response(&bridge_key, &response)
                .unwrap()
                .as_slice(),
            b"response private body"
        );
        assert!(exchange.open(&bridge_key, &response, "request").is_err());
        *request.last_mut().unwrap() ^= 1;
        assert!(exchange.open_request(&worker, &request).is_err());
    }
}
