use crate::wire::{ValidationError, Value};
use std::{error::Error, fmt};

#[derive(Debug)]
pub struct ModelError {
    pub name: &'static str,
    pub code: Option<&'static str>,
    pub message: String,
}
impl ModelError {
    pub(super) fn command(code: &'static str, message: &str) -> Self {
        Self {
            name: "WorkspaceCommandError",
            code: Some(code),
            message: message.into(),
        }
    }
    pub(super) fn plain(name: &'static str, message: &str) -> Self {
        Self {
            name,
            code: None,
            message: message.into(),
        }
    }
    pub(super) fn validation(error: ValidationError) -> Self {
        match error {
            ValidationError::Invalid(issues) => Self {
                name: "ZodError",
                code: None,
                message: Value::Array(issues).stringify_pretty(),
            },
            ValidationError::Operation => {
                Self::plain("TypeError", "Native schema operation failed")
            }
        }
    }
}
impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl Error for ModelError {}
