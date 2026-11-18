//! Serialize managed chat preparation and keep the Node worker's recoverable
//! association. The server's committed thread remains authoritative.
mod association;
pub mod native;
#[cfg(test)]
mod tests;

use anyhow::{Result, anyhow, bail};
use association::{Association, Store};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Mutex as AsyncMutex;

pub struct Identity {
    pub server_id: JsString,
    pub owner_id: JsString,
    pub worker_id: JsString,
    pub chat_id: JsString,
    pub placement_id: JsString,
    pub project_id: Option<JsString>,
    pub context_kind: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Configure,
    Preserve,
}

pub struct Target {
    pub thread_id: Option<JsString>,
    pub cwd: JsString,
    pub execution_profile: &'static str,
    pub model_route_id: JsString,
    pub provider_id: JsString,
    pub provider_kind: JsString,
    pub provider_account_id: Option<JsString>,
    pub credential_home_key: Option<JsString>,
    pub intent: Intent,
}

pub struct Selection {
    pub thread_id: Option<JsString>,
    pub intent: Intent,
    pub replacement_settings: Option<Value>,
}

pub type Identify = Arc<dyn Fn(JsString) -> Work<()> + Send + Sync>;
pub type Prepare = Box<dyn FnOnce(Selection, Identify) -> Work<JsString> + Send>;
pub type Prepared = Box<dyn FnOnce(JsString) -> Work<()> + Send>;

pub struct Input {
    pub identity: Identity,
    pub target: Target,
    pub unbound_reuse_key: Option<JsString>,
    pub replacement_settings: Option<Value>,
    pub prepare: Prepare,
    pub on_identified: Option<Identify>,
    pub on_prepared: Option<Prepared>,
}

pub struct Replacement {
    pub previous_thread: JsString,
    pub capture_settings: Option<Box<dyn FnOnce() -> Work<Value> + Send>>,
}

#[derive(Clone)]
pub struct Coordinator {
    store: Arc<Store>,
    active: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
}

