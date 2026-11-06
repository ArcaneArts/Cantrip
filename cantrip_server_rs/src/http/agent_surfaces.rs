//! MCP surface operations retain captured placement and opaque endpoint data.
use super::agent_operations::{OperationError, parse};
use crate::{
    auth::service::AuthService,
    database::Executor,
    projects::targets::TargetRepository,
    wire::{self, Value, value::json},
};
use anyhow::{Context, Result};
use std::{sync::Arc, time::Duration};

fn invalid(message: &str) -> anyhow::Error {
    OperationError::new(400, "invalid", message).into()
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("MCP surface identity")?
        .lossy()
        .into_owned())
}
fn surface_target(arguments: &Value, kind: &str) -> Result<Value> {
    let target = wire::parse("executionTargetSchema", arguments.get("target"))
        .map_err(|_| invalid("A valid execution target is required."))?;
    if target["kind"] != "surface" || target["surfaceKind"] != kind {
        return Err(invalid(&format!(
            "An exact {kind} surface target is required."
        )));
    }
    Ok(target)
}
fn surface_wire(arguments: &Value) -> Result<Value> {
    let input = Value::object(
        ["operationId", "sequence", "protectedRequest"]
            .into_iter()
            .filter_map(|key| arguments.get(key).map(|value| (key, value.clone()))),
    );
    parse("surfaceStreamWireRequestSchema", &input)
}
fn interaction_query() -> &'static str {
    static QUERIES: std::sync::OnceLock<std::collections::HashMap<String, String>> =
        std::sync::OnceLock::new();
    &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/mcp-surface-queries.json"))
            .expect("generated MCP surface read queries")
    })["interactionGet"]
}
fn result(
    summary: String,
    target: Value,
    worktree: Option<Value>,
    mutated: bool,
    data: Option<Value>,
) -> Result<Value> {
    let mut value = json!({"summary":summary,"target":target,"mutated":mutated});
    if let Some(worktree) = worktree {
        value["worktreeId"] = worktree;
    }
    if let Some(data) = data {
        value["data"] = data;
    }
    parse("cantripAgentOperationResultSchema", &value)
}
async fn resolve(
    service: &AuthService,
    owner: &str,
    context: &Value,
    target: &Value,
) -> Result<Value> {
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    TargetRepository::for_mcp(service.repository.database.clone())
        .resolve(
            owner,
            &text(&context["projectId"])?,
            target,
            Some(&connected),
            false,
        )
        .await
}

pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    if context["contextKind"] != "project" {
        return Err(OperationError::new(
            409,
            "unsupported-capability",
            "Standalone Chats do not support IDE execution operations.",
        )
        .into());
    }
    if operation.starts_with("client.") {
        return client(service, owner, context, operation, arguments).await;
    }
    let kind = operation
        .split('.')
        .next()
        .context("MCP surface operation")?;
    let target = surface_target(arguments, kind)?;
    let resolution = resolve(service, owner, context, &target).await?;
    let worker = text(&resolution["placement"]["workerId"])?;
    let worktree = Some(resolution["placement"]["worktreeId"].clone());
    match operation {
        "explorer.list" | "explorer.read" | "explorer.write" => {
            let explorer =
                crate::project_surfaces::Repository::new(service.repository.database.clone())
                    .context(
                        crate::project_surfaces::Kind::Explorer,
                        owner,
                        &text(&target["surfaceId"])?,
                    )
                    .await?;
            let writing = operation == "explorer.write";
            let message = if writing {
                "Explorer placement changed before the write."
            } else {
                "Explorer placement changed before the read."
            };
            let explorer = explorer
                .filter(|value| {
                    value["workerId"] == resolution["placement"]["workerId"]
                        && value["worktreeId"] == resolution["placement"]["worktreeId"]
                })
                .ok_or_else(|| invalid(message))?;
            let wire = surface_wire(arguments)?;
            let command = json!({"type":"explorer.operation","explorerId":explorer["explorerId"],
                "serverId":service.server_id,"root":explorer["root"],"operationId":wire["operationId"],
                "sequence":wire["sequence"],"protectedRequest":wire["protectedRequest"]});
            let reply = service
                .workers
                .commands
                .request(&worker, command, None, None)
                .await?;
            let data =
                crate::settings::parse_response("surfaceStreamWireResponseSchema", reply.as_ref())?;
            if writing {
                let scope = json!({"kind":"project","projectId":context["projectId"]});
                let _ = service
                    .live
                    .publish_event(json!({"ownerId":owner,"scope":scope,
                    "resource":"explorer","action":"invalidated","entityId":target["surfaceId"],
                    "revision":Value::Null,"payload":Value::Null}));
            }
            result(
                if writing {
                    "Encrypted Explorer write completed."
                } else {
                    "Encrypted Explorer operation completed."
                }
                .into(),
                target,
                worktree,
                writing,
                Some(data),
            )
        }
        "terminal.read" => {
            let wire = surface_wire(arguments)?;
            let command = json!({"type":"terminal.snapshot","terminalId":target["surfaceId"],
                "serverId":service.server_id,"operationId":wire["operationId"],"sequence":wire["sequence"],
                "protectedRequest":wire["protectedRequest"]});
            let reply = service
                .workers
                .commands
                .request(&worker, command, None, None)
                .await?;
            let data =
                crate::settings::parse_response("surfaceStreamWireResponseSchema", reply.as_ref())?;
            result(
                "Encrypted terminal snapshot completed.".into(),
                target,
                worktree,
                false,
                Some(data),
            )
        }
        "terminal.send" | "terminal.restart" => {
            let terminal = crate::terminals::Repository::new(service.repository.database.clone())
                .context(owner, &text(&target["surfaceId"])?)
                .await?;
            let restarting = operation == "terminal.restart";
            let message = if restarting {
                "Terminal placement changed before restart."
            } else {
                "Terminal placement changed before input."
            };
            let terminal = terminal
                .filter(|value| {
                    value["workerId"] == resolution["placement"]["workerId"]
                        && value["worktreeId"] == resolution["placement"]["worktreeId"]
                })
                .ok_or_else(|| invalid(message))?;
            if restarting {
                if terminal["serviceEnabled"] != true {
                    return Err(invalid("Terminal service is disabled."));
                }
                service
                    .workers
                    .commands
                    .request(
                        &worker,
                        json!({"type":"terminal.service.restart","terminalId":target["surfaceId"]}),
                        Some(Duration::from_secs(30)),
                        None,
                    )
                    .await?;
                service
                    .worker_maintenance
                    .record_status(owner, &text(&target["surfaceId"])?, "running")
                    .await?;
                result(
                    format!(
                        "Restarted the terminal service on {}.",
                        text(&resolution["worker"]["name"])?
                    ),
                    target,
                    worktree,
                    true,
                    None,
                )
            } else {
                if terminal["kind"] == "run-configuration" {
                    return Err(OperationError::new(409, "conflict", "Run configuration terminals are read-only. Use the Run configuration lifecycle and output operations instead.").into());
                }
                let wire = surface_wire(arguments)?;
                let command = json!({"type":"terminal.input","terminalId":target["surfaceId"],
                    "serverId":service.server_id,"operationId":wire["operationId"],"sequence":wire["sequence"],
                    "protectedData":wire["protectedRequest"],"complete":true});
                let reply = service
                    .workers
                    .commands
                    .request(&worker, command, Some(Duration::from_secs(30)), None)
                    .await?;
                let data = crate::settings::parse_response(
                    "surfaceStreamWireResponseSchema",
                    reply.as_ref(),
                )?;
                result(
                    "Encrypted terminal input completed.".into(),
                    target,
                    worktree,
                    true,
                    Some(data),
                )
            }
        }
        "browser.services" => {
            let reply = service
                .workers
                .commands
                .request(
                    &worker,
                    json!({"type":"browser.services.discover"}),
                    Some(Duration::from_secs(20)),
                    None,
                )
                .await?;
            let discovered =
                crate::settings::parse_response("browserServiceListSchema", reply.as_ref())?;
            let mut services = discovered.as_array().context("Browser services")?.clone();
            for service in &mut services {
                service["workerId"] = json!(worker);
            }
            let data = parse("browserServiceListSchema", &Value::Array(services))?;
            let count = data.as_array().unwrap().len();
            result(
                format!(
                    "Found {count} browser service{} on {}.",
                    if count == 1 { "" } else { "s" },
                    text(&resolution["worker"]["name"])?
                ),
                target,
                worktree,
                false,
                Some(data),
            )
        }
        "browser.open" => {
            let input = Value::object(
                ["expectedStateRevision", "stateProtection"]
                    .into_iter()
                    .filter_map(|key| arguments.get(key).map(|value| (key, value.clone()))),
            );
            let input = parse("encryptedBrowserUpdateSchema", &input)?;
            let browser = crate::browsers::runtime::update(
                service,
                owner,
                &text(&target["surfaceId"])?,
                &input,
                Some(&worker),
                true,
            )
            .await?
            .ok_or_else(|| invalid("Browser not found."))?;
            result(
                format!(
                    "Navigated the browser on {}.",
                    text(&resolution["worker"]["name"])?
                ),
                target,
                None,
                true,
                Some(browser),
            )
        }
        _ => Err(invalid("Unsupported MCP surface operation.")),
    }
}

