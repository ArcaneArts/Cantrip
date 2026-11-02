//! Commit-time invalidation covers writes from either server runtime.
use crate::{
    database::Database,
    live::Hub,
    wire::{Value, value::json},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::AbortHandle;

pub(super) fn watch(
    database: Arc<Database>,
    hub: Arc<Hub>,
    enabled: Arc<AtomicBool>,
) -> AbortHandle {
    tokio::spawn(async move {
        while enabled.load(Ordering::Acquire) {
            let Ok(mut notifications) = database.listen("cantrip_project_alerts").await else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            loop {
                match notifications.recv().await {
                    Ok((channel, payload)) => {
                        if channel != "cantrip_project_alerts" || payload.len() > 4096 { continue; }
                        let Ok(change) = serde_json::from_str::<Value>(&payload) else { continue; };
                        let Ok(change) = crate::settings::parse_response("projectAlertChangeSchema",Some(&change)) else { continue; };
                        if enabled.load(Ordering::Acquire) {
                            let _ = hub.publish(json!({"ownerId":change["ownerId"],"scope":json!({"kind":"current-user"}),"resource":"project-alert","action":"invalidated","entityId":change["projectId"],"revision":Value::Null,"payload":Value::Null}));
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }).abort_handle()
}
