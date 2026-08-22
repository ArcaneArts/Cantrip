use std::env;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connection::{ConnectionError, broker_post, load_connection};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandContext {
    codex_thread_id: Option<String>,
    terminal_id: Option<String>,
    cwd: Option<String>,
    selection: String,
}

impl CommandContext {
    pub fn detect(selection: &str) -> Self {
        Self {
            codex_thread_id: nonempty_environment("CODEX_THREAD_ID"),
            terminal_id: nonempty_environment("CANTRIP_TERMINAL_ID"),
            cwd: env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
            selection: selection.to_owned(),
        }
    }
}

fn nonempty_environment(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Serialize)]
pub struct CommandRequest<'a> {
    pub command: &'a str,
    pub context: CommandContext,
    pub arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub summary: String,
    #[serde(default)]
    pub target: Option<Value>,
    #[serde(default)]
    pub worktree_id: Option<String>,
    #[serde(default)]
    pub continuation_scheduled: bool,
    #[serde(default)]
    pub mutated: bool,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug)]
pub struct CommandError {
    pub exit_code: u8,
    pub message: String,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<ConnectionError> for CommandError {
    fn from(error: ConnectionError) -> Self {
        let exit_code = match &error {
            ConnectionError::EnvironmentMissing | ConnectionError::Read { .. } => 3,
            ConnectionError::BrokerStatus { code, status, .. } => match code.as_deref() {
                Some("context-not-found") => 3,
                Some("ambiguous") | Some("not-found") => 4,
                Some("conflict") => 5,
                Some("unavailable") => 6,
                _ => match status {
                    404 => 4,
                    409 => 5,
                    500..=599 => 6,
                    _ => 2,
                },
            },
            ConnectionError::Broker(_) | ConnectionError::Invalid(_) => 6,
        };
        Self {
            exit_code,
            message: error.to_string(),
        }
    }
}

pub fn execute(
    command: &str,
    arguments: Value,
    context_selection: &str,
) -> Result<CommandResult, CommandError> {
    let connection = load_connection()?;
    let request = CommandRequest {
        command,
        context: CommandContext::detect(context_selection),
        arguments,
    };
    broker_post(&connection, "/v1/execute", &request).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::CommandContext;

    #[test]
    fn detected_context_serializes_with_wire_names() {
        let value = serde_json::to_value(CommandContext {
            codex_thread_id: Some("thread-1".to_string()),
            terminal_id: Some("terminal-1".to_string()),
            cwd: Some("/tmp/project".to_string()),
            selection: "cwd".to_string(),
        })
        .expect("context JSON");
        assert_eq!(value["codexThreadId"], "thread-1");
        assert_eq!(value["terminalId"], "terminal-1");
        assert_eq!(value["cwd"], "/tmp/project");
        assert_eq!(value["selection"], "cwd");
    }
}
