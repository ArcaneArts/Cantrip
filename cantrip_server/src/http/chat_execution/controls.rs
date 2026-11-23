use super::*;
use crate::{chats::automation_pause::PauseError, task_scheduling};

impl Execution {
    pub(super) async fn pause(&self, chat: &str, input: Option<&Value>) -> Result<Response> {
        let input = match parse("chatPauseUpdateSchema", input)? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        match self
            .service
            .execution
            .pause
            .set(&self.owner, chat, truthy(input.get("paused")), true)
            .await
        {
            Ok(state) => output(200, "chatPauseStateSchema", &state),
            Err(cause) => match downcast_ref::<PauseError>(&cause) {
                Some(failure) => Ok(error(failure.status_code, failure.message.clone())),
                None => Err(cause),
            },
        }
    }

    pub(super) async fn project_pause(
        &self,
        project: &str,
        method: Method,
        input: Option<&Value>,
    ) -> Result<Response> {
        let repository = task_scheduling::Repository::new(self.service.repository.database.clone());
        if matches!(method, Method::GET | Method::HEAD) {
            return match repository.project_pause(&self.owner, project).await? {
                Some(state) => output(200, "projectTaskPauseStateSchema", &state),
                None => Ok(error(404, "Project not found.")),
            };
        }
        let input = match parse("projectTaskPauseUpdateSchema", input)? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let state = match repository
            .set_project_pause(&self.owner, project, &input)
            .await
        {
            Ok(Some(state)) => state,
            Ok(None) => return Ok(error(404, "Project not found.")),
            Err(cause) => {
                return match downcast_ref::<task_scheduling::Conflict>(&cause) {
                    Some(conflict) => Ok(json_response(
                        StatusCode::CONFLICT,
                        json!({"code":conflict.code,"error":conflict.message}),
                    )),
                    None => Err(cause),
                };
            }
        };
        let paused = truthy(state.get("paused"));
        let applied = self
            .service
            .execution
            .project_pause
            .set(&self.owner, project, paused)
            .await;
        // Source's finally block runs after every admitted project update,
        // including partial Task failures. The committed pause state survives.
        if !paused {
            self.service.execution.scheduler.queue_tick();
        }
        if let Err(cause) = self.service.live.publish_event(json!({
            "ownerId":self.owner,"scope":json!({"kind":"project","projectId":project}),
            "resource":"task","action":"invalidated","entityId":Value::Null,
            "revision":Value::Null,"payload":Value::Null
        })) {
            logging::server_logger()(LogCall::event(
                "error",
                "Could not publish application live invalidation",
                json!({"err":logging::error_details(&cause),"resource":"task"}),
            ));
        }
        match applied {
            Ok(()) => output(
                if paused { 200 } else { 202 },
                "projectTaskPauseStateSchema",
                &state,
            ),
            Err(cause) => Ok(json_response(
                StatusCode::CONFLICT,
                json!({"error":message(&cause),"pauseState":crate::settings::parse_response("projectTaskPauseStateSchema",Some(&state))?}),
            )),
        }
    }
}
