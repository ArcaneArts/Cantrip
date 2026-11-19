//! Route Run definition operations to a finite child on the captured Linux
//! Primary. A saved admission may observe its process after a disconnect.
use super::{
    Controller, assert_scope,
    carrier::{DeliveryUnknown, Transport},
    checked,
    process::{self, Invocation, Limits, Output},
    session::Session,
    text,
};
use crate::{encryption::Service, filesystem::Scope};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::time::Duration;

pub(super) const COMMAND: &str = "cantrip-os.run-definition";
const PREFIX: &str = "project.run-configuration-definitions.";
const LIMITS: Limits = Limits {
    deadline: Duration::from_secs(180),
    output: 8 * 1024 * 1024,
};
const HELPER: &str = "/usr/lib/cantrip-os-executor/cantrip-os-run-definitions";
const UNCERTAIN: &str = "The Linux Run definition outcome is unknown. Observe this same operation; its mutation was not repeated.";

pub(super) async fn execute(
    controller: &Controller,
    command: &Value,
    encryption: &Service,
    lifetime: &Scope,
) -> Result<Value> {
    let command = checked("cantripOsRunDefinitionWorkerCommandSchema", command.clone())?;
    let execution = &command["execution"];
    let request = &command["request"];
    let (owner, server) = encryption.bound_identity()?;
    let mut scope = execution["scope"].clone();
    ensure!(
        scope["ownerId"].as_js_string() == Some(&owner)
            && request["projectId"] == scope["projectId"],
        "The Linux Run definition belongs to another account or project."
    );
    ensure!(
        scope["workerId"].as_js_string() == Some(&controller.worker),
        "The Linux Run definition belongs to another worker."
    );
    scope["serverId"] = server;
    let transport = Transport::from_value(&execution["transport"])?;
    assert_scope(&transport, &scope, true, lifetime).await?;
    let binding = Session::capture_binding(&transport, &scope, lifetime).await?;
    let id = text(request, "operationId")?;
    let cwd = text(&scope, "guestPath")?;
    let mut record = controller
        .operations
        .execute_record(
            &scope,
            id,
            COMMAND,
            json!({"execution":execution,"request":request}),
            async |journal| {
                let (mut session, native) = Session::connect(
                    &transport,
                    binding.clone(),
                    "cantrip-run-definitions",
                    None,
                    lifetime,
                )
                .await?;
                let result = async {
                    journal.bind(&session.binding, &native)?;
                    let input = request.stringify() + "\n";
                    let output = process::run(
                        &mut session,
                        Some(journal),
                        Invocation {
                            argv: &[HELPER, cwd],
                            cwd,
                            env: json!({}),
                            input: Some(input.as_bytes()),
                        },
                        LIMITS,
                    )
                    .await?;
                    response(request, output)
                }
                .await;
                session.close().await;
                result
            },
        )
        .await?;
    if record["state"] == "unknown"
        && let Some([saved]) = record["processes"].as_array().map(Vec::as_slice)
        && record["native"].is_object()
    {
        let result = observe(
            &transport,
            binding,
            &record["native"],
            saved,
            request,
            lifetime,
        )
        .await
        .map_err(|_| DeliveryUnknown(UNCERTAIN.into()))?;
        record = controller.operations.complete_observed(&record, result)?;
    }
    ensure!(
        record["state"] == "ready",
        "{}",
        if matches!(record["state"].as_str(), Some("running" | "unknown")) {
            UNCERTAIN
        } else {
            "The Linux Run definition operation failed. Inspect Worker diagnostics before issuing a new operation."
        }
    );
    let result = checked(
        "runConfigurationOperationResponseSchema",
        record["receipt"].clone(),
    )?;
    identity(request, &result)?;
    Ok(result)
}

async fn observe(
    transport: &Transport,
    binding: Value,
    native: &Value,
    saved: &Value,
    request: &Value,
    lifetime: &Scope,
) -> Result<Value> {
    let prior = text(native, "sessionId")?;
    let process_id = text(saved, "processId")?;
    ensure!(
        binding["executor_generation"] == native["binding"]["executor_generation"],
        "The Linux definition executor changed; its mutation was not repeated."
    );
    let (mut session, actual) = Session::connect(
        transport,
        binding,
        "cantrip-run-definition-observe",
        Some(prior),
        lifetime,
    )
    .await?;
    let result = async {
        ensure!(
            actual == prior,
            "The Linux definition session changed; its mutation was not repeated."
        );
        response(
            request,
            process::observe(&mut session, process_id, LIMITS).await?,
        )
    }
    .await;
    session.close().await;
    result
}

fn identity(request: &Value, result: &Value) -> Result<()> {
    let action = text(request, "type")?
        .strip_prefix(PREFIX)
        .context("Linux Run definition action")?;
    ensure!(
        result["projectId"] == request["projectId"]
            && result["operationId"] == request["operationId"]
            && result["operation"] == action,
        "The Linux Run definition result was misrouted."
    );
    Ok(())
}

fn response(request: &Value, output: Output) -> Result<Value> {
    if !output.successful {
        let diagnostic: String = output
            .stderr
            .chars()
            .rev()
            .take(4000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(DeliveryUnknown(format!(
            "The Linux Run definition helper did not complete: {diagnostic}"
        ))
        .into());
    }
    let result = (|| {
        let value =
            parse_json_text(&output.stdout).map_err(|_| anyhow!("Invalid Run definition JSON"))?;
        let result = checked("runConfigurationOperationResponseSchema", value)?;
        identity(request, &result)?;
        Ok(result)
    })();
    result.map_err(|_: anyhow::Error| DeliveryUnknown(
        "The Linux Run definition completion is unreadable or misrouted; its mutation was not repeated.".into()
    ).into())
}
