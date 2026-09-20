/// Invalid data supplied to the shared interaction core. Adapters map this to
/// their public error vocabulary; the core has no agent/protocol error codes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationError(pub String);
pub type Result<T> = std::result::Result<T, ValidationError>;
impl ValidationError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}
impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ValidationError {}
