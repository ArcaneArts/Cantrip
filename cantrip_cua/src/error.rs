use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, CuaError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CuaError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    InvalidRequest,
    ScriptSyntax,
    ScriptEvaluation,
    ProtocolVersion,
    Capacity,
    Cancelled,
    Unsupported,
    SessionNotFound,
    OwnershipMismatch,
    TargetNotFound,
    StaleTarget,
    CaptureFailed,
    StaleElement,
    InputUnknown,
    InputFailed,
    PermissionDenied,
}

impl CuaError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let message = message.into().chars().take(512).collect();
        Self { code, message }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }
}

impl std::fmt::Display for CuaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CuaError {}
