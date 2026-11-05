//! Committed resource cleanup metadata, independent of model routing and tickets.
use super::service::WorkerService;
use crate::{
    operations::logging::{self, LogCall},
    wire::{Value, value::json},
};
use anyhow::Result;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, broadcast, watch};

const CHANNEL: &str = "cantrip_inference_resource_revocations";
#[derive(Debug)]
struct SettlementPending;
impl std::fmt::Display for SettlementPending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Task input settlement is pending")
    }
}
impl std::error::Error for SettlementPending {}
type Key = (String, String);
pub(super) type Pending = Mutex<HashMap<Key, Arc<Delivery>>>;
pub(super) struct Delivery {
    revision: AtomicU64,
    wake: Notify,
}
struct Guard {
    service: Arc<WorkerService>,
    key: Key,
    delivery: Arc<Delivery>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        let mut pending = self.service.inference_revocations.lock().unwrap();
        if pending
            .get(&self.key)
            .is_some_and(|actual| Arc::ptr_eq(actual, &self.delivery))
        {
            pending.remove(&self.key);
        }
    }
}
async fn stopped(stop: &mut watch::Receiver<bool>) {
    if !*stop.borrow() {
        let _ = stop.changed().await;
    }
}
fn report(worker: Option<&str>, error: &anyhow::Error) {
    if error.downcast_ref::<SettlementPending>().is_some() {
        return;
    }
    logging::server_logger()(LogCall::event(
        "warn",
        "Inference resource revocation delivery remains pending",
        json!({
            "event":"inference.resource.delivery-pending", "workerId":worker, "error":error.to_string(),
        }),
    ));
}

/** A reconnect wakes an existing retry owner rather than creating another one. */
pub(crate) fn wake(service: Arc<WorkerService>, owner: &str, worker: &str) {
    if *service.shutdown.borrow() {
        return;
    }
    let key = (owner.to_owned(), worker.to_owned());
    let delivery = {
        let mut pending = service.inference_revocations.lock().unwrap();
        if let Some(delivery) = pending.get(&key) {
            delivery.revision.fetch_add(1, Ordering::AcqRel);
            delivery.wake.notify_one();
            return;
        }
        let delivery = Arc::new(Delivery {
            revision: AtomicU64::new(0),
            wake: Notify::new(),
        });
        pending.insert(key.clone(), delivery.clone());
        delivery
    };
    tokio::spawn(async move {
        let _guard = Guard {
            service: service.clone(),
            key: key.clone(),
            delivery: delivery.clone(),
        };
        let mut stop = service.shutdown.subscribe();
        let mut failures = 0u32;
        loop {
            if *stop.borrow() {
                return;
            }
            let revision = delivery.revision.load(Ordering::Acquire);
            let result = tokio::select! {
                biased;
                _ = stopped(&mut stop) => return,
                result = deliver(&service, &key.0, &key.1) => result,
            };
            if result.is_ok() {
                failures = 0;
                let finished = {
                    let mut pending = service.inference_revocations.lock().unwrap();
                    if revision == delivery.revision.load(Ordering::Acquire) {
                        pending.remove(&key);
                        true
                    } else {
                        false
                    }
                };
                if finished {
                    return;
                }
                continue;
            }
            if failures == 0 {
                report(Some(&key.1), result.as_ref().unwrap_err());
            }
            failures = failures.saturating_add(1);
            let delay = Duration::from_secs((1u64 << (failures - 1).min(6)).min(60));
            tokio::select! {
                biased;
                _ = stopped(&mut stop) => return,
                _ = delivery.wake.notified() => {},
                _ = tokio::time::sleep(delay) => {},
            }
        }
    });
}

