//! Core asks for one root Goal producer before requesting model inference.
use super::*;
use anyhow::Context;
use cantrip_history::projection::Work;
use cantrip_wire::value::json;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::sync::Mutex as AsyncMutex;

type Handler = Arc<dyn Fn(Attempt) -> Work<()> + Send + Sync>;

#[derive(Clone)]
struct Registration {
    runner: JsString,
    handler: Handler,
    mutations: Arc<AsyncMutex<()>>,
}

#[derive(Default)]
pub(super) struct Producers {
    handlers: HashMap<JsString, Registration>,
    active: HashMap<Key, PendingProducer>,
}

struct PendingProducer {
    operation: Option<JsString>,
    declined: watch::Sender<bool>,
}

pub(in crate::codex) struct Attempt {
    router: Router,
    pub key: Key,
    pub request: Value,
    forwarded: Arc<AtomicBool>,
    declined: watch::Receiver<bool>,
}

impl Attempt {
    pub async fn allow(&self, operation: &JsString) -> Result<Value> {
        {
            let mut state = self.router.0.producers.lock().unwrap();
            let pending = state
                .active
                .get_mut(&self.key)
                .context("The native Goal attempt retired.")?;
            pending.operation = Some(operation.clone());
        }
        self.forwarded.store(true, Ordering::Release);
        let mut params = self.key.resolve_params(None);
        params["operationGeneration"] = json!(operation);
        params["allow"] = json!(true);
        let reply = self
            .router
            .request("thread/managedExecution/resolve", params)
            .await;
        if reply.as_ref().is_err_and(|error| {
            error
                .downcast_ref::<crate::codex::rpc_requests::Failure>()
                .is_some_and(|failure| failure.native_error.is_some())
        }) {
            self.forwarded.store(false, Ordering::Release);
        }
        let value = reply?;
        if value["accepted"] != true {
            bail!("Core did not confirm the native Goal producer.");
        }
        Ok(value)
    }

    pub async fn declined(&self) -> Result<()> {
        let mut observed = self.declined.clone();
        observed.wait_for(|declined| *declined).await?;
        Ok(())
    }

    pub fn forwarded(&self) -> bool {
        self.forwarded.load(Ordering::Acquire)
    }
}

impl Router {
    pub(in crate::codex) fn register_goal_producer(
        &self,
        thread: JsString,
        runner: JsString,
        handler: Handler,
    ) {
        let mut owners = self.0.producers.lock().unwrap();
        let mutations = owners
            .handlers
            .get(&thread)
            .filter(|old| old.runner == runner)
            .map(|old| old.mutations.clone())
            .unwrap_or_default();
        owners.handlers.insert(
            thread,
            Registration {
                runner,
                handler,
                mutations,
            },
        );
    }

    pub(in crate::codex) fn remove_goal_producer(&self, thread: &JsString) {
        self.0.producers.lock().unwrap().handlers.remove(thread);
    }

    pub(in crate::codex) fn goal_runner(&self, thread: &JsString) -> Option<JsString> {
        self.0
            .producers
            .lock()
            .unwrap()
            .handlers
            .get(thread)
            .map(|owner| owner.runner.clone())
    }

    pub(in crate::codex) fn goal_mutations(
        &self,
        thread: &JsString,
    ) -> Option<Arc<AsyncMutex<()>>> {
        self.0
            .producers
            .lock()
            .unwrap()
            .handlers
            .get(thread)
            .map(|owner| owner.mutations.clone())
    }

    pub(super) fn producer_declined(&self, message: &Value) -> Result<()> {
        let key = Key::parse(message)?;
        let state = self.0.producers.lock().unwrap();
        if let Some(pending) = state.active.get(&key)
            && pending.operation.as_ref().is_some_and(|operation| {
                message["operationGeneration"].as_js_string() == Some(operation)
            })
        {
            pending.declined.send_replace(true);
        }
        Ok(())
    }

    pub(super) async fn producer(&self, request: Value) -> Result<()> {
        let key = Key::parse(&request)?;
        let (decline, declined) = watch::channel(false);
        let selected = {
            let mut state = self.0.producers.lock().unwrap();
            let std::collections::hash_map::Entry::Vacant(entry) = state.active.entry(key.clone())
            else {
                return Ok(());
            };
            entry.insert(PendingProducer {
                operation: None,
                declined: decline,
            });
            state
                .handlers
                .get(&key.thread_id)
                .filter(|owner| {
                    owner.runner == key.runner_generation && request["trigger"] == "goal"
                })
                .cloned()
        };
        let forwarded = Arc::new(AtomicBool::new(false));
        let result = if let Some(selected) = selected {
            let attempt = Attempt {
                router: self.clone(),
                key: key.clone(),
                request,
                forwarded: forwarded.clone(),
                declined,
            };
            (selected.handler)(attempt).await
        } else {
            Ok(())
        };
        let denied = if forwarded.load(Ordering::Acquire) {
            Ok(())
        } else {
            self.resolve(&key, None).await
        };
        self.0.producers.lock().unwrap().active.remove(&key);
        result.and(denied)
    }
}
