use super::{
    Failure,
    flight::Cache,
    observation::{Observer, Runtime, Subscription},
};
use crate::{
    history::turn_context,
    metadata::{Guard, Signal},
    native_items::text,
};
use cantrip_history::projection::Work;
use cantrip_wire::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
pub type ReadThread = Arc<dyn Fn(cantrip_wire::JsString) -> Work<Value> + Send + Sync>;
struct Inner {
    read: ReadThread,
    observe: Option<Arc<dyn Runtime>>,
    cache: Cache<Value>,
    lifetime: Option<Signal>,
}
#[derive(Clone)]
pub struct Resolver(Arc<Inner>);
struct Close(Option<Subscription>);
impl Drop for Close {
    fn drop(&mut self) {
        if let Some(subscription) = &self.0 {
            subscription.close();
        }
    }
}
impl Resolver {
    pub fn new(read: ReadThread, observe: Option<Arc<dyn Runtime>>) -> Self {
        Self::scoped(read, observe, None)
    }
    pub(crate) fn scoped(
        read: ReadThread,
        observe: Option<Arc<dyn Runtime>>,
        lifetime: Option<Signal>,
    ) -> Self {
        Self(Arc::new(Inner {
            read,
            observe,
            cache: Cache::default(),
            lifetime,
        }))
    }
    pub fn resolve(&self, identity: Value) -> Work<Value> {
        let this = self.clone();
        let key = Value::Array(vec![
            identity["threadId"].clone(),
            identity["turnId"].clone(),
        ])
        .stringify();
        self.0.cache.get(key, move || {
            cantrip_transport::lifecycle::owned(async move {
                let lookup = this.lookup(identity);
                match &this.0.lifetime {
                    Some(signal) => {
                        Guard::metadata(Some(signal.clone()), None)
                            .run(lookup)
                            .await
                    }
                    None => lookup.await,
                }
            })
        })
    }

    async fn lookup(&self, identity: Value) -> anyhow::Result<Value> {
        let failure = Arc::new(Mutex::new(None::<Failure>));
        let (changed, mut changes) = watch::channel(());
        let changed = Arc::new(changed);
        let thread = text(&identity["threadId"])?;
        let subscription = if let Some(runtime) = &self.0.observe {
            let events = changed.clone();
            let errors = changed.clone();
            let failed = failure.clone();
            let failed_event = failure.clone();
            Some(runtime.observe(
                thread.clone(),
                Observer {
                    capture: Arc::new(move |event| {
                        if event["method"] == "thread/closed" {
                            *failed_event.lock().unwrap() = Some(Failure::new(anyhow::anyhow!(
                                "Native thread closed before original output context was retained."
                            )));
                        }
                        events.send_replace(());
                        Ok(None)
                    }),
                    on_error: Arc::new(move |error, _| {
                        *failed.lock().unwrap() = Some(error);
                        errors.send_replace(());
                        Ok(())
                    }),
                },
            )?)
        } else {
            None
        };
        if let Some(subscription) = &subscription {
            let changed = changed.clone();
            subscription.on_retired(Arc::new(move |_| {
                changed.send_replace(());
            }));
        }
        let _close = Close(subscription.clone());
        let current = || -> anyhow::Result<()> {
            if let Some(subscription) = &subscription {
                subscription.signal().check()?;
            }
            if let Some(error) = &*failure.lock().unwrap() {
                return Err(error.error());
            }
            Ok(())
        };
        loop {
            current()?;
            changes.borrow_and_update();
            let snapshot = match &subscription {
                Some(subscription) => subscription.read_snapshot().await?["snapshot"].clone(),
                None => (self.0.read)(thread.clone()).await?,
            };
            current()?;
            if snapshot["thread"]["id"] != identity["threadId"] {
                anyhow::bail!("Native output mode belongs to another thread.");
            }
            let turn = snapshot["history"]["turns"].as_array().and_then(|turns| {
                turns
                    .iter()
                    .find(|turn| turn["turnId"] == identity["turnId"])
            });
            let contexts = turn
                .and_then(|turn| turn["contexts"].as_array())
                .map_or(&[][..], Vec::as_slice);
            match turn_context::resolve(contexts) {
                Ok(context) => return Ok(context["mode"].clone()),
                Err(error) if subscription.is_some() && error.is::<turn_context::Pending>() => (),
                Err(error) => return Err(error),
            }
            changes.changed().await?;
        }
    }
}
