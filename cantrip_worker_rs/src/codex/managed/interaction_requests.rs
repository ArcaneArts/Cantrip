//! One physical execution may own native requests on a thread at a time.
use super::Session;
use crate::codex::turn::interactions::protocol;
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

struct Route {
    events: mpsc::Sender<Value>,
    pending: HashMap<String, (Value, &'static str)>,
}

#[derive(Clone, Default)]
pub(super) struct Requests(Arc<Mutex<HashMap<JsString, Route>>>);

pub(in crate::codex) struct Subscription {
    registry: Requests,
    session: Session,
    thread: JsString,
    pub events: mpsc::Receiver<Value>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let route = self.registry.0.lock().unwrap().remove(&self.thread);
        if let Some(route) = route {
            for (id, kind) in route.pending.into_values() {
                let _ =
                    self.session
                        .send(protocol::deny(&id, kind, &"The native turn ended.".into()));
            }
        }
    }
}

impl Requests {
    pub(super) fn subscribe(&self, session: &Session, thread: &JsString) -> Result<Subscription> {
        let mut routes = self.0.lock().unwrap();
        ensure!(
            !routes.contains_key(thread),
            "This thread already owns native interaction requests."
        );
        let (send, events) = mpsc::channel(32);
        routes.insert(
            thread.clone(),
            Route {
                events: send,
                pending: HashMap::new(),
            },
        );
        Ok(Subscription {
            registry: self.clone(),
            session: session.clone(),
            thread: thread.clone(),
            events,
        })
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
        let mut routes = self.0.lock().unwrap();
        let route = frame["params"]["threadId"]
            .as_js_string()
            .and_then(|thread| routes.get_mut(thread));
        if resolved {
            if let Some(route) = route
                && route
                    .pending
                    .remove(&frame["params"]["requestId"].stringify())
                    .is_some()
            {
                let _ = route.events.try_send(frame.clone());
            }
        } else if let (Some(kind), Some(id)) = (kind, id) {
            if let Some(route) = route {
                let key = id.stringify();
                if route.pending.contains_key(&key) {
                    return true;
                }
                if route.pending.len() < 32 && route.events.try_send(frame.clone()).is_ok() {
                    route.pending.insert(key, (id.clone(), kind));
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
        let mut routes = self.0.lock().unwrap();
        let Some(route) = routes.get_mut(thread) else {
            return Ok(false);
        };
        if route.pending.remove(&frame["id"].stringify()).is_none() {
            return Ok(false);
        }
        session.send(frame)?;
        Ok(true)
    }
}
