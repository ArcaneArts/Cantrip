//! Administrative commands admitted by Core and executed by the owning worker.
mod backup;
pub(crate) mod carrier;
mod desktop;
mod docker;
mod linked;
mod lock;
pub(crate) mod operations;
mod packages;
mod power;
mod process;
pub(crate) mod product_files;
mod replacement;
mod run_definitions;
pub(crate) mod session;
mod sources;
mod system;
pub(crate) mod terminal;

use crate::{encryption::Service, filesystem::Scope, routing::Registry};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use carrier::{Program, Transport, workspace};
use docker::{Identity, LocalDocker};
use operations::Operations;
use session::Session;
use std::path::Path;

const INSPECT: &str = "cantrip-os.inspect";
const ATTACH: &str = "cantrip-os.attach";
const LIST: &str = "cantrip-os.workspaces.list";
const CREATE: &str = "cantrip-os.workspaces.create";
const OPERATION: &str = "cantrip-os.operation.inspect";
const SOURCE_INSPECT: &str = "cantrip-os.source.inspect";
const SOURCE_PROVISION: &str = "cantrip-os.source.provision";
const SOURCE_CLIENT: &str = "cantrip-source-dispatch";

pub(crate) struct Controller {
    worker: JsString,
    operations: Operations,
    packages: packages::Manager,
    backup: backup::Manager,
    system: system::Manager,
}

fn checked(schema: &str, value: Value) -> Result<Value> {
    crate::http::checked(schema, &value)
}

async fn status(transport: &Transport, lifetime: &Scope) -> Result<Value> {
    let status = transport
        .control(Program::Executor, &["status"], lifetime)
        .await?;
    ensure!(
        status["service"] == "running",
        "The optional CantripOS executor is disabled or unavailable."
    );
    Ok(status)
}

pub(crate) async fn assert_scope(
    transport: &Transport,
    scope: &Value,
    attached: bool,
    lifetime: &Scope,
) -> Result<Value> {
    let status = status(transport, lifetime).await?;
    let owner = &status["attachment"];
    ensure!(
        status["instance_id"] == scope["guestInstanceId"]
            && status["generation"] == scope["runtimeGeneration"]
            && (!attached
                || (owner["owner_id"] == scope["ownerId"]
                    && owner["worker_id"] == scope["workerId"])),
        "The OS attachment/runtime changed; refresh its intended placement."
    );
    Ok(status)
}

async fn workspaces(transport: &Transport, lifetime: &Scope) -> Result<Vec<Value>> {
    let result = transport
        .control(Program::Workspaces, &["list"], lifetime)
        .await?;
    result
        .as_array()
        .context("Invalid OS workspace inventory.")?
        .iter()
        .map(workspace)
        .collect()
}

async fn local_carrier(name: &str, lifetime: &Scope) -> Result<(LocalDocker, Identity)> {
    let daemon = LocalDocker::current(lifetime).await?;
    let identity = daemon.inspect(name, lifetime).await?;
    Ok((daemon, identity))
}

async fn observed(transport: &Transport, lifetime: &Scope) -> Result<Value> {
    // A CLI connection to a remote daemon can still observe the executor. Only
    // repeatable inspection through a local Engine socket grants a power target.
    let carrier = match transport {
        Transport::Docker(name) => local_carrier(name, lifetime).await.ok(),
        Transport::Ssh { .. } => None,
    };
    let exact = carrier
        .as_ref()
        .map(|(_, identity)| Transport::Docker(identity.id.clone()));
    let selected = exact.as_ref().unwrap_or(transport);
    let actual = status(selected, lifetime).await?;
    let attachment = if actual["attachment"].is_null() {
        Value::Null
    } else {
        json!({"ownerId":actual["attachment"]["owner_id"],"workerId":actual["attachment"]["worker_id"]})
    };
    let mut result = json!({"guestInstanceId":actual["instance_id"],"runtimeGeneration":actual["generation"],
        "attachment":attachment,"workspaces":workspaces(selected, lifetime).await?});
    if let (Some((daemon, first)), Transport::Docker(name)) = (carrier, transport) {
        let second = daemon.inspect(name, lifetime).await?;
        ensure!(
            first == second,
            "The Docker carrier changed during guest observation."
        );
        result["powerTarget"] = json!({"kind":"docker","containerId":first.id});
    }
    checked("cantripOsObservedInstanceSchema", result)
}

impl Controller {
    pub fn new(data: &Path, worker: JsString) -> Self {
        Self {
            worker,
            operations: Operations::new(data),
            packages: packages::Manager::new(data),
            backup: backup::Manager::new(data),
            system: system::Manager::new(data),
        }
    }

    pub fn supports(kind: &str) -> bool {
        backup::supports(kind)
            || matches!(
                kind,
                INSPECT
                    | ATTACH
                    | LIST
                    | CREATE
                    | OPERATION
                    | SOURCE_INSPECT
                    | SOURCE_PROVISION
                    | desktop::STATUS
                    | desktop::OPERATION
                    | packages::STATUS
                    | packages::OPERATION
                    | power::STATUS
                    | power::OPERATION
                    | system::STATUS
                    | run_definitions::COMMAND
            )
    }

