use crate::{
    auth::service::AuthService,
    chats::Repository,
    policies::repository::PolicyRepository,
    projects::repository::ProjectRepository,
    settings::repository::SettingsRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(in crate::http) async fn read(
    service: &AuthService,
    owner: &str,
    context: &Value,
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
    let chats = Repository::new(database.clone());
    let candidates: Vec<Value> = match section {
        "projects" => ProjectRepository::new(database)?.list(owner).await?.into_iter().map(|row|
            json!({"id":row["id"],"kind":"project","projectId":row["id"],"workerId":row["source"]["workerId"],
                "status":row["setupStatus"],"permissionProfileId":Value::Null,"titleProtection":row["nameProtection"]})
        ).collect(),
        "chats" | "tasks" => {
            let project = input["projectId"].as_str().context("Council project")?;
            let (kind, experience) = if section == "tasks" { ("task", "task") } else { ("chat", "agent") };
            chats.list_project(owner, project).await?.into_iter()
                .filter(|row| row["experience"] == experience)
                .map(|row| json!({"id":row["id"],"kind":kind,"projectId":row["projectId"],
                    "workerId":row["activeWorkerId"],"status":row["status"],
                    "permissionProfileId":row["permissionProfileId"],"titleProtection":row["titleProtection"]}))
                .collect()
        }
        "agents" => chats.council_agents(owner).await?.iter().map(|row|
            json!({"id":row["id"],"kind":"agent","workerId":row["workerId"],"primary":row["primary"],
                "status":row["scratchStatus"],"titleProtection":row["titleProtection"]})
        ).collect(),
        "settings" => {
            let settings = SettingsRepository::new(database).get_user_settings(owner).await?;
            setting_entries(&Value::from_serialize(&settings))
        }
        "models" => database.query(
            "SELECT p.id,p.name,(SELECT count(*)::int FROM model_routes r
             WHERE r.model_id=p.id AND r.enabled) FROM model_profiles p
             WHERE p.owner_id=$1 ORDER BY p.name,p.id",
            &[&owner],
        ).await?.iter().map(|row| Ok(json!({"id":row.get::<String>(0)?,"kind":"model",
            "title":row.get::<String>(1)?,"enabledRoutes":row.get::<i32>(2)?}))).collect::<Result<_>>()?,
        "policies" => PolicyRepository::new(database).resolve_standalone(owner).await?["policies"]
            .as_array().context("Effective Council policies")?.iter().map(|row|
                json!({"id":row["id"],"kind":"policy","protectedSummary":row["protectedSummary"]})
            ).collect(),
        "tools" => chats.effective_mcp_servers(owner, None,
                context["workerId"].as_str().context("Council Worker")?, "chat")
            .await?.iter().map(|row| json!({"id":row["id"],"kind":"mcp-server",
                "enabled":row["enabled"],"protectedConfiguration":row["protectedConfiguration"]}))
            .collect(),
        _ => anyhow::bail!("Unrecognized Council inventory section."),
    };
    let end = (cursor + limit).min(candidates.len());
    let next = (end < candidates.len()).then_some(end);
    let entries: Vec<_> = candidates.into_iter().skip(cursor).take(limit).collect();
    let data = crate::settings::parse_response(
        "councilInventoryWireSchema",
        Some(&json!({
            "section": section,"entries": entries,"nextCursor": next,
        })),
    )?;
    Ok(
        json!({"summary":format!("Loaded {} Council inventory entries.", entries.len()),"data":data}),
    )
}

fn setting_entries(settings: &Value) -> Vec<Value> {
    [
        ("defaultCouncilModelId", "Council default model"),
        (
            "defaultCouncilPermissionProfileId",
            "Council default permissions",
        ),
        ("defaultChatModelId", "Chat default model"),
        ("defaultChatPermissionProfileId", "Chat default permissions"),
        ("defaultModelId", "IDE default model"),
        ("defaultPermissionProfileId", "IDE default permissions"),
        ("defaultWorkerId", "Default Worker"),
    ]
    .into_iter()
    .map(|(id, title)| json!({"id":id,"kind":"setting","title":title,"value":settings[id]}))
    .collect()
}
