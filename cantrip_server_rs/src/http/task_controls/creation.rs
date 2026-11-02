use super::*;
use crate::{chats, projects::placement::Unavailable};

pub(super) async fn create(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    input: Value,
) -> Result<Response> {
    let connected = |id: &str| service.workers.bridge.is_connected(id);
    match chats::Repository::new(service.repository.database.clone())
        .create_task(&owner, &project, &input, Some(&connected))
        .await
    {
        Ok(Some(created)) => {
            let chat = created["chat"]["id"]
                .as_str()
                .context("Created Task Chat ID")?;
            service.chat_mutations.publish_summary(
                &owner,
                &json!(chat),
                &created["chat"]["projectId"],
            );
            service.execution.name_task(&owner, chat, &created["task"]);
            service.chat_mutations.publish_entity_invalidation(
                &owner,
                chat,
                "task",
                &json!(chat),
                Some(&created["chat"]),
            );
            output(201, "taskWireCreateResultSchema", &created)
        }
        Ok(None) => Ok(error(404, "Project source not found")),
        Err(cause) => {
            if let Some(unavailable) = downcast_ref::<Unavailable>(&cause) {
                return if unavailable.code == "project-not-found" {
                    Ok(error(404, "Project source not found"))
                } else {
                    Ok(json_response(
                        StatusCode::CONFLICT,
                        json!({"code":unavailable.code,"error":unavailable.message}),
                    ))
                };
            }
            let duplicate = downcast_ref::<chats::catalog::StatementFailure>(&cause).map_or_else(
                || {
                    let message = cause.to_string().to_lowercase();
                    message.contains("unique") || message.contains("duplicate")
                },
                |failure| failure.duplicate_message,
            );
            if duplicate
                || matches!(
                    downcast_ref::<chats::execution_lanes::LaneError>(&cause),
                    Some(chats::execution_lanes::LaneError::Conflict(_))
                )
            {
                return Ok(error(
                    409,
                    "This worktree is already leased by another chat.",
                ));
            }
            Err(cause)
        }
    }
}
