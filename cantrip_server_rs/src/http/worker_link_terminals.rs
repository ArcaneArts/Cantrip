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
    operation: &Value,
    attachment: &str,
    launch: Value,
    detached: &mut bool,
) -> Result<()> {
    let worker = context["workerId"].as_str().context("Terminal worker")?;
    let (send, mut receive) = tokio::sync::oneshot::channel();
    let readiness = Arc::new(Mutex::new(Some(send)));
    let event: EventHandler = {
        let readiness = readiness.clone();
        Arc::new(move |event| {
            let readiness = readiness.clone();
            Box::pin(async move {
                if event["type"] == "terminal.ready"
                    && let Some(send) = readiness.lock().unwrap().take()
                {
                    let _ = send.send(());
                }
                Ok(())
            })
        })
    };
    let command = json!({"type":"terminal.open","terminalId":context["terminalId"],"attachmentId":attachment,"operationId":operation,"serverId":service.server_id,"worktreePath":context["worktreePath"],"stateProtection":context["stateProtection"],"cols":80,"rows":24,"outputMode":"discard","launch":launch});
    let mut opened = Box::pin(async {
        let result = service
            .workers
            .commands
            .request_with_timeout(worker, command, RequestTimeout::Disabled, Some(event))
            .await?;
        crate::settings::parse_response("terminalOpenResultSchema", result.as_ref())
    });
    let startup = tokio::time::sleep(Duration::from_secs(15));
    tokio::pin!(startup);
    let mut result = None;
    loop {
        tokio::select! {
            biased;
            ready=&mut receive=>{ready.context("Terminal readiness ended")?;break;}
            value=&mut opened, if result.is_none()=>{
                let value=value?;
                if value["status"]=="exited" {bail!("Terminal process exited during startup.");}
                result=Some(value);
            }
            _=&mut startup=>bail!("Terminal process startup timed out."),
        }
    }
    detach(service, context, attachment).await?;
    *detached = true;
    if result.is_none() {
        opened.await?;
    }
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
        bootstrap(service,&context,&input["operationId"],&attachment,launch,&mut detached).await?;
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