impl Coordinator {
    pub fn new(data: &Path) -> Self {
        Self {
            store: Arc::new(Store::new(data.join("managed-chat-sessions"))),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn prepare(&self, input: Input) -> Work<JsString> {
        self.run(input, None)
    }

    pub fn replace(&self, input: Input, previous: Replacement) -> Work<JsString> {
        self.run(input, Some(previous))
    }

    fn run(&self, input: Input, replacement: Option<Replacement>) -> Work<JsString> {
        let key = key(&input.identity);
        let lock = {
            let mut active = self.active.lock().unwrap();
            active.retain(|_, lock| lock.strong_count() != 0);
            let entry = active.entry(key.clone()).or_default();
            entry.upgrade().unwrap_or_else(|| {
                let lock = Arc::new(AsyncMutex::new(()));
                *entry = Arc::downgrade(&lock);
                lock
            })
        };
        let store = self.store.clone();
        owned(async move {
            let _guard = lock.lock().await;
            prepare_serialized(store, key, input, replacement).await
        })
    }
}

fn key(identity: &Identity) -> String {
    payload_digest(&Value::Array(vec![
        json!(identity.server_id),
        json!(identity.owner_id),
        json!(identity.worker_id),
        json!(identity.chat_id),
    ]))
}

fn fingerprint(identity: &Identity, target: &Target, legacy: bool) -> String {
    let mut values = vec![
        json!(identity.placement_id),
        json!(identity.project_id),
        json!(identity.context_kind),
        json!(target.cwd),
        json!(target.execution_profile),
    ];
    if legacy {
        values.push(json!(target.model_route_id));
    }
    values.extend([
        json!(target.provider_id),
        json!(target.provider_kind),
        json!(target.provider_account_id),
        json!(target.credential_home_key),
    ]);
    payload_digest(&Value::Array(values))
}

async fn prepare_serialized(
    store: Arc<Store>,
    key: String,
    input: Input,
    replacement: Option<Replacement>,
) -> Result<JsString> {
    let Input {
        identity,
        target,
        unbound_reuse_key,
        replacement_settings,
        prepare,
        on_identified,
        on_prepared,
    } = input;
    let old = store.read(&key).await?;
    let scope = fingerprint(&identity, &target, false);
    let previous = old.as_ref().filter(|old| {
        old.identity
            == if old.version == 1 {
                fingerprint(&identity, &target, true)
            } else {
                scope.clone()
            }
    });
    let mut thread = target.thread_id.clone().or_else(|| {
        previous
            .filter(|old| unbound_reuse_key.is_none() || old.unbound_reuse_key == unbound_reuse_key)
            .map(|old| old.thread_id.clone())
    });
    let replacing = replacement.as_ref().map(|claim| &claim.previous_thread);
    if replacing.is_none()
        && let (Some(old), Some(selected)) = (previous, thread.as_ref())
        && old.handoff_committed
        && old.replaced_threads.contains(selected)
    {
        thread = Some(old.thread_id.clone());
    }
    let observing_predecessor = replacing.is_none()
        && previous.is_some_and(|old| {
            !old.handoff_committed && old.replacement_of.is_some() && old.replacement_of == thread
        });
    let confirmed = replacing.is_none()
        && previous.is_some_and(|old| {
            old.replacement_of.is_some()
                && thread.as_ref() == Some(&old.thread_id)
                && (old.handoff_committed
                    || (old.prepared && target.thread_id.as_ref() == Some(&old.thread_id)))
        });
    if let Some(rejected) = replacing {
        if rejected.is_empty() {
            bail!("A replacement requires the previous native thread identity.");
        }
        let resuming = previous.filter(|old| old.replacement_of.as_ref() == Some(rejected));
        let valid = match old.as_ref() {
            Some(old) if previous.is_some() => &old.thread_id == rejected || resuming.is_some(),
            None => target.thread_id.as_ref() == Some(rejected),
            _ => false,
        };
        if !valid
            || target.thread_id.as_ref().is_some_and(|bound| {
                bound != rejected && resuming.is_none_or(|old| &old.thread_id != bound)
            })
        {
            bail!("The managed thread association changed before replacement.");
        }
        thread = resuming.map(|old| old.thread_id.clone());
    }
    let retained = replacing.cloned().or_else(|| {
        previous
            .filter(|old| Some(&old.thread_id) == thread.as_ref())
            .and_then(|old| old.replacement_of.clone())
    });
    let mut replaced_threads = previous.map_or_else(Vec::new, |old| old.replaced_threads.clone());
    if confirmed
        && let Some(replaced) = previous.and_then(|old| old.replacement_of.as_ref())
        && !replaced_threads.contains(replaced)
    {
        replaced_threads.push(replaced.clone());
    }
    let recovering_incomplete =
        target.thread_id.is_none() && previous.is_some_and(|old| !old.prepared);
    let intent = if replacing.is_some() {
        if thread.is_some() && previous.is_some_and(|old| old.prepared) {
            Intent::Preserve
        } else {
            Intent::Configure
        }
    } else if thread.is_some() && !recovering_incomplete {
        target.intent
    } else {
        Intent::Configure
    };
    let replacing = replacing.cloned();
    let replacement_settings = match replacement {
        Some(claim) if intent == Intent::Configure => match claim.capture_settings {
            Some(capture) => Some(capture().await?),
            None => replacement_settings,
        },
        Some(_) => None,
        None => replacement_settings,
    };
    let previous_state = previous.cloned();
    let record = Arc::new(move |thread_id: JsString, prepared| Association {
        prepared,
        handoff_committed: confirmed
            || previous_state.as_ref().is_some_and(|old: &Association| {
                old.handoff_committed && old.thread_id == thread_id
            }),
        version: 2,
        identity: scope.clone(),
        thread_id,
        unbound_reuse_key: unbound_reuse_key.clone(),
        replacement_of: retained.clone(),
        replaced_threads: replaced_threads.clone(),
    });
    let recorded = Arc::new(Mutex::new(None::<JsString>));
    let identify: Identify = {
        let store = store.clone();
        let key = key.clone();
        let record = record.clone();
        let recorded = recorded.clone();
        let replacing = replacing.clone();
        let previous = previous.cloned();
        let selected = thread.clone();
        Arc::new(move |thread_id| {
            let (store, key, record, recorded, replacing, previous, selected, on_identified) = (
                store.clone(),
                key.clone(),
                record.clone(),
                recorded.clone(),
                replacing.clone(),
                previous.clone(),
                selected.clone(),
                on_identified.clone(),
            );
            Box::pin(async move {
                if thread_id.trim().is_empty()
                    || replacing.as_ref() == Some(&thread_id)
                    || selected
                        .as_ref()
                        .is_some_and(|expected| expected != &thread_id)
                {
                    bail!("Native preparation returned an unexpected thread identity.");
                }
                {
                    let mut known = recorded.lock().unwrap();
                    if known.as_ref().is_some_and(|known| known != &thread_id) {
                        bail!("Native preparation changed its identified thread.");
                    }
                    *known = Some(thread_id.clone());
                }
                if !observing_predecessor {
                    let prepared = intent == Intent::Preserve
                        && previous.is_some_and(|old| old.prepared && old.thread_id == thread_id);
                    store
                        .write(&key, record(thread_id.clone(), prepared))
                        .await?;
                }
                if let Some(callback) = on_identified {
                    callback(thread_id).await?;
                }
                Ok(())
            })
        })
    };
    let thread_id = prepare(
        Selection {
            thread_id: thread,
            intent,
            replacement_settings,
        },
        identify,
    )
    .await?;
    if recorded.lock().unwrap().as_ref() != Some(&thread_id) {
        return Err(anyhow!(
            "Native preparation did not identify the prepared thread."
        ));
    }
    let mut completed = record(thread_id.clone(), true);
    if !observing_predecessor {
        store.write(&key, completed.clone()).await?;
    }
    if let Some(on_prepared) = on_prepared {
        on_prepared(thread_id.clone()).await?;
        if let Some(rejected) = replacing {
            completed.handoff_committed = true;
            if !completed.replaced_threads.contains(&rejected) {
                completed.replaced_threads.push(rejected);
            }
            store.write(&key, completed).await?;
        }
    }
    Ok(thread_id)
}
