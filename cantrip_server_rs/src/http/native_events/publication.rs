use crate::{
    auth::service::AuthService,
    native_commands::events::{Publication, PublicationKind},
    wire::{Value, coercion::truthy, value::json},
};
fn invalidate(service: &AuthService, owner: &str, scope: Value, resource: &str, entity: &Value) {
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
}
pub(super) fn publish(service: &AuthService, owner: &str, publication: Publication) {
    let context = publication.context;
    let chat = &context["chatId"];
    let chat_scope = json!({"kind":"chat","chatId":chat});
    let project = &context["projectId"];
    let project_scope = if truthy(Some(project)) {
        json!({"kind":"project","projectId":project})
    } else {
        json!({"kind":"current-user"})
    };
    let task = context["experience"] == "task" && truthy(Some(project));
    match publication.kind {
        PublicationKind::Message {
            message,
            task: task_message,
        } => {
            // Source catches message publication errors independently, then
            // still emits Task workload invalidations.
            if let Ok(payload) =
                crate::settings::parse_response("appLiveEventPayloadSchema", Some(&message))
            {
                let _=service.live.publish_event(json!({"ownerId":owner,"scope":chat_scope,"resource":"chat-message","action":"updated","entityId":message["id"],"revision":message["sequence"],"payload":payload}));
            }
            if task_message {
                invalidate(service, owner, chat_scope, "task", &message["id"]);
                if task {
                    invalidate(service, owner, project_scope, "task", &message["id"]);
                }
            }
        }
        PublicationKind::Invalidation(resource) => {
            invalidate(service, owner, chat_scope, resource, &Value::Null);
            invalidate(service, owner, project_scope.clone(), "chat", chat);
            // The Source router schedules this after the synchronous summary.
            if task {
                invalidate(service, owner, project_scope, resource, chat);
            }
        }
    }
}