async fn deliver(service: &WorkerService, owner: &str, worker: &str) -> Result<()> {
    loop {
        let rows = service.repository.database.query(
            "SELECT r.id,r.target::text FROM inference_resource_revocations r JOIN workers w ON w.id=r.worker_id AND w.owner_id=r.owner_id WHERE r.owner_id=$1 AND r.worker_id=$2 ORDER BY r.created_at,r.id LIMIT 100",
            &[&owner,&worker],
        ).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let id = row.get::<String>(0)?;
            let target: Value = serde_json::from_str(&row.get::<String>(1)?)?;
            let command = json!({"type":"inference.revoke", "ownerId":owner, "target":target});
            // The actual command, not an online/model-availability preflight,
            // determines delivery success. Running ticket release stays native.
            let reply = service
                .commands
                .request(worker, command, Some(Duration::from_secs(30)), None)
                .await?;
            anyhow::ensure!(
                reply.as_ref().is_some_and(|reply| reply["revoked"] == true
                    && reply["ownerId"] == owner
                    && reply["workerId"] == worker),
                "The resource revocation was not acknowledged by its worker scope."
            );
            service.repository.database.query(
                "DELETE FROM inference_resource_revocations WHERE id=$1 AND owner_id=$2 AND worker_id=$3",
                &[&id,&owner,&worker],
            ).await?;
        }
    }
    let tasks = crate::tasks::Repository::new(service.repository.database.clone());
    let mut after: Option<String> = None;
    let mut settling = false;
    loop {
        let pending = tasks
            .pending_inference_routes(owner, worker, after.as_deref())
            .await?;
        if pending.is_empty() {
            break;
        }
        after = pending
            .last()
            .and_then(|change| change["source"]["dispatch"]["operationId"].as_str())
            .map(str::to_owned);
        for change in pending {
            let reply = service
                .commands
                .request(
                    worker,
                    json!({
                        "type":"inference.task-revoke", "ownerId":owner,
                        "operationId":change["operationId"], "source":change["source"],
                    }),
                    Some(Duration::from_secs(30)),
                    None,
                )
                .await?;
            let result = crate::wire::parse("taskInferenceRouteSettlementSchema", reply.as_ref())?;
            anyhow::ensure!(
                result["ownerId"] == owner
                    && result["workerId"] == worker
                    && result["operationId"] == change["operationId"]
                    && result["source"] == change["source"],
                "The Task input settlement belongs to another canonical operation."
            );
            if result["settled"] != true {
                settling = true;
                continue;
            }
            tasks
                .complete_inference_route(owner, worker, &change)
                .await?;
            if let Some(chat) = change["source"]["chatId"].as_str() {
                service.invalidate(owner, "task", chat);
            }
        }
    }
    if settling {
        return Err(SettlementPending.into());
    }
    Ok(())
}

async fn recover(service: &Arc<WorkerService>) -> Result<()> {
    let rows = service
        .repository
        .database
        .query(
            "SELECT DISTINCT s.owner_id,s.worker_id FROM (
            SELECT owner_id,worker_id FROM inference_resource_revocations
            UNION ALL SELECT c.owner_id,r.inference_input->'routeChange'->'source'->>'workerId'
            FROM task_planning_rounds r JOIN chats c ON c.id=r.chat_id
            WHERE r.inference_input->'routeChange'->>'phase'='draining'
         ) s JOIN workers w ON w.id=s.worker_id AND w.owner_id=s.owner_id",
            &[],
        )
        .await?;
    for row in rows {
        wake(
            service.clone(),
            &row.get::<String>(0)?,
            &row.get::<String>(1)?,
        );
    }
    Ok(())
}

/** Notifications only wake delivery; startup/reconnect also scan durable rows. */
pub(super) fn start(service: Arc<WorkerService>) {
    tokio::spawn(async move {
        let mut stop = service.shutdown.subscribe();
        let mut failures = 0u32;
        loop {
            let connection = tokio::select! {
                biased;
                _ = stopped(&mut stop) => return,
                result = service.repository.database.listen(CHANNEL) => result,
            };
            let result: Result<()> = match connection {
                Ok(mut notifications) => {
                    let mut rescan = true;
                    loop {
                        if rescan {
                            let result = tokio::select! {
                                biased;
                                _ = stopped(&mut stop) => return,
                                result = recover(&service) => result,
                            };
                            if let Err(error) = result {
                                if failures == 0 {
                                    report(None, &error);
                                }
                                failures = failures.saturating_add(1);
                                // Keep the actual LISTEN registration. Retrying
                                // a row read must not add PGlite callbacks.
                                tokio::select! {
                                    biased;
                                    _ = stopped(&mut stop) => return,
                                    _ = tokio::time::sleep(Duration::from_secs((1u64 << (failures - 1).min(6)).min(60))) => {},
                                }
                                continue;
                            }
                            failures = 0;
                            rescan = false;
                        }
                        let notification = tokio::select! {
                            biased;
                            _ = stopped(&mut stop) => return,
                            notification = notifications.recv() => notification,
                        };
                        match notification {
                            Ok((channel, payload)) if channel == CHANNEL => {
                                if payload.is_empty() {
                                    rescan = true;
                                    continue;
                                }
                                if let Ok(scope) =
                                    serde_json::from_str::<serde_json::Value>(&payload)
                                    && let (Some(owner), Some(worker)) =
                                        (scope["ownerId"].as_str(), scope["workerId"].as_str())
                                {
                                    wake(service.clone(), owner, worker);
                                }
                            }
                            Ok(_) => {}
                            Err(broadcast::error::RecvError::Lagged(_)) => rescan = true,
                            Err(broadcast::error::RecvError::Closed) => {
                                break Err(anyhow::anyhow!(
                                    "Resource revocation notifications disconnected."
                                ));
                            }
                        }
                    }
                }
                Err(error) => Err(error),
            };
            if failures == 0
                && let Err(error) = &result
            {
                report(None, error);
            }
            failures = failures.saturating_add(1);
            tokio::select! {
                biased;
                _ = stopped(&mut stop) => return,
                _ = tokio::time::sleep(Duration::from_secs((1u64 << (failures - 1).min(6)).min(60))) => {},
            }
        }
    });
}
