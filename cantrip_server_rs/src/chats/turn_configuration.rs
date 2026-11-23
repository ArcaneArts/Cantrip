//! Turn-mode admission and model inheritance retain undefined/null distinctions.
use crate::wire::{Value, coercion::truthy, property, value::json};
use anyhow::{Result, bail};

pub fn validate(context: &Value, input: &Value, options: &Value) -> Result<()> {
    let standalone = property(Some(context), "contextKind")?.is_some_and(|v| v == "standalone");
    let mode = property(Some(input), "mode")?;
    let structured = property(Some(options), "structuredResult")?;
    if standalone
        && (mode.is_some_and(|v| v != "default")
            || truthy(structured)
            || truthy(property(Some(options), "encryptedTaskMessages")?)
            || truthy(property(Some(options), "taskDispatchLease")?))
    {
        bail!("Standalone Chat supports only ordinary default-mode conversation turns.");
    }
    if truthy(structured)
        && truthy(property(structured, "outputSchema")?)
            == truthy(property(structured, "taskOperation")?)
    {
        bail!("Structured turns require exactly one result contract.");
    }
    Ok(())
}
pub fn model_configuration(context: &Value, input: &Value, model: Option<&Value>) -> Result<Value> {
    let standalone = property(Some(context), "contextKind")?.is_some_and(|v| v == "standalone");
    let requested = property(Some(input), "reasoningEffort")?
        .or(property(Some(context), "reasoningEffort")?)
        .cloned();
    let mut configuration = Value::object([] as [(&str, Value); 0]);
    if let Some(model) = model {
        configuration["modelId"] = model.clone();
    }
    if let Some(requested) = &requested {
        configuration["reasoningEffort"] = requested.clone();
    }
    for (field, fallback) in [
        ("customSubagentModel", json!(false)),
        ("subagentModelId", Value::Null),
        ("subagentReasoningEffort", Value::Null),
    ] {
        let value = if standalone {
            Some(fallback)
        } else {
            let input = property(Some(input), field)?
                .filter(|v| field != "customSubagentModel" || !v.is_null());
            if let Some(input) = input {
                Some(input.clone())
            } else {
                property(property(Some(context), "modelConfiguration")?, field)?.cloned()
            }
        };
        if let Some(value) = value {
            configuration[field] = value;
        }
    }
    let mut result = json!({"turnModelConfiguration":crate::settings::parse_response("modelConfigurationSchema",Some(&configuration))?});
    if let Some(requested) = requested {
        result["requestedReasoningEffort"] = requested;
    }
    Ok(result)
}
