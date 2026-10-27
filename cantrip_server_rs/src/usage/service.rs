//! Shared accounting composition; transports record synchronously while the
//! meter persists retry-safe batches independently of their response paths.
use super::{
    live_traffic::{self, LiveTrafficMeter},
    meter::{Counter, Measurement, Options},
    meter_service::{Meter, Observer, Publisher, Sink},
    repository::UsageRepository,
};
use crate::{config::ServerConfig, database::Database};
use anyhow::Result;
use futures::FutureExt;
use indexmap::IndexMap;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::task::AbortHandle;

type Publish = Arc<dyn Fn(&str) + Send + Sync>;
struct Pending {
    entries: IndexMap<String, AbortHandle>,
    closed: bool,
}
pub struct Invalidations {
    pending: Mutex<Pending>,
    publish: OnceLock<Publish>,
    delay: Duration,
    limit: usize,
}
impl Invalidations {
    fn new() -> Arc<Self> {
        let config = &super::CONTRACT["invalidation"];
        Arc::new(Self {
            pending: Mutex::new(Pending {
                entries: IndexMap::new(),
                closed: false,
            }),
            publish: OnceLock::new(),
            delay: Duration::from_millis(
                config["delayMs"]
                    .as_u64()
                    .expect("usage invalidation delay"),
            ),
            limit: config["limit"].as_u64().expect("usage invalidation limit") as usize,
        })
    }
    pub fn on_publish(&self, publish: Publish) {
        assert!(
            self.publish.set(publish).is_ok(),
            "usage publisher initialized twice"
        );
    }
    fn publish(&self, owner: &str) {
        if let Some(publish) = self.publish.get() {
            publish(owner);
        }
    }
    pub fn schedule(self: &Arc<Self>, owner: String) {
        let mut pending = self.pending.lock().unwrap();
        if pending.closed || pending.entries.contains_key(&owner) {
            return;
        }
        let oldest = if pending.entries.len() >= self.limit {
            pending.entries.shift_remove_index(0).map(|(owner, timer)| {
                timer.abort();
                owner
            })
        } else {
            None
        };
        let weak = Arc::downgrade(self);
        let key = owner.clone();
        let deadline = tokio::time::Instant::now() + self.delay;
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(service) = weak.upgrade() {
                let present = service
                    .pending
                    .lock()
                    .unwrap()
                    .entries
                    .shift_remove(&key)
                    .is_some();
                if present {
                    service.publish(&key);
                }
            }
        });
        pending.entries.insert(owner, timer.abort_handle());
        drop(pending);
        if let Some(owner) = oldest {
            self.publish(&owner);
        }
    }
    pub fn close(&self) {
        let mut pending = self.pending.lock().unwrap();
        pending.closed = true;
        for (_, timer) in pending.entries.drain(..) {
            timer.abort();
        }
    }
}
impl Drop for Invalidations {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct UsageService {
    pub repository: UsageRepository,
    pub meter: Arc<Meter>,
    pub invalidations: Arc<Invalidations>,
    pub storage: Arc<super::background::Job>,
    pub history: Arc<super::background::Job>,
    traffic: Arc<Mutex<LiveTrafficMeter>>,
}
impl UsageService {
    pub fn new(database: Arc<Database>, config: &ServerConfig) -> Result<Arc<Self>> {
        let repository = UsageRepository::new(database);
        let instance = config
            .server_instance_id
            .as_deref()
            .unwrap_or("local-single-instance");
        let traffic = Arc::new(Mutex::new(LiveTrafficMeter::new(
            live_traffic::Options::new(instance.into()),
        )?));
        let invalidations = Invalidations::new();
        let repo = repository.clone();
        let sink: Sink = Arc::new(move |batch| {
            let repo = repo.clone();
            async move { repo.flush_bandwidth(batch).await }.boxed()
        });
        let live = traffic.clone();
        let observe: Observer = Arc::new(move |input| {
            live.lock().unwrap().record(
                &Measurement {
                    owner_id: input.owner_id.clone(),
                    bytes: Counter::Integer(input.bytes.clone()),
                    operation_count: Some(Counter::Integer(input.operation_count.clone())),
                    channel: input.channel.clone(),
                    direction: input.direction.clone(),
                    notify_change: input.notify_change,
                },
                chrono::Utc::now().timestamp_millis() as f64,
            )?;
            Ok(())
        });
        let changes = invalidations.clone();
        let publish: Publisher = Arc::new(move |owners| {
            for owner in owners {
                changes.schedule(owner);
            }
            Ok(())
        });
        let meter = Meter::new(
            Options {
                meter_id: format!("{instance}:{}", uuid::Uuid::new_v4()),
                flush_interval_ms: config.bandwidth_usage_flush_interval_ms,
                flush_threshold_bytes: config.bandwidth_usage_flush_threshold_bytes.into(),
                max_buffered_entries: config.bandwidth_usage_max_buffered_entries as usize,
            },
            sink,
            Some(observe),
            Some(publish),
        )?;
        let repo = repository.clone();
        let holder = instance.to_owned();
        let operation: super::background::Operation = Arc::new(move |now| {
            let repo = repo.clone();
            let holder = holder.clone();
            async move {
                let result = repo.reconcile_storage(&holder, now).await?;
                Ok(super::background::Outcome {
                    acquired: result.acquired,
                    value: serde_json::to_value(result)?,
                })
            }
            .boxed()
        });
        let changes = invalidations.clone();
        let followup: super::background::Followup = Arc::new(move |result, acquired| {
            if acquired {
                for owner in result["ownerIds"].as_array().expect("reconciled owners") {
                    changes.schedule(owner.as_str().expect("owner identity").into());
                }
            }
            futures::future::ready(Ok(None)).boxed()
        });
        let storage = super::background::Job::new(
            "storage-reconciliation",
            config.storage_reconciliation_interval_ms,
            operation,
            followup,
            None,
        )?;
        let repo = repository.clone();
        let holder = instance.to_owned();
        let options = super::HistoryOptions {
            daily_retention_days: config.account_usage_daily_retention_days as i64,
            flush_retention_days: config.account_usage_flush_retention_days as i64,
            hourly_retention_days: config.account_usage_hourly_retention_days as i64,
            lease_ms: 30 * 60_000,
        };
        let operation: super::background::Operation = Arc::new(move |now| {
            let repo = repo.clone();
            let holder = holder.clone();
            let options = options.clone();
            async move {
                let result = repo.maintain_history(&holder, now, options).await?;
                Ok(super::background::Outcome {
                    acquired: result.acquired,
                    value: serde_json::to_value(result)?,
                })
            }
            .boxed()
        });
        let repo = repository.clone();
        let followup: super::background::Followup = Arc::new(move |_, _| {
            let repo = repo.clone();
            async move {
                Ok(Some(serde_json::to_value(
                    repo.operational_totals().await?,
                )?))
            }
            .boxed()
        });
        let history = super::background::Job::new(
            "history-maintenance",
            config.account_usage_maintenance_interval_ms,
            operation,
            followup,
            Some(
                serde_json::json!({"accountCount":0,"logicalServerBytes":"0","logicalWorkerManagedBytes":"0","physicalDatabaseBytes":null}),
            ),
        )?;
        Ok(Arc::new(Self {
            repository,
            meter,
            invalidations,
            storage,
            history,
            traffic,
        }))
    }
    pub fn record(
        &self,
        owner: &str,
        channel: &str,
        ingress: bool,
        bytes: usize,
        operations: u64,
        notify: bool,
    ) {
        self.meter.record(Measurement {
            owner_id: owner.into(),
            bytes: Counter::Integer(bytes.into()),
            operation_count: Some(Counter::Integer(operations.into())),
            channel: channel.into(),
            direction: if ingress { "ingress" } else { "egress" }.into(),
            notify_change: Some(notify),
        });
    }
    pub fn record_http_request(&self, owner: &str, route: &str) {
        let _ = self.traffic.lock().unwrap().record_http_request(
            owner,
            route,
            chrono::Utc::now().timestamp_millis() as f64,
        );
    }
    pub fn traffic(&self, owner: &str, query: &live_traffic::Query) -> Result<Value> {
        self.traffic.lock().unwrap().snapshot(
            owner,
            query,
            chrono::Utc::now().timestamp_millis() as f64,
        )
    }
    pub async fn close(&self) {
        self.history.close().await;
        self.storage.close().await;
        self.meter.close().await;
        self.invalidations.close();
    }
    pub fn start(self: &Arc<Self>) {
        self.storage.start(false);
        self.history.start(false);
        let storage = self.storage.run();
        let history = self.history.clone();
        tokio::spawn(async move {
            storage.await;
            history.run().await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[tokio::test(start_paused = true)]
    async fn repeated_owner_changes_coalesce_without_moving_the_first_deadline() {
        let service = Invalidations::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        let (done, completed) = tokio::sync::oneshot::channel();
        let done = Mutex::new(Some(done));
        service.on_publish(Arc::new(move |owner| {
            output.lock().unwrap().push(owner.to_owned());
            if let Some(done) = done.lock().unwrap().take() {
                let _ = done.send(());
            }
        }));
        service.schedule("owner".into());
        tokio::time::advance(Duration::from_secs(4)).await;
        for _ in 0..100 {
            service.schedule("owner".into());
        }
        assert!(seen.lock().unwrap().is_empty());
        tokio::time::advance(Duration::from_secs(1)).await;
        completed.await.unwrap();
        assert_eq!(*seen.lock().unwrap(), vec!["owner".to_owned()]);
        service.schedule("owner".into());
        service.close();
        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    #[tokio::test(start_paused = true)]
    async fn capacity_publishes_oldest_owners_and_later_delivers_every_remaining_owner_once() {
        let service = Invalidations::new();
        let total = service.limit + 3;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        let done = Arc::new(tokio::sync::Notify::new());
        let notify = done.clone();
        service.on_publish(Arc::new(move |owner| {
            let mut output = output.lock().unwrap();
            output.push(owner.to_owned());
            if output.len() == total {
                notify.notify_one();
            }
        }));
        for i in 0..total {
            service.schedule(format!("owner-{i}"));
        }
        assert_eq!(*seen.lock().unwrap(), vec!["owner-0", "owner-1", "owner-2"]);
        tokio::time::advance(Duration::from_secs(5)).await;
        done.notified().await;
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), total);
        assert_eq!(seen.iter().collect::<HashSet<_>>().len(), total);
    }
}
