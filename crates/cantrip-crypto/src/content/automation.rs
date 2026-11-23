use super::{authenticate, decode_json, open_field, revision};
use crate::checked;
use anyhow::Result;
use cantrip_wire::{Value, value::json};

pub enum ProjectAutomationField {
    Name,
    Prompt,
    Condition,
}

/// The legacy component, table and field bindings are part of the persisted
/// format, even though the feature is now named Project Automation.
pub fn open_project_automation(
    key: &[u8],
    owner: &Value,
    automation: &Value,
    field: ProjectAutomationField,
    key_revision: u64,
    opaque: &Value,
) -> Result<Value> {
    let (field, schema) = match field {
        ProjectAutomationField::Name => ("name", "projectAutomationProtectedNameSchema"),
        ProjectAutomationField::Prompt => ("prompt", "projectAutomationProtectedPromptSchema"),
        ProjectAutomationField::Condition => {
            ("condition", "projectAutomationProtectedConditionSchema")
        }
    };
    authenticate(|| {
        let encrypted = checked("projectAutomationContentOpaqueSchema", opaque)?;
        let binding = super::aad(
            &json!({"ownerId":owner,"keyRevision":key_revision}),
            &json!("workflow-content"),
            &json!("workflow:project-automation"),
            automation,
            &json!(field),
        )?;
        revision(&encrypted, &binding)?;
        let plaintext = open_field(key, &binding, &encrypted["envelope"])?;
        decode_json(schema, &plaintext, 4 * 1024 * 1024)
    })
}
