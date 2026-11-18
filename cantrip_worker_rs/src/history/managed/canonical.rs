//! Production factory: coherent archive recovery, outbox and canonical projector
//! share one initialization snapshot, released after the pump's first attempt.
use super::{
    Scope,
    projection::{Factory, Opened},
};
use crate::{
    history::{
        client::Client,
        live::flight::Cache,
        projector::{self, Adapters, Materialization, Projector},
        recovery,
    },
    metadata::Signal,
};
use anyhow::Result;
use cantrip_history::{
    content::Encryption,
    outbox::{self, Outbox},
    projection::{self, Work},
    source::Journal,
};
use cantrip_wire::{JsString, Value};
use std::{path::PathBuf, sync::Arc};
pub type AdapterFactory =
    Arc<dyn Fn(Value, Signal, Journal) -> Work<Arc<dyn Adapters>> + Send + Sync>;
pub struct Canonical {
    pub directory: PathBuf,
    pub worker_id: JsString,
    pub service: Arc<dyn Encryption>,
    pub client: Client,
    pub adapters: AdapterFactory,
}
struct Bootstrapped {
    inner: Arc<dyn Adapters>,
    cache: Cache<Value>,
    recover: outbox::Recovery,
}
impl Adapters for Bootstrapped {
    fn prepare(&self) -> Work<()> {
        self.inner.prepare()
    }
    fn context(&self, item: Value, turn: Value) -> Work<Value> {
        self.inner.context(item, turn)
    }
    fn materialize(
        &self,
        item: Value,
        turn: Value,
        context: Value,
        published: Option<Value>,
    ) -> Work<Materialization> {
        self.inner.materialize(item, turn, context, published)
    }
    fn associate(&self, item: Value, turn: Value) -> Work<Value> {
        self.inner.associate(item, turn)
    }
    fn bootstrap(&self) -> Work<Value> {
        let cache = self.cache.clone();
        let pending = (self.recover)();
        cantrip_transport::lifecycle::owned(async move {
            let result = pending
                .await
                .and_then(|snapshot| projector::bootstrap::restore(&snapshot));
            cache.clear();
            result
        })
    }
}
impl Canonical {
    pub fn factory(self) -> Factory {
        let this = Arc::new(self);
        Arc::new(move |source, scope, signal| {
            let this = this.clone();
            Box::pin(async move { this.open(source, scope, signal).await })
        })
    }
    async fn open(&self, source: Journal, scope: Scope, signal: Signal) -> Result<Opened> {
        let input = Value::object([
            ("chatId", Value::String(scope.chat_id)),
            ("threadId", Value::String(scope.thread_id)),
            (
                "provenance",
                Value::object([
                    ("kind", Value::String("binding".into())),
                    ("bindingId", Value::String(scope.binding_id)),
                ]),
            ),
        ]);
        let binding = self.client.open(&input, Some(signal.clone())).await?;
        signal.check()?;
        let adapters = (self.adapters)(binding.clone(), signal.clone(), source.clone()).await?;
        signal.check()?;
        let cache = Cache::default();
        let release = cache.clone();
        let cleanup: Arc<dyn Fn() + Send + Sync> = Arc::new(move || release.clear());
        let pending_cache = cache.clone();
        let client = self.client.clone();
        let service = self.service.clone();
        let bound = binding.clone();
        let lifetime = signal.clone();
        let recover: outbox::Recovery = Arc::new(move || {
            let client = client.clone();
            let service = service.clone();
            let binding = bound.clone();
            let signal = lifetime.clone();
            pending_cache.get("initial".into(), move || {
                recovery::read(
                    &binding,
                    client,
                    service,
                    recovery::Options {
                        signal: Some(signal),
                        ..Default::default()
                    },
                )
            })
        });
        let result = async {
            let scope = outbox::scope(
                self.service.as_ref(),
                &self.worker_id,
                binding["chatId"].as_js_string().unwrap(),
                binding["id"].as_js_string().unwrap(),
            )?;
            let outbox = Outbox::open(
                self.directory.join("outbox"),
                scope,
                self.service.clone(),
                Some(recover.clone()),
            )
            .await?;
            let project = Projector::new(projector::Options {
                binding: binding.clone(),
                service: self.service.clone(),
                client: Arc::new(self.client.clone()),
                adapters: Arc::new(Bootstrapped {
                    inner: adapters,
                    cache,
                    recover,
                }),
                max_items_per_batch: None,
                signal: Some(signal.clone()),
            })?;
            let rebase_project = project.clone();
            let rebase_source = source.clone();
            let rebase_binding = binding.clone();
            let rebase_client = self.client.clone();
            let rebase_service = self.service.clone();
            let rebase_signal = signal.clone();
            let rebase: projection::Project = Arc::new(move |records, _| {
                projector::rebase::recover(
                    rebase_binding.clone(),
                    rebase_client.clone(),
                    rebase_service.clone(),
                    rebase_source.clone(),
                    records.last().unwrap().clone(),
                    rebase_project.clone(),
                    Some(rebase_signal.clone()),
                )
            });
            let deliver_client = self.client.clone();
            let deliver_signal = signal.clone();
            let check = signal.clone();
            projection::Projection::open(
                self.directory.join("projection"),
                projection::Options {
                    worker_id: self.worker_id.clone(),
                    chat_id: binding["chatId"].as_js_string().unwrap().clone(),
                    binding_id: binding["id"].as_js_string().unwrap().clone(),
                    service: self.service.clone(),
                    source,
                    outbox,
                    project: project.callback(),
                    rebase: Some(rebase),
                    deliver: Arc::new(move |scope, record, body| {
                        deliver_client.deliver(&scope, &record, &body, Some(deliver_signal.clone()))
                    }),
                    check: Some(Arc::new(move || check.check())),
                },
            )
            .await
        }
        .await;
        match result {
            Ok(projection) => Ok(Opened::new(projection, Some(cleanup))),
            Err(error) => {
                cleanup();
                Err(error)
            }
        }
    }
}
