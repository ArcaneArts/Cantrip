//! Thin adapters to the current production resource repositories.
use super::*;
use cantrip_server::settings::repository::SettingsRepository;
use futures::FutureExt;
macro_rules! json {
    ($($token:tt)*) => { Value::from_serialize(&serde_json::json!($($token)*)) };
}

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let text = |key: &str| {
        request[key]
            .as_str()
            .context("Resource state fixture field")
    };
    let owner = text("owner")?;
    let project = request["project"].as_str().unwrap_or("github");
    let chat = request["chat"].as_str().unwrap_or("chat");
    let chats = cantrip_server::chats::Repository::new(database.clone());
    let surfaces = cantrip_server::remote_surfaces::Repository::new(database.clone());
    match text("op")? {
        "resource-state-model-default" => {
            let value = SettingsRepository::new(database)
                .get_model_reasoning_default(owner, text("model")?)
                .await?;
            Ok(json!({"present":value.is_some(),"value":value.flatten()}))
        }
        "resource-state-next-position" => Ok(json!(
            cantrip_server::project_layout::next_position(&database, project).await?
        )),
        "resource-state-reorder" | "resource-state-reorder-layout" => {
            let ids = request["input"]["ids"]
                .as_array()
                .context("Project order")?
                .iter()
                .map(|id| id.as_js_string().cloned().context("Project identity"))
                .collect::<Result<Vec<_>>>()?;
            Ok(json!(
                ProjectRepository::new(database)?
                    .reorder(owner, ids)
                    .await?
            ))
        }
        "resource-state-pause" => Ok(chats
            .set_automation_paused(owner, chat, request["paused"] == true)
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        "resource-state-status" => {
            chats.set_status(chat, text("status")?).await?;
            Ok(Value::Null)
        }
        "resource-state-create-task" => {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == worker))
            };
            Ok(chats
                .create_task(
                    owner,
                    project,
                    &request["input"],
                    request["connected"]
                        .as_array()
                        .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        }
        "resource-state-surfaces" => Ok(Value::Array(surfaces.list(owner, project).await?)),
        "resource-state-desktops" => Ok(Value::Array(surfaces.desktops(owner, project).await?)),
        "resource-state-desktop" => Ok(surfaces
            .desktop(owner, text("surface")?)
            .await?
            .unwrap_or(Value::Null)),
        "resource-state-surface-create" => Ok(surfaces
            .create(owner, project, &request["input"])
            .await?
            .unwrap_or(Value::Null)),
        "resource-state-surface-update" => Ok(surfaces
            .update(owner, text("surface")?, &request["input"])
            .await?
            .unwrap_or(Value::Null)),
        "resource-state-surface-delete" => Ok(surfaces
            .delete(owner, text("surface")?)
            .await?
            .unwrap_or(Value::Null)),
        "resource-state-desktop-create" => Ok(surfaces
            .create_desktop(owner, project, text("worker")?, &request["input"], None)
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        _ => anyhow::bail!("Unknown resource state fixture operation"),
    }
}