async fn client(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    let project_target = json!({"kind":"project","projectId":context["projectId"]});
    let (command, target, worktree, label) = match operation {
        "client.notify" => {
            let input = parse("protectedClientNotificationSchema", arguments)?;
            (
                json!({"kind":"notify","projectId":context["projectId"],"workerId":context["workerId"],
                "operationId":input["operationId"],"protectedContent":input["protectedContent"]}),
                project_target,
                context["worktreeId"].clone(),
                "notification",
            )
        }
        "client.focus-project" => {
            parse("cantripMcpClientFocusProjectInputSchema", arguments)?;
            (
                json!({"kind":"focus-project","projectId":context["projectId"]}),
                project_target,
                context["worktreeId"].clone(),
                "project focus",
            )
        }
        "client.focus-surface" => {
            let input = parse("cantripMcpClientFocusSurfaceInputSchema", arguments)?;
            let target = &input["target"];
            if target["projectId"] != context["projectId"] {
                return Err(invalid(
                    "The client-control target is outside the bound Cantrip project.",
                ));
            }
            let resolution = resolve(service, owner, context, target).await?;
            (
                json!({"kind":"focus-surface","projectId":context["projectId"],"surfaceKind":target["surfaceKind"],
                "surfaceId":target["surfaceId"]}),
                target.clone(),
                resolution["placement"]["worktreeId"].clone(),
                "surface focus",
            )
        }
        "client.show-interaction" => {
            if context["chatId"].is_null() {
                return Err(invalid("Client interaction focus requires a chat binding."));
            }
            let input = parse("cantripMcpClientShowInteractionInputSchema", arguments)?;
            let interaction = crate::agent_interactions::Repository::new(Executor::Database(
                &service.repository.database,
            ))
            .get_with_query_context(
                owner,
                &text(&input["interactionId"])?,
                Some((
                    interaction_query(),
                    &[input["interactionId"].clone(), json!(owner), json!(1)],
                )),
            )
            .await?;
            if !interaction.is_some_and(|value| {
                value["projectId"] == context["projectId"]
                    && value["provenance"]["chatId"] == context["chatId"]
                    && value["status"] == "pending"
            }) {
                return Err(invalid(
                    "The interaction is not pending in the bound Cantrip chat.",
                ));
            }
            let target = json!({"kind":"surface","projectId":context["projectId"],"surfaceKind":"chat", "surfaceId":context["chatId"]});
            resolve(service, owner, context, &target).await?;
            (
                json!({"kind":"show-interaction","projectId":context["projectId"],"chatId":context["chatId"],
                "interactionId":input["interactionId"]}),
                target,
                context["worktreeId"].clone(),
                "interaction focus",
            )
        }
        _ => return Err(invalid("Unsupported MCP client operation.")),
    };
    let data = service
        .live
        .hub
        .request_control(owner, command, 10_000)
        .await?;
    let mutated = data["status"] == "applied";
    result(
        format!("Client {label} {}.", text(&data["status"])?),
        target,
        Some(worktree),
        mutated,
        Some(data),
    )
}
