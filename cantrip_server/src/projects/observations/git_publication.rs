//! Exact bounded Git payloads share a revision clock; failures invalidate instead.
use super::Service;
use crate::{
    operations::logging::{self, LogCall},
    wire::{Value, value::json},
};

impl Service {
    pub(super) fn git_invalidation(
        &self,
        owner: &str,
        project: &str,
        entity: &str,
        resource: &str,
    ) {
        if let Some(live) = self.live.upgrade()
            && let Err(error) = live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null})) {
                (logging::server_logger())(LogCall::event("error", "Could not publish application live invalidation", json!({"err":json!({"message":error.to_string()}),"resource":resource})));
            }
    }
    pub(super) fn publish_git_operation(&self, owner: &str, operation: &Value) {
        self.publish_git(owner, operation, false);
    }
    pub(super) fn publish_git_conflicts(
        &self,
        owner: &str,
        project: &str,
        tree: &str,
        conflicts: &Value,
    ) {
        self.publish_git(
            owner,
            &json!({"projectId":project,"id":tree,"conflicts":conflicts}),
            true,
        );
    }
    fn publish_git(&self, owner: &str, value: &Value, conflicts: bool) {
        let Some(live) = self.live.upgrade() else {
            return;
        };
        if !live.publishing_enabled() {
            return;
        }
        let (resource, schema, input, message) = if conflicts {
            (
                "git-conflict",
                "gitConflictListSchema",
                value["conflicts"].clone(),
                "Could not publish exact Git conflict summary",
            )
        } else {
            (
                "git-operation",
                "gitManagedOperationResponseSchema",
                json!({"operation":value}),
                "Could not publish exact Git operation state",
            )
        };
        // Object field evaluation in Source allocates the revision before
        // validating either payload, including an attempt that falls back.
        let revision = self.state.lock().unwrap().git.next_revision();
        let publish = || -> anyhow::Result<()> {
            let parsed = crate::settings::parse_response(schema, Some(&input))?;
            let payload =
                crate::settings::parse_response("appLiveEventPayloadSchema", Some(&parsed))?;
            live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":value["projectId"]}),"resource":resource,"action":"updated","entityId":value["id"],"revision":revision,"payload":payload}))
        };
        if let Err(error) = publish() {
            let mut fields =
                json!({"err":json!({"message":error.to_string()}),"projectId":value["projectId"]});
            fields[if conflicts {
                "worktreeId"
            } else {
                "operationId"
            }] = value["id"].clone();
            (logging::server_logger())(LogCall::event("warn", message, fields));
            self.git_invalidation(
                owner,
                value["projectId"].as_str().unwrap(),
                value["id"].as_str().unwrap(),
                resource,
            );
        }
    }
}
