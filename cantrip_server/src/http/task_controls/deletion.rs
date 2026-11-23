//! Deletion atomically records worker cleanup in the shared database outbox.
use super::*;

pub(super) async fn delete(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
) -> Result<Response> {
    match tasks::Repository::new(service.repository.database.clone())
        .delete_owned(&owner, &chat)
        .await
    {
        Ok(Some(deleted)) => {
            service
                .chat_mutations
                .publish_summary(&owner, &json!(chat), &deleted["projectId"]);
            service.chat_mutations.publish_invalidation(
                &owner,
                &chat,
                "task",
                Some(&json!({"experience":"task","projectId":deleted["projectId"]})),
            );
            let mut response = Response::new(axum::body::Body::empty());
            *response.status_mut() = StatusCode::NO_CONTENT;
            Ok(response)
        }
        Ok(None) => Ok(error(404, "Task not found.")),
        Err(cause) => mutation_error(cause),
    }
}
