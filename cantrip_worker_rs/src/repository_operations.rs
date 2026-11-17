//! Encrypted repository command admission and the native attachment/metadata
//! operations. Git/GitHub execution is added by its owning domain milestones.
use crate::{
    encryption::Service,
    protected_content::{
        RepositoryOperationReplayGuard, open_repository_content, protect_repository_content,
    },
    routing::Registry,
    workspace::{Scope, WorkspaceError},
};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::sync::Mutex;

#[derive(Default)]
pub struct RepositoryOperations {
    replay: Mutex<RepositoryOperationReplayGuard>,
}
impl RepositoryOperations {
    pub async fn execute(
        &self,
        command: &Value,
        service: &Service,
        registry: &Registry,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        // The existing public command wrapper resolves routing metadata before
        // dispatch, even though attachment's private root is inside ciphertext.
        let command = registry.resolve(command).await?;
        let mut context = json!({"serverId":command["serverId"],"projectId":command["projectId"],"worktreeId":command["worktreeId"],"operationId":command["operationId"],"direction":"request"});
        self.replay.lock().unwrap().reserve(&context)?;
        let request = open_repository_content(
            service,
            &context,
            &command["protectedRequest"],
            "repositoryOperationRequestContentSchema",
            false,
        )?;
        let kind = request["type"].as_str().unwrap();
        if command["access"].as_str()
            != cantrip_protocol::repository_operations::operation_access(kind)
        {
            bail!("Repository operation access metadata is invalid.");
        }
        let attaches = kind == "workspace.root.attach";
        if attaches != (command["routingPurpose"] == "workspace-root-attachment") {
            bail!("Repository operation routing purpose is invalid.");
        }
        let mut attachment = None;
        let result = async {
            if command["agent"] != json!(kind == "git.agent.generate") {
                bail!("Repository agent routing metadata is invalid.");
            }
            scope.check()?;
            match kind {
                "repository.metadata.register" | "repository.metadata.resolve" => {
                    let values = checked(
                        "repositoryMetadataValuesSchema",
                        &request["arguments"]["values"],
                    )?;
                    let values = if kind == "repository.metadata.register" {
                        registry.protect_metadata(&values).await?
                    } else {
                        registry.resolve_metadata(&values).await?
                    };
                    checked("repositoryMetadataResultSchema", &json!({"values":values}))
                }
                "workspace.root.attach" => {
                    let arguments =
                        checked("workspaceRootAttachArgumentsSchema", &request["arguments"])?;
                    let result = crate::workspace::attach_root(
                        arguments["rootPath"].as_js_string().unwrap(),
                        registry,
                        scope,
                    )
                    .await?;
                    attachment = Some(result.clone());
                    Ok(result)
                }
                _ => bail!("Repository operation is not implemented by the native worker."),
            }
        }
        .await;
        let outcome = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => {
                let message: JsString = error.to_string().into();
                let mut outcome = json!({"ok":false,"error":JsString::new(message.units().iter().take(2000).copied().collect())});
                if let Some(error) = error.downcast_ref::<WorkspaceError>() {
                    outcome["code"] = json!(error.code);
                }
                outcome
            }
        };
        context["direction"] = json!("response");
        let protected = protect_repository_content(
            service,
            &context,
            &outcome,
            "repositoryOperationOutcomeContentSchema",
        )?;
        let mut response = json!({"operationId":command["operationId"],"protectedResponse":protected,"agentExecution":Value::Null});
        if let Some(attachment) = attachment {
            response["workspaceRootAttachment"] = attachment;
        }
        checked("repositoryOperationWireResponseSchema", &response)
    }
}
