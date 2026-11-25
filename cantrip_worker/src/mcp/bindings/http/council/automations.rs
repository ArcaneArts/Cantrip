use super::{Authorized, Service, grant, resource_id};
use anyhow::{Context, Result};
use cantrip_crypto::content::{
    ProjectAutomationField::{self, Condition, Name, Prompt},
    open_project_automation, seal_project_automation,
};
use cantrip_wire::{Value, value::json};
use uuid::Uuid;

pub(super) fn protect_create(
    service: &Service,
    authorization: &Authorized,
    source: &Value,
    input: &Value,
) -> Result<Value> {
    let operation = input["operationId"]
        .as_str()
        .context("Routine operation ID")?;
    let id = json!(
        resource_id(
            authorization
                .identity
                .0
                .as_str()
                .context("Council owner ID")?,
            source.as_str().context("Council source ID")?,
            Uuid::parse_str(operation)?,
            "council-automation",
        )
        .to_string()
    );
    let key = grant(service, authorization, "workflow-content", None)?;
    let seal = |field, content: Value| {
        seal_project_automation(
            &key.component.key,
            &json!(key.owner_id),
            &id,
            field,
            key.component.key_revision,
            &content,
        )
    };
    let protected = json!({
        "protectedName":seal(Name, json!({"version":1,"name":input["name"]}))?,
        "protectedPrompt":seal(Prompt, json!({"version":1,"prompt":input["prompt"]}))?,
        "protectedCondition":seal(Condition, json!({"version":1,"condition":Value::Null}))?,
    });
    Ok(json!({
        "operationId":operation,
        "routine":json!({
            "id":id,"chatId":input.get("agentId").unwrap_or(source),"content":protected,
            "schedule":input["schedule"],"enabled":input["enabled"],
        }),
    }))
}

pub(super) fn protect_update(
    service: &Service,
    authorization: &Authorized,
    input: &Value,
) -> Result<Value> {
    let mut changes = input["changes"].clone();
    let Value::Object(fields) = &mut changes else {
        anyhow::bail!("Missing routine changes.");
    };
    let mut protected = Value::object([] as [(&str, Value); 0]);
    for (field, envelope, kind) in [
        ("name", "protectedName", Name),
        ("prompt", "protectedPrompt", Prompt),
    ] {
        if let Some(value) = fields.shift_remove(field) {
            let key = grant(service, authorization, "workflow-content", None)?;
            let mut content = json!({"version":1});
            content[field] = value;
            protected[envelope] = seal_project_automation(
                &key.component.key,
                &json!(key.owner_id),
                &input["automationId"],
                kind,
                key.component.key_revision,
                &content,
            )?;
        }
    }
    if protected
        .as_object()
        .is_some_and(|fields| !fields.is_empty())
    {
        changes["content"] = protected;
    }
    Ok(json!({
        "operationId":input["operationId"],"automationId":input["automationId"],
        "expectedRevision":input["expectedRevision"],"changes":changes,
    }))
}

pub(super) fn open(
    service: &Service,
    authorization: &Authorized,
    routine: &Value,
    with_prompt: bool,
) -> Result<Value> {
    let open = |field: ProjectAutomationField, protected: &Value| -> Result<Value> {
        let revision = protected["keyRevision"]
            .as_u64()
            .context("Routine key revision")?;
        let key = grant(service, authorization, "workflow-content", Some(revision))?;
        open_project_automation(
            &key.component.key,
            &json!(key.owner_id),
            &routine["id"],
            field,
            revision,
            protected,
        )
    };
    let mut result = routine.clone();
    if let Value::Object(fields) = &mut result {
        fields.shift_remove("content");
        fields.shift_remove("projectId");
    }
    result["name"] = open(Name, &routine["content"]["protectedName"])?["name"].clone();
    if with_prompt {
        result["prompt"] = open(Prompt, &routine["content"]["protectedPrompt"])?["prompt"].clone();
    }
    Ok(result)
}
