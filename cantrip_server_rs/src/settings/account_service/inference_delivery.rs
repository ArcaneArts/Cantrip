//! Coalesced delivery of saved settings, never inference admission or prompt scheduling.
use super::{AccountService, LifecycleLog};
use crate::{wire::Value, workers::repository::WorkerRepository};
use anyhow::Result;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

type Key = (String, Option<String>);
#[derive(Default)]
pub(super) struct Deliveries {
    closed: bool,
    jobs: HashMap<Key, Arc<Delivery>>,
}
struct Delivery {
    revision: AtomicU64,
    wake: Notify,
}
struct DeliveryGuard {
    service: Arc<AccountService>,
    key: Key,
    delivery: Arc<Delivery>,
}
impl Drop for DeliveryGuard {
    fn drop(&mut self) {
        let mut state = self.service.inference_deliveries.lock().unwrap();
        if state
            .jobs
            .get(&self.key)
            .is_some_and(|current| Arc::ptr_eq(current, &self.delivery))
        {
            state.jobs.remove(&self.key);
        }
    }
}

impl AccountService {
    pub(super) fn queue_inference_delivery(self: &Arc<Self>, owner: &str, worker: Option<&str>) {
        let key = (owner.to_owned(), worker.map(str::to_owned));
        let mut state = self.inference_deliveries.lock().unwrap();
        if state.closed {
            return;
        }
        if let Some(job) = state.jobs.get(&key) {
            job.revision.fetch_add(1, Ordering::AcqRel);
            job.wake.notify_one();
            return;
        }
        let delivery = Arc::new(Delivery {
            revision: AtomicU64::new(0),
            wake: Notify::new(),
        });
        state.jobs.insert(key.clone(), delivery.clone());
        // Register ownership before releasing the mutex so shutdown cannot miss it.
        drop(self.launch(move |service| async move {
            let _guard = DeliveryGuard {
                service: service.clone(),
                key: key.clone(),
                delivery: delivery.clone(),
            };
            service.deliver_inference_configuration(key, delivery).await;
            Ok(())
        }));
    }

    pub(super) fn close_inference_delivery(&self) {
        let mut state = self.inference_deliveries.lock().unwrap();
        state.closed = true;
        for delivery in state.jobs.values() {
            delivery.wake.notify_one();
        }
    }

    async fn deliver_inference_configuration(self: &Arc<Self>, key: Key, delivery: Arc<Delivery>) {
        let mut failures = 0u32;
        loop {
            if self.inference_deliveries.lock().unwrap().closed {
                return;
            }
            let revision = delivery.revision.load(Ordering::Acquire);
            let result = match key.1.as_deref() {
                Some(worker) => self.deliver_inference_worker(&key.0, worker).await,
                None => self.deliver_inference_owner(&key.0).await,
            };
            {
                let mut state = self.inference_deliveries.lock().unwrap();
                if state.closed {
                    return;
                }
                if result.is_ok() {
                    failures = 0;
                    if revision == delivery.revision.load(Ordering::Acquire) {
                        state.jobs.remove(&key);
                        return;
                    }
                    continue;
                }
            }
            if failures == 0 {
                LifecycleLog::emit(
                    "warn",
                    crate::wire::value::json!({
                        "event":"inference.configuration.delivery-pending", "workerId":key.1,
                    }),
                    "Provider inference configuration delivery remains pending",
                );
            }
            failures = failures.saturating_add(1);
            let delay = Duration::from_secs((1u64 << (failures - 1).min(6)).min(60));
            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = delivery.wake.notified() => {},
            }
        }
    }

    async fn deliver_inference_owner(self: &Arc<Self>, owner: &str) -> Result<()> {
        let workers = (WorkerRepository {
            database: self.repository.database.clone(),
        })
        .list_workers(owner)
        .await?;
        for worker in workers {
            if let Some(worker) = worker["workerId"].as_str() {
                self.queue_inference_delivery(owner, Some(worker));
            }
        }
        Ok(())
    }

    async fn deliver_inference_worker(&self, owner: &str, worker: &str) -> Result<()> {
        // Authoritative ownership/deletion only. No online-status preflight: a
        // disconnected worker is attempted and an actual delivery failure retries.
        if (WorkerRepository {
            database: self.repository.database.clone(),
        })
        .get_worker(owner, worker)
        .await?
        .is_none()
        {
            return Ok(());
        }
        let catalog = self.repository.provider_inference_catalog(owner).await?;
        let command = Value::from_serialize(&serde_json::json!({
            "type":"inference.configure", "configurations":catalog["configurations"], "catalogRevision":catalog["catalogRevision"],
        }));
        let reply = self
            .commands
            .request(worker, command, Some(Duration::from_secs(30)), None)
            .await?;
        let status =
            crate::settings::parse_response("workerInferenceStatusSchema", reply.as_ref())?;
        let expected_revision = catalog["catalogRevision"].as_i64().unwrap_or(0);
        let actual_revision = status["providerCatalogRevision"].as_i64();
        anyhow::ensure!(
            status["workerId"] == worker
                && status["ownerId"] == owner
                && actual_revision.is_some_and(|revision| revision >= expected_revision),
            "Provider inference configuration was not acknowledged by its worker scope."
        );
        let acknowledged: HashMap<_, _> = status["pools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|pool| pool["providerId"].as_str().map(|id| (id, pool)))
            .collect();
        for expected in catalog["configurations"].as_array().into_iter().flatten() {
            let actual = expected["providerId"]
                .as_str()
                .and_then(|id| acknowledged.get(id).copied());
            let valid = match actual {
                None => actual_revision.is_some_and(|revision| revision > expected_revision),
                Some(actual) => {
                    let expected_created = expected["inferenceCatalogCreatedRevision"]
                        .as_i64()
                        .unwrap_or(0);
                    let actual_created = actual["inferenceCatalogCreatedRevision"]
                        .as_i64()
                        .unwrap_or(0);
                    let expected_limit_revision =
                        expected["inferenceConfigRevision"].as_i64().unwrap_or(0);
                    let actual_limit_revision =
                        actual["inferenceConfigRevision"].as_i64().unwrap_or(0);
                    actual_created > expected_created
                        || (actual_created == expected_created
                            && (actual_limit_revision > expected_limit_revision
                                || (actual_limit_revision == expected_limit_revision
                                    && actual["maxConcurrentInference"].as_i64()
                                        == expected["maxConcurrentInference"].as_i64())))
                }
            };
            anyhow::ensure!(
                valid,
                "Provider inference configuration acknowledgement did not include the saved limit."
            );
        }
        Ok(())
    }
}
