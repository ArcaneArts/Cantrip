//! Desktop attachment credentials, leases and revocation.
use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::{crypto, service::AuthService},
    direct_attachments::Scope,
    tunnels::{CreateAttachment, Repository},
    wire::value::json,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{collections::HashMap, sync::Arc};

async fn execute(
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let deleting = request.method() == Method::DELETE;
    let path = request.uri().path().to_owned();
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let repo = Repository::new(service.repository.database.clone());
    let owner = &ctx.principal.user.as_ref().expect("Tunnel owner").id;
    if let Some(tunnel) = params.get("tunnelId") {
        let input = match parse("tunnelAttachmentCreateSchema", body.as_ref())? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        if repo.get(owner, tunnel).await?.is_none() {
            return Ok(error(404, "An attachable desktop tunnel was not found."));
        }
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)?;
        let secret = URL_SAFE_NO_PAD.encode(bytes);
        let now = crate::auth::now();
        let Some(created) = repo
            .create_attachment(
                owner,
                tunnel,
                CreateAttachment {
                    client: input["clientId"]
                        .as_js_string()
                        .context("Tunnel client")?
                        .lossy()
                        .into_owned(),
                    expires: now + chrono::Duration::hours(12),
                    secret_expires: now + chrono::Duration::minutes(2),
                    secret_hash: crypto::hash_secret(&secret),
                },
            )
            .await?
        else {
            return Ok(error(404, "An attachable desktop tunnel was not found."));
        };
        let id = created["attachmentId"]
            .as_str()
            .context("Tunnel attachment")?;
        service
            .tunnel_runtime
            .close_active(id, "Attachment credentials rotated", 1008);
        service
            .worker_links
            .revoke_attachment(owner, "tunnel", tunnel, id)
            .await;
        crate::tunnels::publish(
            &service.live,
            &json!({"attachmentId":id,"ownerId":owner,"projectId":created["projectId"],"tunnelId":tunnel}),
        );
        return output(
            201,
            "tunnelAttachmentCreateResultSchema",
            &json!({"attachmentId":id,"tunnelId":tunnel,"secret":secret,"connectPath":format!("/api/tunnel-attachments/{id}/connect"),"secretExpiresAt":created["secretExpiresAt"],"expiresAt":created["expiresAt"]}),
        );
    }
    let id = &params["attachmentId"];
    if deleting {
        let authorization = repo.attachment(owner, id).await?;
        let revoked = service
            .direct_attachments
            .mutate(Scope::Attachment(json!(id)), async {
                if let Some(auth) = authorization {
                    service
                        .worker_links
                        .revoke_attachment(
                            owner,
                            "tunnel",
                            auth["tunnelId"].as_str().context("Tunnel identity")?,
                            auth["attachmentId"].as_str().context("Tunnel attachment")?,
                        )
                        .await;
                }
                service.tunnel_runtime.revoke(owner, id, false, None).await
            })
            .await?;
        return Ok(if revoked {
            StatusCode::NO_CONTENT.into_response()
        } else {
            error(404, "Tunnel attachment not found.")
        });
    }
    if path.ends_with("/lease") {
        return Ok(if repo.attachment(owner, id).await?.is_some() {
            StatusCode::NO_CONTENT.into_response()
        } else {
            error(404, "Tunnel attachment not found.")
        });
    }
    super::tunnel_direct::execute(
        &service,
        &ctx,
        id,
        body.as_ref(),
        path.ends_with("/direct-activate"),
    )
    .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let entity = params
        .get("tunnelId")
        .or_else(|| params.get("attachmentId"))
        .cloned();
    let (owner, retained, context) = (
        ctx.principal.user.as_ref().unwrap().id.clone(),
        service.clone(),
        ctx.clone(),
    );
    match service
        .worker_maintenance
        .owned(async move { execute(retained, context, params, request).await })
        .await
    {
        Ok(response) if response.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(response, move || {
                live.invalidate(&owner, "tunnel", entity.as_deref().unwrap_or(""));
            })
        }
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/tunnels/{tunnelId}/attachments", post(handle))
        .route("/api/tunnel-attachments/{attachmentId}", delete(handle))
        .route("/api/tunnel-attachments/{attachmentId}/lease", post(handle))
        .route(
            "/api/tunnel-attachments/{attachmentId}/direct",
            post(handle),
        )
        .route(
            "/api/tunnel-attachments/{attachmentId}/direct-activate",
            post(handle),
        )
}
