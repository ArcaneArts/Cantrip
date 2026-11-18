use super::{
    Failure,
    flight::Cache,
    observation::{Observer, Runtime, Subscription},
};
use crate::{history::turn_context, native_items::text};
use cantrip_history::projection::Work;
use cantrip_wire::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
pub type ReadThread = Arc<dyn Fn(cantrip_wire::JsString) -> Work<Value> + Send + Sync>;
struct Inner {
    read: ReadThread,
    observe: Option<Arc<dyn Runtime>>,
    cache: Cache<Value>,
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
        Self(Arc::new(Inner {
            read,
            observe,
            cache: Cache::default(),
        }))
    }
    pub fn resolve(&self, identity: Value) -> Work<Value> {
        let this = self.clone();
        let key = Value::Array(vec![
            identity["threadId"].clone(),
            identity["turnId"].clone(),
        ])
        .stringify();
        self.0.cache.get(key,move || cantrip_transport::lifecycle::owned(async move {
            let failure=Arc::new(Mutex::new(None::<Failure>));
            let (changed,mut changes)=watch::channel(());
            let changed=Arc::new(changed);
            let subscription=if let Some(runtime)=&this.0.observe {
                let events=changed.clone(); let errors=changed.clone(); let failed=failure.clone(); let failed_event=failure.clone();
                Some(runtime.observe(text(&identity["threadId"])?.clone(),Observer {
                    capture:Arc::new(move |event| {
                        if event["method"]=="thread/closed" { *failed_event.lock().unwrap()=Some(Failure::new(anyhow::anyhow!("Native thread closed before original output context was retained."))); }
                        events.send_replace(()); Ok(None)
                    }),
                    on_error:Arc::new(move |error,_| { *failed.lock().unwrap()=Some(error); errors.send_replace(()); Ok(()) }),
                })?)
            } else { None };
            if let Some(subscription)=&subscription { let changed=changed.clone(); subscription.on_retired(Arc::new(move |_| { changed.send_replace(()); })); }
            let _close=Close(subscription.clone());
            let current=|| -> anyhow::Result<()> {
                if let Some(subscription)=&subscription { subscription.signal().check()?; }
                if let Some(error)=&*failure.lock().unwrap() { return Err(error.error()); }
                Ok(())
            };
            loop {
                current()?; changes.borrow_and_update();
                let snapshot=match &subscription { Some(subscription)=>subscription.read_snapshot().await?["snapshot"].clone(),None=>(this.0.read)(text(&identity["threadId"])?.clone()).await? };
                current()?;
                if snapshot["thread"]["id"]!=identity["threadId"] { anyhow::bail!("Native output mode belongs to another thread."); }
                let turn=snapshot["history"]["turns"].as_array().and_then(|turns| turns.iter().find(|t| t["turnId"]==identity["turnId"]));
                let contexts=turn.and_then(|t| t["contexts"].as_array()).map_or(&[][..],Vec::as_slice);
                match turn_context::resolve(contexts) {
                    Ok(context)=>return Ok(context["mode"].clone()),
                    Err(error) if subscription.is_some() && error.is::<turn_context::Pending>()=>(),
                    Err(error)=>return Err(error),
                }
                changes.changed().await?;
            }
        }))
    }
}