    pub async fn execute(
        &self,
        command: &Value,
        routing: &Registry,
        encryption: &Service,
        lifetime: &Scope,
    ) -> Result<Value> {
        let kind = command["type"].as_str().context("OS command type")?;
        let result = async {
            let resolved = routing.resolve(command).await?;
            let result = self
                .handle(kind, &resolved, routing, encryption, lifetime)
                .await?;
            routing.protect_result(kind, &result).await
        }
        .await;
        result.map_err(|error| crate::routing::protect_error(kind, error))
    }

    async fn handle(
        &self,
        kind: &str,
        command: &Value,
        routing: &Registry,
        encryption: &Service,
        lifetime: &Scope,
    ) -> Result<Value> {
        if kind == run_definitions::COMMAND {
            return run_definitions::execute(self, command, encryption, lifetime).await;
        }
        let dispatch = &command["scope"];
        let worker = if kind == INSPECT {
            &command["workerId"]
        } else {
            &dispatch["workerId"]
        };
        ensure!(
            worker.as_js_string() == Some(&self.worker),
            "The OS command belongs to a different worker."
        );
        if kind == OPERATION {
            return self
                .operations
                .inspect(dispatch, text(command, "operationId")?);
        }
        if matches!(kind, power::STATUS | power::OPERATION) {
            return power::execute(&self.operations, command, lifetime).await;
        }
        if matches!(kind, desktop::STATUS | desktop::OPERATION) {
            return desktop::execute(&self.operations, command, lifetime).await;
        }
        if matches!(kind, packages::STATUS | packages::OPERATION) {
            return self
                .packages
                .execute(&self.operations, command, encryption, lifetime)
                .await;
        }
        if backup::supports(kind) {
            return self
                .backup
                .execute(&self.operations, command, encryption, lifetime)
                .await;
        }
        if kind == system::STATUS {
            return self.system.status(command, encryption, lifetime).await;
        }
        let transport_value = checked("cantripOsTransportSchema", command["transport"].clone())?;
        let transport = Transport::from_value(&transport_value)?;
        if kind == INSPECT {
            return observed(&transport, lifetime).await;
        }
        if matches!(kind, SOURCE_PROVISION | SOURCE_INSPECT) {
            let scope = checked("cantripOsSourceDispatchScopeSchema", dispatch.clone())?;
            if kind == SOURCE_INSPECT {
                ensure!(
                    command["sourceKind"] == scope["sourceKind"],
                    "Source kind changed after admission."
                );
                assert_scope(&transport, &scope, true, lifetime).await?;
                if scope["mode"] == "linked" {
                    return linked::inspect(&transport, &scope, lifetime).await;
                }
                let source = sources::Source::new(&scope)?;
                let (mut session, _) =
                    Session::open(&transport, &scope, SOURCE_CLIENT, lifetime).await?;
                let result = source.inspect(&mut session).await;
                session.close().await;
                return result;
            }
            let intent = sources::intent(command, &scope, encryption, routing).await?;
            let id = text(command, "operationId")?;
            assert_scope(&transport, &scope, true, lifetime).await?;
            return self
                .operations
                .execute(&scope, id, kind, intent.clone(), async |journal| {
                    if scope["mode"] == "linked" {
                        return linked::install(&transport, &scope, id, journal, lifetime).await;
                    }
                    let source = sources::Source::new(&scope)?;
                    let (mut session, session_id) =
                        Session::open(&transport, &scope, SOURCE_CLIENT, lifetime).await?;
                    let result = async {
                        journal.bind(&session.binding, &session_id)?;
                        source.provision(&mut session, id, &intent, journal).await
                    }
                    .await;
                    session.close().await;
                    result
                })
                .await;
        }
        let dispatch = checked("cantripOsDispatchScopeSchema", dispatch.clone())?;
        assert_scope(&transport, &dispatch, kind != ATTACH, lifetime).await?;
        match kind {
            ATTACH => {
                transport
                    .control(
                        Program::Executor,
                        &[
                            "attach",
                            text(&dispatch, "ownerId")?,
                            text(&dispatch, "workerId")?,
                        ],
                        lifetime,
                    )
                    .await?;
                assert_scope(&transport, &dispatch, true, lifetime).await?;
                observed(&transport, lifetime).await
            }
            LIST => Ok(Value::Array(workspaces(&transport, lifetime).await?)),
            CREATE => {
                let guest = text(command, "guestWorkspaceId")?;
                let admission = json!({"guestWorkspaceId":guest,"transport":transport_value});
                self.operations
                    .execute(
                        &dispatch,
                        text(command, "operationId")?,
                        kind,
                        admission,
                        async |_| {
                            let actual = transport
                                .control(Program::Workspaces, &["create", guest], lifetime)
                                .await?;
                            Ok(json!({"kind":"workspace","workspace":workspace(&actual)?}))
                        },
                    )
                    .await
            }
            _ => anyhow::bail!("Unsupported OS command."),
        }
    }
}

pub(crate) fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .with_context(|| format!("Invalid OS command field {field}."))
}
