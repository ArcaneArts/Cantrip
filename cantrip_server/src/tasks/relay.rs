//! The worker alone opens the Task payload; the server checks relay identity.
use super::*;
pub const EXECUTE_PROMPT: &str = "Execute the encrypted Cantrip Task operation.";
pub fn turn_fields(operation: &Value) -> Result<Value> {
    let operation = parse("taskOperationRelayRequestSchema", operation)?;
    Ok(
        json!({"prompt":EXECUTE_PROMPT,"resultMode":json!({"kind":"task-encrypted","operation":operation})}),
    )
}
pub fn parse_result(operation: &Value, result: &Value) -> Result<Value> {
    let operation = parse("taskOperationRelayRequestSchema", operation)?;
    let result = parse("taskOperationRelayResultSchema", result)?;
    anyhow::ensure!(
        policy::same_operation(&operation, &result),
        "Encrypted Task operation result metadata is invalid."
    );
    Ok(result)
}
