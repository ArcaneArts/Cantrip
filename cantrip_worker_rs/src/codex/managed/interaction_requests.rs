//! One physical execution may own native requests on a thread at a time.
use super::Session;
use crate::codex::turn::interactions::protocol;
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};

struct Pending {
    frame: Value,
    kind: &'static str,
    visible: bool,
}

struct Route {
    events: mpsc::Sender<Value>,
    pending: IndexMap<String, Pending>,
}

struct State {
    routes: Mutex<HashMap<JsString, Route>>,
    changed: watch::Sender<()>,
}

#[derive(Clone)]
pub(super) struct Requests(Arc<State>);

impl Default for Requests {
    fn default() -> Self {
        Self(Arc::new(State {
            routes: Mutex::default(),
            changed: watch::channel(()).0,
        }))
    }
}

pub(in crate::codex) struct Subscription {
    registry: Requests,
    session: Session,
    thread: JsString,
    pub events: mpsc::Receiver<Value>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let route = self.registry.0.routes.lock().unwrap().remove(&self.thread);
        if let Some(route) = route {
            self.registry.changed();
            for pending in route.pending.into_values() {
                let _ = self.session.send(protocol::deny(
                    &pending.frame["id"],
                    pending.kind,
                    &"The native turn ended.".into(),
                ));
            }
        }
    }
}

impl Requests {
    pub(super) fn subscribe(&self, session: &Session, thread: &JsString) -> Result<Subscription> {
        let mut routes = self.0.routes.lock().unwrap();
        ensure!(
            !routes.contains_key(thread),
            "This thread already owns native interaction requests."
        );
        let (send, events) = mpsc::channel(32);
        routes.insert(
            thread.clone(),
            Route {
                events: send,
                pending: IndexMap::new(),
            },
        );
        Ok(Subscription {
            registry: self.clone(),
            session: session.clone(),
            thread: thread.clone(),
            events,
        })
    }

    fn changed(&self) {
        self.0.changed.send_replace(());
    }

    pub(super) fn changes(&self) -> watch::Receiver<()> {
        self.0.changed.subscribe()
    }

    pub(super) fn publish(&self, thread: &JsString, id: &Value) -> bool {
        let mut routes = self.0.routes.lock().unwrap();
        let Some(pending) = routes
            .get_mut(thread)
            .and_then(|route| route.pending.get_mut(&id.stringify()))
        else {
            return false;
        };
        pending.visible = true;
        self.changed();
        true
    }

    pub(super) fn visible(&self, thread: &JsString) -> Vec<Value> {
        self.0
            .routes
            .lock()
            .unwrap()
            .get(thread)
            .map(|route| {
                route
                    .pending
                    .values()
                    .filter(|pending| pending.visible)
                    .map(|pending| pending.frame.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn receive(&self, session: &Session, frame: &Value) -> bool {
        let id = frame
            .get("id")
            .filter(|id| id.is_string() || id.is_number());
        let kind = id.and_then(|_| protocol::kind(&frame["method"]));
        let resolved = id.is_none() && frame["method"] == "serverRequest/resolved";
        if kind.is_none() && !resolved {
            return false;
        }
        let mut routes = self.0.routes.lock().unwrap();
        let route = frame["params"]["threadId"]
            .as_js_string()
            .and_then(|thread| routes.get_mut(thread));
        if resolved {
            if let Some(route) = route
                && route
                    .pending
                    .shift_remove(&frame["params"]["requestId"].stringify())
                    .is_some()
            {
                self.changed();
                let _ = route.events.try_send(frame.clone());
            }
        } else if let (Some(kind), Some(id)) = (kind, id) {
            if let Some(route) = route {
                let key = id.stringify();
                if route.pending.contains_key(&key) {
                    return true;
                }
                if route.pending.len() < 32 && route.events.try_send(frame.clone()).is_ok() {
                    route.pending.insert(
                        key,
                        Pending {
                            frame: frame.clone(),
                            kind,
                            visible: false,
                        },
                    );
                    return true;
                }
            }
            let _ = session.send(protocol::deny(
                id,
                kind,
                &"No active Cantrip interaction channel.".into(),
            ));
        }
        true
    }

    pub(super) fn reply(&self, session: &Session, thread: &JsString, frame: Value) -> Result<bool> {
        let mut routes = self.0.routes.lock().unwrap();
        let Some(route) = routes.get_mut(thread) else {
            return Ok(false);
        };
        if route
            .pending
            .shift_remove(&frame["id"].stringify())
            .is_none()
        {
            return Ok(false);
        }
        self.changed();
        session.send(frame)?;
        Ok(true)
    }
}
