//! Desktop tunnel grants retain both preparation and persisted credential fences.
use super::{
    middleware::Context,
    settings::{error, output, parse},
    worker_links::{authorized, failure, request_failure},
};
use crate::{
    auth::service::AuthService,
    tunnels::{Repository, Time},
    wire::{Value, value::json},
    worker_links::Error,
};
use anyhow::{Context as _, Result};
use axum::response::Response;
use std::time::Duration;
pub(super) async fn execute(
    service: &AuthService,
    ctx: &Context,
    session_id: &str,
    attachment: &str,
    body: Option<&Value>,
) -> Result<Response> {
    if let Err(response) = parse("workerLinkTunnelGrantRequestSchema", body)? {
        return Ok(response);
    }
    let Some(session) = authorized(service, ctx, session_id) else {
        return Ok(error(404, "WorkerLink session not found."));
    };
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("Tunnel grant owner")?
        .id;
    let account = ctx
        .principal
        .session_id
        .clone()
        .unwrap_or_else(|| format!("local:{owner}"));
    let direct = &service.direct_attachments;
    let Some(lease)=direct.acquire_preparation(json!({"attachmentId":attachment,"authSessionId":account,"ownerId":owner,"resourceId":Value::Null,"resourceKind":"tunnel"}))else{return Ok(error(409,"The tunnel attachment is being revoked."))};
    let repository = Repository::new(service.repository.database.clone());
    let mut grant_id = None;
    let result:Result<Response>=async {
        let Some(auth)=repository.attachment(owner,attachment).await?else{return Ok(error(404,"Tunnel attachment not found."))};
        if auth["destination"]["workerId"]!=session["identity"]["workerId"] {return Ok(error(409,"Tunnel placement does not match the WorkerLink session."))}
        let worker=auth["destination"]["workerId"].as_str().context("Tunnel destination worker")?;
        if !service.workers.bridge.is_connected(worker){return Ok(error(503,"Destination worker is offline."))}
        if !direct.bind_preparation(&lease,json!("tunnel"),auth["tunnelId"].clone()){return Ok(error(409,"The tunnel attachment changed while opening."))}
        let guest=auth["destination"]["kind"]=="worker-adapter" && auth["destination"]["adapter"]=="cantrip-os";
        let os_execution=repository.os_attachment_execution(&auth).await?;
        let mut grant_input=json!({"absoluteExpiresAt":auth["expiresAt"],"attachmentId":auth["attachmentId"],"lanes":["stream"],"maxChannels":1,"operations":["stream:open","stream:read","stream:write","stream:half-close"],"resourceId":auth["tunnelId"],"resourceKind":"tunnel","sessionId":session["sessionId"]});
        if guest {grant_input["operations"]=json!(["stream:open","stream:read","stream:write","stream:half-close","stream:guest-connect"]);}
        let grant=service.worker_links.local.issue_grant(grant_input).await?;
        grant_id=Some(grant["binding"]["grantId"].as_str().context("Tunnel grant identity")?.to_owned());
        let mut service_identity=auth["osServiceIdentity"].clone();
        if let Some(execution)=&os_execution {
            let prepared=service.workers.commands.request(worker,json!({"type":"surface.tunnel.os-prepare","serverId":session["identity"]["serverId"],"projectId":auth["projectId"],"tunnelId":auth["tunnelId"],"attachmentId":auth["attachmentId"],"grantId":grant["binding"]["grantId"],"expiresAt":grant["binding"]["lease"]["absoluteExpiresAt"],"expectedIdentity":auth["osServiceIdentity"],"protectedRecord":auth["protectedRecord"],"osExecution":execution}),Some(Duration::from_secs(30)),None).await?;
            let prepared=crate::settings::parse_response("tunnelOsPrepareResultSchema",prepared.as_ref())?;
            if !repository.pin_os_service_identity(&auth,prepared["identity"].as_str().context("OS service identity")?).await? {
                return Err(crate::tunnels::ManagementError("The OS tunnel attachment was retired during preparation.").into());
            }
            service_identity=prepared["identity"].clone();
        }
        let current=repository.attachment(owner,attachment).await?;
        let source_changed=if let Some(current)=&current {guest && (current["osServiceIdentity"]!=service_identity || repository.os_attachment_execution(current).await?!=os_execution)}else{guest};
        if source_changed || current.as_ref().is_none_or(|v|v["tunnelId"]!=auth["tunnelId"] || v["clientId"]!=auth["clientId"] || v["destination"]!=auth["destination"] || v["osSource"]!=auth["osSource"] || v["protectedRecord"]["revision"]!=auth["protectedRecord"]["revision"] || v["protectedRecord"]["operationId"]!=auth["protectedRecord"]["operationId"] || v["secretExpiresAt"]!=auth["secretExpiresAt"] || !direct.preparation_active(&lease)){
            service.worker_links.local.revoke_grant(session_id,grant_id.as_deref().unwrap(),if current.is_some(){"resource-stopped"}else{"resource-deleted"}).await;grant_id=None;
            return Ok(error(if current.is_some(){409}else{404},if current.is_some(){"The tunnel attachment changed while opening."}else{"Tunnel attachment not found."}));
        }
        let secret=chrono::DateTime::parse_from_rfc3339(auth["secretExpiresAt"].as_str().context("Tunnel credential generation")?)?.with_timezone(&chrono::Utc);
        if repository.activate_attachment(attachment,auth["clientId"].as_str().context("Tunnel client identity")?,Time::from_timestamp_millis(secret.timestamp_millis()).context("Tunnel date range")?).await?.is_none(){
            service.worker_links.local.revoke_grant(session_id,grant_id.as_deref().unwrap(),"resource-stopped").await;grant_id=None;
            return Ok(error(409,"The tunnel attachment could not be activated."));
        }
        let target_kind=if auth["destination"]["kind"]=="worker-tcp" || guest {"tcp"}else if auth["destination"]["adapter"]=="project-share"{"project-share"}else{"code"};
        let target=json!({"kind":"protected-tunnel","targetKind":target_kind,"recordId":auth["tunnelId"],"protectedRecord":auth["protectedRecord"]});
        let route=json!({"tunnelId":auth["tunnelId"],"attachmentId":auth["attachmentId"],"sourceEndpointId":format!("worker-link-client:{}",grant_id.as_deref().unwrap()),"destinationEndpointId":format!("worker-link-worker:{worker}"),"target":target});
        crate::tunnels::publish(&service.live,&json!({"attachmentId":auth["attachmentId"],"ownerId":auth["ownerId"],"projectId":auth["projectId"],"tunnelId":auth["tunnelId"]}));
        output(201,"workerLinkTunnelGrantSchema",&json!({"grant":grant,"route":route}))
    }.await;
    // Dropping this lease releases all early-return paths as the Source finally.
    let response = match result {
        Ok(response) => response,
        Err(cause) => {
            if let Some(id) = grant_id {
                service
                    .worker_links
                    .local
                    .revoke_grant(session_id, &id, "resource-stopped")
                    .await;
            }
            if let Some(management) = cause.downcast_ref::<crate::tunnels::ManagementError>() {
                error(409, management.0)
            } else {
                cause
                    .downcast_ref::<Error>()
                    .map_or_else(|| request_failure(&cause), failure)
            }
        }
    };
    drop(lease);
    Ok(response)
}
