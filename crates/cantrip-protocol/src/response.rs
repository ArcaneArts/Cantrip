//! Protocol response validation and its preserved, downcastable error type.
//! The legacy operation-error message is part of existing observable behavior.
pub fn parse_response(schema: &str, value: Option<&crate::Value>) -> anyhow::Result<crate::Value> {
    crate::parse(schema, value).map_err(response_error)
}
#[derive(Debug, Clone)]
pub struct ResponseValidationError(String);
impl std::fmt::Display for ResponseValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for ResponseValidationError {}
pub fn response_error(error: crate::ValidationError) -> anyhow::Error {
    match error {
        crate::ValidationError::Invalid(issues) => {
            ResponseValidationError(crate::Value::Array(issues).stringify_pretty()).into()
        }
        crate::ValidationError::Operation => {
            anyhow::anyhow!("Settings response validation failed.")
        }
    }
}
