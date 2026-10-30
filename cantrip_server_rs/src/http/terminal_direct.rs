//! Legacy terminal direct bootstrap with preparation fencing and opaque state.
use super::{
    direct_attachments::authorization,
    middleware::Context,
    settings::{error, output, parse},
    worker_links::request_failure,
};
use crate::{
    auth::service::AuthService,
    direct_attachments::{PreparationLease, PrepareInput, Unavailable},
    terminals::Repository,
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::{bridge::EventHandler, command_bus::RequestTimeout},
};
use anyhow::{Context as _, Result, bail};
use axum::response::Response;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

fn active(service: &AuthService, lease: &PreparationLease) -> Result<()> {
    if !service.direct_attachments.preparation_active(lease) {
        return Err(
            Unavailable("The owning resource changed while direct access was opening.").into(),
        );
    }
    Ok(())
}

async fn ready(
    service: &AuthService,
    context: &Value,
    attachment: &str,
    launch: Value,
) -> Result<()> {
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
    let command = json!({"type":"terminal.open","terminalId":context["terminalId"],"attachmentId":attachment,"operationId":uuid::Uuid::new_v4().to_string(),"serverId":service.server_id,"worktreePath":context["worktreePath"],"stateProtection":context["stateProtection"],"cols":80,"rows":24,"outputMode":"discard","launch":launch});
    let commands = service.workers.commands.clone();
    let worker = context["workerId"]
        .as_str()
        .context("Terminal worker")?
        .to_owned();
    let completion = readiness.clone();
    // The Source waits for readiness, not completion of this streaming command.
    // A result arriving after readiness cannot undo the successful bootstrap.
    tokio::spawn(async move {
        let result: Result<()> = async {
            let result = commands
                .request_with_timeout(&worker, command, RequestTimeout::Disabled, Some(event))
                .await?;
            let result =
                crate::settings::parse_response("terminalOpenResultSchema", result.as_ref())?;
            if result["status"] == "exited" {
                bail!("Terminal process exited during startup.");
            }
            Ok(())
        }
        .await;
        if let Err(cause) = result
            && let Some(send) = completion.lock().unwrap().take()
        {
            let _ = send.send(Err(cause));
        }
    });
    tokio::time::timeout(Duration::from_secs(15), receive)
        .await
        .map_err(|_| anyhow::anyhow!("Terminal process startup timed out."))?
        .context("Terminal readiness ended")?
}

async fn detach(service: &AuthService, context: &Value, attachment: &str) -> Result<()> {
    service.workers.commands.request(context["workerId"].as_str().context("Terminal worker")?,json!({"type":"terminal.detach","terminalId":context["terminalId"],"attachmentId":attachment}),None,None).await?;
    Ok(())
}

pub(super) async fn execute(
    service: &AuthService,
    ctx: &Context,
    terminal: &str,
    body: Option<&Value>,
) -> Result<Response> {
    let input = match parse("projectShareDirectCreateSchema", body)? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let auth = authorization(ctx);
    let owner = auth["ownerId"].as_str().context("Terminal direct owner")?;
    let direct = &service.direct_attachments;
    let lease_input = json!({"authSessionId":auth["authSessionId"],"ownerId":owner,"resourceId":terminal,"resourceKind":"terminal"});
    let Some(lease) = direct.acquire_preparation(lease_input.clone()) else {
        return Ok(error(409, "The owning resource is being revoked."));
    };
    let result: Result<Response> = async {
        let Some(context) = Repository::new(service.repository.database.clone()).context(owner, terminal).await? else {
            return Ok(error(404,"Terminal not found."));
        };
        if context["kind"] == "run-configuration" || !truthy(context.get("stateProtection")) {
            return Ok(error(409,"Run configuration terminals are read-only and use the managed runtime output API."));
        }
        active(service, &lease)?;
        let worker = service.workers.repository.get_worker(owner,context["workerId"].as_str().context("Terminal worker")?).await?;
        active(service, &lease)?;
        let Some(worker) = worker.filter(|_|service.workers.bridge.is_connected(context["workerId"].as_str().unwrap())) else {
            return Ok(error(409,"Project worker is offline."));
        };
        let bootstrap = format!("direct-bootstrap:{}",uuid::Uuid::new_v4());
        let mut started = false;
        let result: Result<Response> = async {
            active(service,&lease)?;
            let mut launch = json!({"type":"shell"});
            if truthy(context.get("linkedChatId")) {
                let chat = crate::chats::Repository::new(service.repository.database.clone()).execution_context(owner,context["linkedChatId"].as_str().context("Linked chat")?).await?;
                let runtime = if let Some(chat)=chat.as_ref(){service.model_routing.runtime_for_context(owner,chat).await?}else{None};
                let (Some(chat),Some(runtime))=(chat,runtime)else{return Ok(error(409,"Choose a model for this chat before opening its Codex console."));};
                launch=service.managed_console.prepare_launch(owner,&chat,&runtime).await?;
                active(service,&lease)?;
            }
            active(service,&lease)?;
            started=true;
            ready(service,&context,&bootstrap,launch).await?;
            active(service,&lease)?;
            detach(service,&context,&bootstrap).await?;
            active(service,&lease)?;
            service.worker_maintenance.record_status(owner,terminal,"running").await?;
            active(service,&lease)?;
            let attachment=uuid::Uuid::new_v4().to_string();
            let source=JsString::new("desktop:".encode_utf16().chain(input["clientId"].as_js_string().unwrap().units().iter().copied()).chain(format!(":{attachment}").encode_utf16()).collect());
            let route=json!({"tunnelId":format!("terminal:{terminal}"),"attachmentId":attachment,"sourceEndpointId":Value::String(source),"destinationEndpointId":format!("worker:{}",context["workerId"].as_str().unwrap())});
            let mut value=lease_input;
            value["attachmentId"]=json!(attachment);
            value["channels"]=json!(["tunnel-data"]);
            value["worker"]=Value::from_serialize(&worker);
            value["leaseExpiresAt"]=json!(crate::auth::iso(crate::auth::now()+chrono::Duration::hours(12)));
            let mut tunnel_route=route.clone();
            tunnel_route["target"]=json!({"kind":"adapter","adapter":"terminal","resourceId":context["terminalId"],"serverId":service.server_id});
            value["tunnelRoute"]=tunnel_route;
            let mut ticket=direct.prepare(PrepareInput{lease:lease.clone(),value}).await?;
            if !direct.preparation_active(&lease) {
                direct.revoke(ticket["binding"]["capabilityId"].as_str().unwrap(),"Owning resource was revoked",None).await;
                return Err(Unavailable("The owning resource changed while direct access was opening.").into());
            }
            ticket["route"]=route;
            output(201,"directTunnelTicketSchema",&ticket)
        }.await;
        match result {
            Ok(response)=>Ok(response),
            Err(cause)=>{
                if !direct.preparation_active(&lease) && started {
                    let _=service.workers.commands.request(context["workerId"].as_str().unwrap(),json!({"type":"terminal.close","terminalId":context["terminalId"]}),Some(Duration::from_secs(5)),None).await;
                    let _=service.worker_maintenance.record_status(owner,terminal,"idle").await;
                } else {let _=detach(service,&context,&bootstrap).await;}
                Ok(if cause.is::<Unavailable>(){error(409,cause.to_string())}else{request_failure(&cause)})
            }
        }
    }.await;
    direct.release_preparation(&lease);
    match result {
        Err(cause) if cause.is::<Unavailable>() => Ok(error(409, cause.to_string())),
        result => result,
    }
}
