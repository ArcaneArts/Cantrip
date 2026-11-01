use crate::{
    auth::service::AuthService,
    chats::message_queries::MessageKind,
    native_commands::events::{Publication, PublicationKind},
};
pub(super) async fn publish(service: &AuthService, owner: &str, publication: Publication) {
    let context = publication.context;
    match publication.kind {
        PublicationKind::Message {
            message,
            task: task_message,
        } => {
            service
                .chat_mutations
                .publish_persisted_message(
                    owner,
                    &message,
                    if task_message {
                        MessageKind::Task
                    } else {
                        MessageKind::Encrypted
                    },
                    Some(&context),
                )
                .await;
        }
        PublicationKind::Invalidation(resource) => {
            service
                .chat_mutations
                .publish_committed_invalidation(
                    owner,
                    context["chatId"].as_str().expect("Native event chat"),
                    resource,
                    &context["projectId"],
                    &context,
                )
                .await;
        }
    }
}
