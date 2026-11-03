//! Protected terminal grants, including actual managed Codex console launch.
use super::{
    middleware::Context,
    settings::{error, output, parse},
    worker_links::{authorized, failure, request_failure},
};
use crate::{
    auth::service::AuthService,
    terminals::Repository,
    wire::{Value, coercion::truthy, value::json},
    worker_links::Error,
    workers::{
        bridge::EventHandler,
        command_bus::{CommandFailure, RequestTimeout},
    },
};
use anyhow::{Context as _, Result, bail};
use axum::response::Response;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

async fn bootstrap(
    service: &AuthService,
    context: &Value,
    owner: &str,
    operation: &Value,
    attachment: &str,
    launch: Value,
    detached: &mut bool,
) -> Result<()> {
    let worker = context["workerId"]
        .as_str()
        .context("Terminal worker")?
        .to_owned();
    let terminal = context["terminalId"]
        .as_str()
        .context("Terminal identity")?
        .to_owned();
    let (send, receive) = tokio::sync::oneshot::channel::<Result<()>>();
    let readiness = Arc::new(Mutex::new(Some(send)));
    let event: EventHandler = {
        let readiness = readiness.clone();
        Arc::new(move |event| {
            let readiness = readiness.clone();
            Box::pin(async move {
                if event["type"] == "terminal.ready"
                    && let Some(send) = readiness.lock().unwrap().take()
                {
                    let _ = send.send(Ok(()));
                }
                Ok(())
            })
        })
    };
    let command = json!({"type":"terminal.open","terminalId":context["terminalId"],"attachmentId":attachment,"operationId":operation,"serverId":service.server_id,"worktreePath":context["worktreePath"],"stateProtection":context["stateProtection"],"cols":80,"rows":24,"outputMode":"discard","launch":launch});
    let commands = service.workers.commands.clone();
    let maintenance = service.worker_maintenance.clone();
    let completion = readiness.clone();
    let owner = owner.to_owned();
    let (opened_send, opened_receive) = tokio::sync::oneshot::channel();
    // The Source observes completion independently of readiness and detach.
    // An exit still updates status after readiness has already succeeded.
    tokio::spawn(async move {
        match commands
            .request_with_timeout(&worker, command, RequestTimeout::Disabled, Some(event))
            .await
        {
            Err(cause) => {
                let pending = completion.lock().unwrap().take();
                if let Some(send) = pending {
                    let _ = send.send(Err(cause.into()));
                } else {
                    let _ = opened_send.send(Err(cause));
                }
            }
            Ok(value) => {
                let observed: Result<()> = async {
                    let parsed = crate::settings::parse_response(
                        "terminalOpenResultSchema",
                        value.as_ref(),
                    )?;
                    if parsed["status"] == "exited" {
                        maintenance
                            .record_status(
                                &owner,
                                &terminal,
                                if parsed["executionOutcome"] == "unknown" {
                                    "offline"
                                } else {
                                    "exited"
                                },
                            )
                            .await?;
                        bail!(if parsed["executionOutcome"] == "unknown" {
                            "The Linux terminal disconnected; command outcome is unknown."
                        } else {
                            "Terminal process exited during startup."
                        });
                    }
                    Ok(())
                }
                .await;
                if let Err(cause) = observed
                    && let Some(send) = completion.lock().unwrap().take()
                {
                    let _ = send.send(Err(cause));
                }
                let _ = opened_send.send(Ok(value));
            }
        }
    });
    tokio::time::timeout(Duration::from_secs(15), receive)
        .await
        .map_err(|_| anyhow::anyhow!("Terminal process startup timed out."))?
        .context("Terminal readiness ended")??;
    detach(service, context, attachment).await?;
    *detached = true;
    let opened = opened_receive
        .await
        .context("Terminal open completion ended")??;
    crate::settings::parse_response("terminalOpenResultSchema", opened.as_ref())?;
    Ok(())
}
async fn detach(service: &AuthService, context: &Value, attachment: &str) -> Result<()> {
    service.workers.commands.request(context["workerId"].as_str().context("Terminal worker")?,json!({"type":"terminal.detach","terminalId":context["terminalId"],"attachmentId":attachment}),Some(Duration::from_secs(5)),None).await?;
    Ok(())
}
pub(super) async fn execute(
    service: &AuthService,
    ctx: &Context,
    session_id: &str,
    terminal_id: &str,
    body: Option<&Value>,
) -> Result<Response> {
    let input = match parse("workerLinkTerminalGrantRequestSchema", body)? {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let Some(session) = authorized(service, ctx, session_id) else {
        return Ok(error(404, "WorkerLink session not found."));
    };
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("Terminal grant owner")?
        .id;
    let repository = Repository::new(service.repository.database.clone());
    let Some(context) = repository.context(owner, terminal_id).await? else {
        return Ok(error(404, "Terminal not found."));
    };
    if context["kind"] == "run-configuration" || !truthy(context.get("stateProtection")) {
        return Ok(error(
            409,
            "Run configuration terminals are read-only and use the managed runtime output API.",
        ));
    }
    if context["workerId"] != session["identity"]["workerId"] {
        return Ok(error(
            409,
            "Terminal placement does not match the WorkerLink session.",
        ));
    }
    let worker = context["workerId"]
        .as_str()
        .context("Terminal grant worker")?;
    if !service.workers.bridge.is_connected(worker) {
        service
            .worker_maintenance
            .record_status(owner, terminal_id, "offline")
            .await?;
        return Ok(error(503, "Project worker is offline."));
    }
    let attachment = format!("worker-link-bootstrap:{}", uuid::Uuid::new_v4());
    let mut detached = false;
    let result:Result<Response>=async {
        let mut launch=json!({"type":"shell"});
        if truthy(context.get("linkedChatId")) {
            let chat=crate::chats::Repository::new(service.repository.database.clone()).execution_context(owner,context["linkedChatId"].as_str().context("Linked chat")?).await?;
            let runtime=if let Some(chat)=chat.as_ref(){service.model_routing.runtime_for_context(owner,chat).await?}else{None};
            let (Some(chat),Some(runtime))=(chat,runtime)else{return Ok(error(409,"Choose a model for this chat before opening its Codex console."));};
            launch=service.managed_console.prepare_launch(owner,&chat,&runtime).await?;
        }
        bootstrap(service,&context,owner,&input["operationId"],&attachment,launch,&mut detached).await?;
        service.worker_maintenance.record_status(owner,terminal_id,"running").await?;
        let grant=service.worker_links.local.issue_grant(json!({"attachmentId":input["operationId"],"lanes":["interactive"],"maxChannels":1,"operations":["stream:open","stream:read","stream:write"],"resourceId":context["terminalId"],"resourceKind":"terminal","sessionId":session["sessionId"]})).await?;
        let current=repository.context(owner,terminal_id).await?;
        if current.as_ref().is_none_or(|v|v["kind"]=="run-configuration" || v["workerId"]!=context["workerId"] || v["worktreePath"]!=context["worktreePath"]) {
            service.worker_links.local.revoke_grant(session_id,grant["binding"]["grantId"].as_str().context("Terminal grant identity")?,if current.is_some(){"resource-stopped"}else{"resource-deleted"}).await;
            return Ok(error(409,"Terminal placement changed while its stream was opening."));
        }
        output(201,"workerLinkResourceGrantSchema",&grant)
    }.await;
    if let Err(cause) = &result
        && !detached
    {
        let offline = matches!(cause.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable);
        let _ = service
            .worker_maintenance
            .record_status(
                owner,
                terminal_id,
                if offline { "offline" } else { "failed" },
            )
            .await;
    }
    if !detached && service.workers.bridge.is_connected(worker) {
        let _ = detach(service, &context, &attachment).await;
    }
    Ok(result.unwrap_or_else(|cause| {
        cause
            .downcast_ref::<Error>()
            .map_or_else(|| request_failure(&cause), failure)
    }))
}
