//! Browser/Desktop WorkerLink grants retain opaque surface state at the server.
use super::{
    middleware::Context,
    settings::{error, output, parse},
    worker_links::{authorized, failure, request_failure},
};
use crate::{
    auth::service::AuthService,
    remote_surfaces::Repository,
    settings::repository::SettingsRepository,
    wire::{Value, value::json},
    worker_links::Error,
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::response::Response;
use std::time::Duration;
pub(super) async fn execute(
    service: &AuthService,
    ctx: &Context,
    session_id: &str,
    surface_id: &str,
    body: Option<&Value>,
) -> Result<Response> {
    let input = match parse("workerLinkRemoteSurfaceGrantRequestSchema", body)? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let Some(session) = authorized(service, ctx, session_id) else {
        return Ok(error(404, "WorkerLink session not found."));
    };
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("Surface grant owner")?
        .id;
    let repository = Repository::new(service.repository.database.clone());
    let Some(context) = repository.context(owner, surface_id).await? else {
        return Ok(error(404, "Remote Surface not found."));
    };
    let surface = &context["surface"];
    let browser = surface["kind"] == "browser";
    let name = if browser { "Browser" } else { "Remote Desktop" };
    let resource_kind = if browser { "browser" } else { "remote-desktop" };
    if context["workerId"] != session["identity"]["workerId"] {
        return Ok(error(
            409,
            format!("{name} placement does not match the WorkerLink session."),
        ));
    }
    let worker = context["workerId"].as_str().context("Surface worker")?;
    if !service.workers.bridge.is_connected(worker) {
        repository
            .record_status(
                &service.live,
                owner,
                surface_id,
                "offline",
                Some("Worker is offline."),
            )
            .await?;
        return Ok(error(503, "Worker is offline."));
    }
    let attachment = uuid::Uuid::new_v4().to_string();
    let mut attached = false;
    let mut grant_id = None;
    let result:Result<Response>=async {
        repository.record_status(&service.live,owner,surface_id,"connecting",None).await?;
        let desktop=if browser{Value::Null}else{let settings=SettingsRepository::new(service.repository.database.clone()).get_user_settings(owner).await?;Value::from_serialize(&serde_json::json!({"targetFps":settings["desktopFrameRate"],"quality":settings["desktopStreamQuality"]}))};
        let state_resource=if browser{let classification=crate::wire::property(surface.get("titleProtection"),"classification")?;if crate::wire::property(classification,"recordKind")?==Some(&json!("browser")){"browser-row"}else{"browser-remote-surface"}}else{"remote-desktop-row"};
        let attached_result=service.workers.commands.request(worker,json!({"type":"surface.attach","surfaceId":surface["id"],"attachmentId":attachment,"projectId":surface["projectId"],"serverId":service.server_id,"configuration":surface["configuration"],"stateResource":state_resource,"stateRevision":surface["stateRevision"],"stateProtection":surface["stateProtection"],"preferredTransport":"websocket","webrtc":Value::Null,"viewport":input["viewport"],"desktopStream":desktop}),Some(Duration::from_secs(30)),None).await?;
        crate::settings::parse_response("remoteSurfaceAttachResultSchema",attached_result.as_ref())?;
        attached=true;
        let grant=service.worker_links.local.issue_grant(json!({"attachmentId":attachment,"lanes":["interactive","realtime"],"maxChannels":2,"operations":["stream:open","stream:read","stream:write"],"resourceId":surface["id"],"resourceKind":resource_kind,"sessionId":session["sessionId"]})).await?;
        grant_id=Some(grant["binding"]["grantId"].as_str().context("Surface grant ID")?.to_owned());
        let current=repository.context(owner,surface_id).await?;
        if current.as_ref().is_none_or(|v|v["surface"]["kind"]!=surface["kind"] || v["workerId"]!=context["workerId"] || v["surface"]["stateRevision"]!=surface["stateRevision"]) {
            service.worker_links.local.revoke_grant(session_id,grant_id.as_deref().unwrap(),if current.is_some(){"resource-stopped"}else{"resource-deleted"}).await;
            attached=false;grant_id=None;
            return Ok(error(if current.is_some(){409}else{404},if current.is_some(){format!("{name} placement or state changed while opening.")}else{format!("{name} surface not found.")}));
        }
        repository.record_status(&service.live,owner,surface_id,"active",None).await?;
        output(201,"workerLinkResourceGrantSchema",&grant)
    }.await;
    let response:Result<Response> = async {match result {
        Ok(response) => Ok(response),
        Err(cause) => {
            if let Some(grant) = grant_id.as_ref() {
                service
                    .worker_links
                    .local
                    .revoke_grant(session_id, grant, "resource-stopped")
                    .await;
                attached = false;
            }
            let offline = matches!(cause.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable);
            let message = if offline {
                "Worker is offline.".to_owned()
            } else {
                format!("{name} surface could not be opened.")
            };
            repository
                .record_status(
                    &service.live,
                    owner,
                    surface_id,
                    if offline { "offline" } else { "error" },
                    Some(&message),
                )
                .await?;
            Ok(cause
                .downcast_ref::<Error>()
                .map_or_else(|| request_failure(&cause), failure))
        }
    }}.await;
    if attached && grant_id.is_none() && service.workers.bridge.is_connected(worker) {
        let _=service.workers.commands.request(worker,json!({"type":"surface.detach","surfaceId":surface["id"],"attachmentId":attachment}),Some(Duration::from_secs(5)),None).await;
    }
    response
}
