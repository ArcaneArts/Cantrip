use super::*;
use crate::{
    chats::{execution_lanes::LaneError, task_creation::ConversationCreationConflict},
    operations::shared_failure::downcast_ref,
    projects::placement::Unavailable,
};

pub(super) async fn create(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    input: Value,
) -> Result<Response> {
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    match Repository::new(service.repository.database.clone())
        .create_project_chat(&owner, &project, &input, Some(&connected))
        .await
    {
        Ok(Some(chat)) => {
            service
                .managed_preparation
                .request(
                    &owner,
                    chat["id"].as_str().expect("Created project Chat identity"),
                )
                .await?;
            output(201, "chatWireSummarySchema", &chat)
        }
        Ok(None) => Ok(error(404, "Project source not found")),
        Err(cause) => {
            if let Some(conflict) = downcast_ref::<ConversationCreationConflict>(&cause) {
                return Ok(error(409, conflict.to_string()));
            }
            if let Some(placement) = downcast_ref::<Unavailable>(&cause) {
                return if placement.code == "project-not-found" {
                    Ok(error(404, "Project source not found"))
                } else {
                    Ok(json_response(
                        StatusCode::CONFLICT,
                        json!({"code":placement.code,"error":placement.message}),
                    ))
                };
            }
            if duplicate(&cause)
                || matches!(
                    downcast_ref::<LaneError>(&cause),
                    Some(LaneError::Conflict(_))
                )
            {
                return Ok(error(
                    409,
                    "This worktree is already leased by another chat.",
                ));
            }
            if let Some(invariant) = downcast_ref::<crate::pane_layouts::LegacyInvariant>(&cause) {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"statusCode":400,"error":"Bad Request","message":invariant.to_string()}),
                ));
            }
            Err(cause)
        }
    }
}
