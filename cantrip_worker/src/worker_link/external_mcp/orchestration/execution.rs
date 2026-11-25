//! Worker dispatch for typed external execution. Raw argv stays on this worker.
use super::{Call, Client, CoreOperation, Service, Value, restricted};
use crate::run_runtime::{
    external::{Identity, Observation},
    protection,
};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::external_mcp::execution::{CliCommand, CliInvocation, ExecutionPolicy};
use std::time::Duration;

impl Client {
    pub(super) async fn execute(
        &self,
        binding: &Value,
        encryption: &Service,
        call: Call,
    ) -> Result<Value> {
        let mut result = match call {
            Call::CantripCli(input) => {
                let logs = matches!(input.command, CliCommand::RunLogs { .. });
                let mut result = self
                    .request(
                        binding,
                        CoreOperation::Cli {
                            operation_id: None,
                            invocation: CliInvocation::Read {
                                command: input.command,
                            },
                        },
                    )
                    .await?;
                if logs {
                    let wire = crate::http::checked(
                        "protectedRunConfigurationRuntimeOutputResultSchema",
                        &result["data"],
                    )?;
                    result["data"] =
                        protection::open_output(encryption, &encryption.server_identity()?, &wire)?;
                }
                result
            }
            Call::CantripCliRun(input) => {
                self.request(
                    binding,
                    CoreOperation::Cli {
                        operation_id: Some(input.operation_id),
                        invocation: CliInvocation::Run {
                            action: input.action,
                            configuration_id: input.configuration_id,
                        },
                    },
                )
                .await?
            }
            call => self.command(binding, call).await?,
        };
        result["projectId"] = binding["resource"]["resourceId"].clone();
        result["worktreeId"] = binding["resource"]["attachmentId"].clone();
        ensure!(
            result.stringify().len() <= 24 * 1024,
            "The result exceeded the MCP limit. Use a more specific command or request less output."
        );
        Ok(result)
    }

    async fn command(&self, binding: &Value, call: Call) -> Result<Value> {
        let checkout = self.checkout(binding).await?;
        let identity = &binding["identity"];
        let authority = Identity {
            owner: text(identity, "ownerId")?,
            principal: text(&checkout, "principalId")?,
            project: text(&checkout, "projectId")?,
            worktree: text(&checkout, "worktreeId")?,
            worker: text(identity, "workerId")?,
            server: text(identity, "serverId")?,
        };
        let generation = text(identity, "workerProcessGeneration")?;
        let (id, observation) = match call {
            Call::CommandStart(input) => {
                let policy: ExecutionPolicy =
                    ExecutionPolicy::decode(&checkout["externalExecutionPolicy"].stringify())?;
                ensure!(
                    policy.sandbox_access().is_some(),
                    "The workspace does not allow external commands."
                );
                let checkout = self.routing.resolve(&checkout).await?;
                let root = restricted::resolve_checkout(&self.worktrees, &checkout, &self.scope)
                    .await
                    .context("The checkout is no longer available on the assigned worker.")?;
                let launcher = self
                    .config
                    .lock()
                    .unwrap()
                    .codex_installation
                    .binary
                    .clone();
                let commands = self.commands.clone();
                let operation = input.operation_id;
                let mut result = tokio::task::spawn_blocking(move || {
                    commands.start(authority, &generation, &launcher, &root, policy, input)
                })
                .await??;
                result["operationId"] = cantrip_wire::value::json!(operation);
                return Ok(result);
            }
            Call::CommandStatus(input) => (input.command_id, Observation::Status),
            Call::CommandCancel(input) => (input.command_id, Observation::Cancel),
            Call::CommandOutput(input) => (
                input.command_id,
                Observation::Output {
                    offset: input.offset,
                    max_bytes: input.max_bytes,
                },
            ),
            Call::CommandWait(input) => (
                input.command_id,
                Observation::Wait {
                    after: input.after_revision,
                    timeout: Duration::from_millis(input.timeout_ms),
                },
            ),
            _ => unreachable!("validated external execution tool"),
        };
        self.commands
            .observe(&authority, &generation, id, observation)
            .await
    }
}

fn text(record: &Value, field: &str) -> Result<String> {
    Ok(record[field]
        .as_str()
        .context("External command authority")?
        .to_owned())
}
