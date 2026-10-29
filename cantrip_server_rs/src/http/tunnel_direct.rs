//! Existing attachment direct preparation and durable activation fences.
use super::{
    direct_attachments::authorization,
    middleware::Context,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    direct_attachments::{PrepareInput, Unavailable},
    tunnels::{Repository, Time},
    wire::{JsString, Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

fn timestamp(value: &Value, key: &str) -> Result<Time> {
    Ok(
        chrono::DateTime::parse_from_rfc3339(value[key].as_str().context("Direct tunnel date")?)?
            .with_timezone(&chrono::Utc),
    )
}
pub(super) async fn execute(
    service: &AuthService,
    ctx: &Context,
    id: &str,
    body: Option<&Value>,
    activating: bool,
) -> Result<Response> {
    let input = match parse(
        if activating {
            "tunnelDirectActivationSchema"
        } else {
            "directTunnelPrepareRequestSchema"
        },
        body,
    )? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let mut auth = authorization(ctx);
    auth["attachmentId"] = json!(id);
    let owner = auth["ownerId"].as_str().context("Direct tunnel owner")?;
    let repo = Repository::new(service.repository.database.clone());
    let direct = &service.direct_attachments;
    if activating {
        let capability = input["capabilityId"]
            .as_str()
            .context("Direct tunnel capability")?;
        if !direct.matches(capability, &auth) {
            direct.activate(capability, &auth, "capability_mismatch");
            return Ok(error(404, "Direct attachment not found."));
        }
        let Some(authorization) = repo.attachment(owner, id).await? else {
            direct.activate(capability, &auth, "attachment_missing");
            return Ok(error(404, "Tunnel attachment not found."));
        };
        let Some(lease) = direct.tunnel_lease(capability, &auth) else {
            direct.activate(capability, &auth, "attachment_stale");
            return Ok(error(409, "Tunnel attachment is stale."));
        };
        let expires = timestamp(&lease, "leaseExpiresAt")?;
        let Some(_) = repo
            .activate_direct(
                owner,
                id,
                capability,
                Some(expires),
                Some(timestamp(&authorization, "secretExpiresAt")?),
            )
            .await?
        else {
            direct.activate(capability, &auth, "attachment_stale");
            return Ok(error(409, "Tunnel attachment is stale."));
        };
        if !direct.activate(capability, &auth, "completed") {
            repo.finalize_direct(owner, id, capability, Some(expires))
                .await?;
            return Ok(error(409, "Direct attachment changed while activating."));
        }
        crate::tunnels::publish(
            &service.live,
            &json!({"attachmentId":authorization["attachmentId"],"ownerId":authorization["ownerId"],"projectId":authorization["projectId"],"tunnelId":authorization["tunnelId"]}),
        );
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let mut lease_input = auth;
    lease_input["resourceId"] = Value::Null;
    lease_input["resourceKind"] = json!("tunnel");
    let owner = lease_input["ownerId"]
        .as_str()
        .context("Direct tunnel owner")?;
    let Some(lease) = direct.acquire_preparation(lease_input.clone()) else {
        return Ok(error(409, "The owning resource is being revoked."));
    };
    let result=async {
        let Some(authorization)=repo.attachment(owner,id).await?else{return Ok(error(404,"Tunnel attachment not found."));};
        if !direct.bind_preparation(&lease,json!("tunnel"),authorization["tunnelId"].clone()) {
            return Ok(error(409,"The owning resource changed while direct access was opening."));
        }
        let Some(worker)=service.workers.repository.get_worker(owner,authorization["destination"]["workerId"].as_str().context("Direct tunnel worker")?).await?else{return Ok(error(409,"Destination worker is offline."));};
        let source=JsString::new("desktop:".encode_utf16().chain(authorization["clientId"].as_js_string().context("Direct tunnel client")?.units().iter().copied()).chain(format!(":{id}").encode_utf16()).collect());
        let route=json!({"tunnelId":authorization["tunnelId"],"attachmentId":authorization["attachmentId"],"sourceEndpointId":source,"destinationEndpointId":format!("worker:{}",authorization["destination"]["workerId"].as_str().context("Direct tunnel worker")?)});
        let mut value=lease_input.clone();
        value["channels"]=json!(["tunnel-data"]);
        if let Some(trace)=input.get("diagnosticTraceId") {value["diagnosticTraceId"]=trace.clone();}
        value["leaseExpiresAt"]=authorization["expiresAt"].clone();value["maxLeaseExpiresAt"]=authorization["expiresAt"].clone();
        value["resourceId"]=authorization["tunnelId"].clone();value["worker"]=Value::from_serialize(&worker);
        let mut tunnel_route=route.clone();
        tunnel_route["target"]=json!({"kind":"protected-tunnel","targetKind":if authorization["destination"]["kind"]=="worker-tcp" {"tcp"}else{"project-share"},"recordId":authorization["tunnelId"],"protectedRecord":authorization["protectedRecord"]});
        value["tunnelRoute"]=tunnel_route;
        let mut ticket=direct.prepare(PrepareInput{lease:lease.clone(),value}).await?;
        let current=repo.attachment(owner,id).await?;
        if !current.as_ref().is_some_and(|current|[current["attachmentId"]==authorization["attachmentId"],current["tunnelId"]==authorization["tunnelId"],current["clientId"]==authorization["clientId"],current["destination"]["workerId"]==authorization["destination"]["workerId"],direct.preparation_active(&lease)].into_iter().all(|v|v)) {
            direct.revoke(ticket["binding"]["capabilityId"].as_str().context("Direct tunnel capability")?,"Owning resource changed while direct access was opening",None).await;
            return Ok(error(if current.is_some(){409}else{404},if current.is_some(){"The owning resource changed while direct access was opening."}else{"Tunnel attachment not found."}));
        }
        ticket["route"]=route;
        output(201,"directTunnelTicketSchema",&ticket)
    }.await;
    direct.release_preparation(&lease);
    match result {
        Err(cause) if cause.is::<Unavailable>() => Ok(error(409, cause.to_string())),
        result => result,
    }
}
