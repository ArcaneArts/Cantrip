//! Admit every sibling cleanup before observing aggregate failure.
use crate::{auth::service::AuthService, wire::Value};
use anyhow::{Context, Result};
use std::sync::Arc;

pub(super) async fn revoke_attachments(
    service: &Arc<AuthService>,
    owner: &str,
    tunnel: &Value,
    preserve: bool,
) -> Result<()> {
    // Source's Promise.all receives an already invoked map of async operations.
    // Admit every child in the caller before observing any failure;
    // try_join_all alone may stop before some large-list futures ever start.
    let operations = tunnel["attachments"]
        .as_array()
        .context("Managed tunnel attachments")?
        .iter()
        .map(|attachment| {
            let runtime = service.tunnel_runtime.clone();
            let owner = owner.to_owned();
            let id = attachment["id"]
                .as_str()
                .context("Managed attachment identity")
                .map(str::to_owned);
            let (send, receive) = tokio::sync::oneshot::channel();
            service.worker_maintenance.spawn_child(async move {
                let result: Result<()> = async {
                    runtime.revoke(&owner, &id?, preserve, None).await?;
                    Ok(())
                }
                .await;
                let _ = send.send(result);
                Ok(())
            });
            async move {
                receive
                    .await
                    .context("Browser attachment cleanup task ended")?
            }
        })
        .collect::<Vec<_>>();
    futures::future::try_join_all(operations).await?;
    Ok(())
}
