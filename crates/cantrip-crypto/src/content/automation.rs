use super::{authenticate, decode_json, encode_json, open_field, revision, seal_field};
use crate::checked;
use anyhow::Result;
use cantrip_wire::{Value, value::json};

pub enum ProjectAutomationField {
    Name,
    Prompt,
    Condition,
}

const CONTENT_LIMIT: usize = 4 * 1024 * 1024;

impl ProjectAutomationField {
    fn format(self) -> (&'static str, &'static str) {
        match self {
            Self::Name => ("name", "projectAutomationProtectedNameSchema"),
            Self::Prompt => ("prompt", "projectAutomationProtectedPromptSchema"),
            Self::Condition => ("condition", "projectAutomationProtectedConditionSchema"),
        }
    }
}

fn binding(owner: &Value, automation: &Value, field: &str, key_revision: u64) -> Result<Value> {
    super::aad(
        &json!({"ownerId":owner,"keyRevision":key_revision}),
        &json!("workflow-content"),
        &json!("workflow:project-automation"),
        automation,
        &json!(field),
    )
}

pub fn seal_project_automation(
    key: &[u8],
    owner: &Value,
    automation: &Value,
    field: ProjectAutomationField,
    key_revision: u64,
    content: &Value,
) -> Result<Value> {
    let (field, schema) = field.format();
    let plaintext = encode_json(
        schema,
        content,
        CONTENT_LIMIT,
        "Protected automation content is too large.",
    )?;
    let envelope = seal_field(
        key,
        &binding(owner, automation, field, key_revision)?,
        &plaintext,
    )?;
    checked(
        "projectAutomationContentOpaqueSchema",
        &json!({
            "formatVersion":1,"keyRevision":key_revision,"envelope":envelope,
        }),
    )
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
    let (field, schema) = field.format();
    authenticate(|| {
        let encrypted = checked("projectAutomationContentOpaqueSchema", opaque)?;
        let binding = binding(owner, automation, field, key_revision)?;
        revision(&encrypted, &binding)?;
        let plaintext = open_field(key, &binding, &encrypted["envelope"])?;
        decode_json(schema, &plaintext, CONTENT_LIMIT)
    })
}
