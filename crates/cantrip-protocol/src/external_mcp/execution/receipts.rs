//! Scoped worker command identity and retained receipt metadata.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandIdentity {
    pub owner: String,
    pub principal: String,
    pub project: String,
    pub worktree: String,
    pub worker: String,
    pub server: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandState {
    Starting,
    Running,
    Cancelling,
    Exited,
    Cancelled,
    TimedOut,
    Interrupted,
    Failed,
}

impl CommandState {
    pub fn active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Cancelling)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSnapshot {
    pub command_id: Uuid,
    #[serde(rename = "state")]
    pub phase: CommandState,
    pub revision: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub summary: String,
    pub output_start: u64,
    pub output_end: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub identity: CommandIdentity,
    pub fingerprint: String,
    pub generation: String,
    pub snapshot: CommandSnapshot,
}

impl CommandReceipt {
    pub fn decode(bytes: &[u8]) -> serde_json::Result<Self> {
        serde_json::from_slice(bytes)
    }

    pub fn encode(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(self)
    }
}
