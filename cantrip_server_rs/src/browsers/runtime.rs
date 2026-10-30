//! Saved-state application keeps committed writes even if the worker is offline.
use super::Repository;
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
    workers::bridge::CommandError,
};
use anyhow::{Context, Result, bail};
use std::{sync::Arc, time::Duration};

pub async fn update(
    service: &Arc<AuthService>,
    owner: &str,
    id: &str,
    input: &Value,
    expected_worker: Option<&str>,
    require_online: bool,
) -> Result<Option<Value>> {
    let remote = crate::remote_surfaces::Repository::new(service.repository.database.clone());
    let Some(context) = remote.context(owner, id).await? else {
        return Ok(None);
    };
    if context["surface"]["kind"] != "browser"
        || expected_worker.is_some_and(|w| context["workerId"] != w)
    {
        return Ok(None);
    }
    let browser = Repository::new(service.repository.database.clone())
        .update(owner, id, input)
        .await?;
    if browser.is_none() || input.get("stateProtection").is_none() {
        return Ok(browser);
    }
    let value = browser.as_ref().unwrap();
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":value["projectId"]}),"resource":"browser","action":"invalidated","entityId":id,"revision":Value::Null,"payload":Value::Null}));
    let updated = remote
        .context(owner, id)
        .await?
        .context("Browser placement changed before configuration.")?;
    if updated["workerId"] != context["workerId"]
        || updated["surface"]["configuration"]["kind"] != "browser"
    {
        bail!("Browser placement changed before configuration.")
    }
    let worker = context["workerId"].as_str().context("Browser worker")?;
    if !service.workers.bridge.is_connected(worker) {
        remote
            .record_status(
                &service.live,
                owner,
                id,
                "offline",
                Some("Worker is offline. The saved URL will be restored when it reconnects."),
            )
            .await?;
        if require_online {
            return Err(CommandError {
                message: "Browser worker is offline.".into(),
                code: None,
                unavailable: true,
                request_id: None,
                encoding_error: None,
            }
            .into());
        }
        return Ok(browser);
    }
    let result=service.workers.commands.request(worker,json!({"type":"surface.configure","surfaceId":id,"serverId":service.server_id,"configuration":updated["surface"]["configuration"],"stateResource":"browser-row","stateRevision":updated["surface"]["stateRevision"],"stateProtection":updated["surface"]["stateProtection"]}),Some(Duration::from_secs(20)),None).await;
    if let Err(failure) = result {
        remote
            .record_status(
                &service.live,
                owner,
                id,
                "error",
                Some("Browser private state could not be applied."),
            )
            .await?;
        if require_online {
            return Err(failure.into());
        }
    }
    Ok(browser)
}
