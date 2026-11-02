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
        let mut expiry = tokio::time::interval(Duration::from_secs(1));
        expiry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut expiry_failed = false;
        while enabled.load(Ordering::Acquire) {
            let Ok(mut notifications) = database.listen("cantrip_project_alerts").await else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            loop {
                let notification = tokio::select! {
                    notification = notifications.recv() => notification,
                    _ = expiry.tick() => {
                        // One indexed server sweep, independent of mounted Chats.
                        let failed = crate::agent_interactions::Repository::new(
                            crate::database::Executor::Database(&database),
                        ).expire(None).await.is_err();
                        if failed && !expiry_failed {
                            eprintln!("{}", json!({"event":"project-alert.expiry-failed"}));
                        }
                        expiry_failed = failed;
                        continue;
                    }
                };
                match notification {
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
