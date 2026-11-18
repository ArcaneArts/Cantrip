//! Bridge native history to the real worker-held encryption grants. Execution
//! capture/projector orchestration is delivered separately; no new capability
//! is advertised by the source-journal implementation alone.
pub mod client;
pub mod preparation;
pub mod projector;
pub mod recovery;
pub mod render;
use crate::encryption::Service;
use anyhow::{Result, anyhow};
use cantrip_history::content::{Encryption, Material};
use cantrip_wire::JsString;
use std::sync::Arc;

pub struct EncryptionService(pub Arc<Service>);
impl Encryption for EncryptionService {
    fn identity(&self) -> Result<(JsString, JsString)> {
        // A grant-free identity read also works while recovering headers before
        // historical content keys are available. Content always requires a grant.
        let (owner, server) = self.0.bound_identity()?;
        Ok((
            owner,
            server
                .as_js_string()
                .ok_or_else(|| anyhow!("Native history has no verified server identity."))?
                .clone(),
        ))
    }
    fn material(&self, revision: Option<u64>) -> Result<Material> {
        let grant = self.0.bound_component("chat-content", revision)?;
        Ok(Material {
            owner_id: grant.owner_id,
            server_id: grant
                .server_id
                .as_js_string()
                .ok_or_else(|| anyhow!("Native history has no verified server identity."))?
                .clone(),
            key_revision: grant.component.key_revision,
            key: grant.component.key,
        })
    }
}
