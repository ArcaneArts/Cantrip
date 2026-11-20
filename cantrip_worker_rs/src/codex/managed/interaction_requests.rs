//! One physical execution may own native requests on a thread at a time.
use super::Session;
use crate::{codex::turn::interactions::protocol, history::lineage};
use anyhow::{Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
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
    turn: Option<JsString>,
    descendants: bool,
    ended: bool,
}

#[derive(Default)]
struct Descendant {
    parent: Option<JsString>,
    turn: Option<(JsString, JsString)>,
}

#[derive(Default)]
struct Registry {
    routes: HashMap<JsString, Route>,
    descendants: IndexMap<JsString, Descendant>,
}

struct State {
    registry: Mutex<Registry>,
    changed: watch::Sender<()>,
}

#[derive(Clone)]
pub(super) struct Requests(Arc<State>);

impl Default for Requests {
    fn default() -> Self {
        Self(Arc::new(State {
            registry: Mutex::default(),
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

impl Subscription {
    pub fn bind_turn(&self, turn: &JsString) -> Result<()> {
        let mut state = self.registry.0.registry.lock().unwrap();
        let route = state
            .routes
            .get_mut(&self.thread)
            .expect("Owned interaction route");
        ensure!(
            route.turn.as_ref().is_none_or(|observed| observed == turn),
            "The native interaction route observed a different root turn."
        );
        route.turn = Some(turn.clone());
        Ok(())
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let route = self
            .registry
            .0
            .registry
            .lock()
            .unwrap()
            .routes
            .remove(&self.thread);
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
    pub(super) fn subscribe(
        &self,
        session: &Session,
        thread: &JsString,
        descendants: bool,
    ) -> Result<Subscription> {
        let mut state = self.0.registry.lock().unwrap();
        ensure!(
            !state.routes.contains_key(thread),
            "This thread already owns native interaction requests."
        );
        let (send, events) = mpsc::channel(64);
        state.routes.insert(
            thread.clone(),
            Route {
                events: send,
                pending: IndexMap::new(),
                turn: None,
                descendants,
                ended: false,
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
        let mut state = self.0.registry.lock().unwrap();
        let Some(pending) = state
            .routes
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
            .registry
            .lock()
            .unwrap()
            .routes
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
            if id.is_none()
                && (matches!(
                    frame["method"].as_str(),
                    Some(
                        "thread/started"
                            | "thread/closed"
                            | "thread/status/changed"
                            | "turn/started"
                            | "turn/completed"
                    )
                ) || (matches!(
                    frame["method"].as_str(),
                    Some("item/started" | "item/completed")
                ) && matches!(
                    frame["params"]["item"]["type"].as_str(),
                    Some("collabAgentToolCall" | "subAgentActivity")
                )))
                && self.0.registry.lock().unwrap().observe(frame)
            {
                self.changed();
            }
            return false;
        }
        let mut state = self.0.registry.lock().unwrap();
        if resolved {
            let key = frame["params"]["requestId"].stringify();
            for route in state.routes.values_mut() {
                if route.pending.get(&key).is_some_and(|pending| {
                    pending.frame["params"]["threadId"] == frame["params"]["threadId"]
                }) {
                    route.pending.shift_remove(&key);
                    self.changed();
                    let _ = route.events.try_send(frame.clone());
                    break;
                }
            }
        } else if let (Some(kind), Some(id)) = (kind, id) {
            let root = state.root(&frame["params"]);
            if let Some(route) = root.and_then(|root| state.routes.get_mut(&root)) {
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
        let mut state = self.0.registry.lock().unwrap();
        let key = frame["id"].stringify();
        let Some(pending) = state
            .routes
            .get(thread)
            .and_then(|route| route.pending.get(&key))
        else {
            return Ok(false);
        };
        if state.root(&pending.frame["params"]).as_ref() != Some(thread) {
            return Ok(false);
        }
        state
            .routes
            .get_mut(thread)
            .unwrap()
            .pending
            .shift_remove(&key);
        self.changed();
        session.send(frame)?;
        Ok(true)
    }
}

impl Registry {
    fn root(&self, params: &Value) -> Option<JsString> {
        let thread = params["threadId"].as_js_string()?;
        let requested = params["turnId"].as_js_string();
        if let Some(route) = self.routes.get(thread) {
            return (!route.ended
                && (requested.is_none()
                    || route.turn.is_none()
                    || route.turn.as_ref() == requested))
                .then(|| thread.clone());
        }
        let child = self.descendants.get(thread)?;
        let (turn, root_turn) = child.turn.as_ref()?;
        if requested.is_some_and(|requested| requested != turn) {
            return None;
        }
        let mut parent = child.parent.as_ref()?;
        for _ in 0..32 {
            if let Some(route) = self.routes.get(parent) {
                return (route.descendants
                    && !route.ended
                    && route.turn.as_ref() == Some(root_turn))
                .then(|| parent.clone());
            }
            parent = self.descendants.get(parent)?.parent.as_ref()?;
        }
        None
    }

    fn observe(&mut self, frame: &Value) -> bool {
        let p = &frame["params"];
        match frame["method"].as_str() {
            Some("thread/started") => {
                if let Some(metadata) = lineage::child(&p["thread"]) {
                    let thread = metadata["threadId"].as_js_string().unwrap();
                    let parent = metadata["parentThreadId"].as_js_string().unwrap();
                    self.relate(thread, parent);
                }
            }
            Some("item/started" | "item/completed") => {
                let item = &p["item"];
                if let Some(parent) = p["threadId"].as_js_string()
                    && (item["type"] != "collabAgentToolCall"
                        || item["senderThreadId"].as_js_string() == Some(parent))
                {
                    for child in lineage::item_children(item) {
                        self.relate(child, parent);
                    }
                }
            }
            Some("turn/started") => {
                if let (Some(thread), Some(turn)) =
                    (p["threadId"].as_js_string(), p["turn"]["id"].as_js_string())
                {
                    if let Some(route) = self.routes.get_mut(thread) {
                        if route.turn.is_none() {
                            route.turn = Some(turn.clone());
                        }
                    } else if let Some(root) = p["turn"]["rootTurnId"]
                        .as_js_string()
                        .filter(|root| *root != turn)
                        && let Some(entry) = self.descendant(thread)
                    {
                        let previous = entry.turn.replace((turn.clone(), root.clone()));
                        return previous.is_some_and(|(previous, _)| previous != *turn)
                            && self.retire(thread);
                    }
                }
            }
            Some("turn/completed") => {
                if let Some(thread) = p["threadId"].as_js_string() {
                    let turn = p["turn"]["id"].as_js_string();
                    if let Some(route) = self.routes.get_mut(thread) {
                        if route.turn.as_ref() == turn {
                            route.ended = true;
                        }
                    } else if let Some(child) = self.descendants.get_mut(thread) {
                        if child.turn.as_ref().map(|(id, _)| id) == turn {
                            child.turn = None;
                            return self.retire(thread);
                        }
                    }
                }
            }
            Some("thread/closed" | "thread/status/changed") => {
                if (frame["method"] == "thread/closed" || p["status"]["type"] == "notLoaded")
                    && let Some(thread) = p["threadId"].as_js_string()
                {
                    self.descendants.shift_remove(thread);
                    return self.retire(thread);
                }
            }
            _ => {}
        }
        false
    }

    fn relate(&mut self, child: &JsString, parent: &JsString) {
        if child != parent
            && let Some(entry) = self.descendant(child)
            && entry.parent.is_none()
        {
            entry.parent = Some(parent.clone());
        }
    }

    fn descendant(&mut self, thread: &JsString) -> Option<&mut Descendant> {
        if !self.descendants.contains_key(thread) && self.descendants.len() >= 512 {
            // Preserve active children and cached parents of descendants.
            let idle = self.descendants.iter().position(|(id, child)| {
                child.turn.is_none()
                    && self
                        .descendants
                        .values()
                        .all(|other| other.parent.as_ref() != Some(id))
            })?;
            self.descendants.shift_remove_index(idle);
        }
        Some(self.descendants.entry(thread.clone()).or_default())
    }

    fn retire(&mut self, thread: &JsString) -> bool {
        let mut changed = false;
        for route in self.routes.values_mut() {
            route.pending.retain(|_, pending| {
                if pending.frame["params"]["threadId"].as_js_string() != Some(thread) {
                    return true;
                }
                changed = true;
                let _ = route.events.try_send(json!({
                    "method":"serverRequest/resolved",
                    "params":json!({"threadId":thread,"requestId":pending.frame["id"]}),
                }));
                false
            });
        }
        changed
    }
}
