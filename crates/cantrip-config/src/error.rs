//! Existing configuration error names, messages, and structured issue formatting.
use serde_json::Value;
use std::fmt;

#[derive(Debug)]
pub struct ConfigError {
    pub name: &'static str,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, ConfigError>;
impl ConfigError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            name: "Error",
            message: message.into(),
        }
    }
    pub fn zod(issues: Vec<Value>) -> Self {
        Self {
            name: "ZodError",
            message: serde_json::to_string_pretty(&issues).expect("JSON validation issues"),
        }
    }
}
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ConfigError {}
