use crate::{
    auth::service::AuthService,
    chats::Repository,
    projects::repository::ProjectRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(in crate::http) async fn read(
    service: &AuthService,
    owner: &str,
    arguments: &Value,
) -> Result<Value> {
    let input = crate::http::agent_operations::parse("councilInventoryInputSchema", arguments)?;
    let section = input["section"]
        .as_str()
        .context("Council inventory section")?;
    let cursor = input["cursor"]
        .as_u64()
        .context("Council inventory cursor")? as usize;
    let limit = input["limit"].as_u64().context("Council inventory limit")? as usize;
    let database = service.repository.database.clone();
    let candidates = if section == "projects" {
        ProjectRepository::new(database)?.list(owner).await?
    } else {
        let project = input["projectId"].as_str().context("Council project")?;
        let experience = if section == "tasks" { "task" } else { "agent" };
        Repository::new(database)
            .list_project(owner, project)
            .await?
            .into_iter()
            .filter(|chat| chat["experience"] == experience)
            .collect()
    };
    let end = (cursor + limit).min(candidates.len());
    let entries: Vec<_> = candidates.iter().skip(cursor).take(limit).map(|row| {
        if section == "projects" {
            json!({"id":row["id"],"kind":"project","projectId":row["id"],"workerId":row["source"]["workerId"],
                "status":row["setupStatus"],"permissionProfileId":Value::Null,"titleProtection":row["nameProtection"]})
        } else {
            json!({"id":row["id"],"kind":if section == "tasks" { "task" } else { "chat" },
                "projectId":row["projectId"],"workerId":row["activeWorkerId"],"status":row["status"],
                "permissionProfileId":row["permissionProfileId"],"titleProtection":row["titleProtection"]})
        }
    }).collect();
    let data = crate::settings::parse_response(
        "councilInventoryWireSchema",
        Some(&json!({
            "section": section,"entries": entries,"nextCursor": (end < candidates.len()).then_some(end),
        })),
    )?;
    Ok(
        json!({"summary":format!("Loaded {} Council inventory entries.", entries.len()),"data":data}),
    )
}
