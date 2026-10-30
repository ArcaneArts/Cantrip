//! Synchronous, ordered binary frame listeners retain JavaScript Set
//! mutation behavior while allowing callbacks to change their subscriptions.
use crate::worker_links::frame::Frame;
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};
use uuid::Uuid;

pub type Handler<T> = Arc<dyn Fn(Arc<T>) -> anyhow::Result<()> + Send + Sync>;
pub type FrameHandler = Handler<Frame>;
pub type FrameSubscription = Subscription<Frame>;
type Group<T> = Arc<Mutex<IndexMap<Uuid, Handler<T>>>>;
pub(super) struct Frames<T = Frame> {
    groups: Mutex<HashMap<String, Group<T>>>,
}
impl<T> Default for Frames<T> {
    fn default() -> Self {
        Self {
            groups: Mutex::new(HashMap::new()),
        }
    }
}
pub struct Subscription<T> {
    registry: Weak<Frames<T>>,
    group: Weak<Mutex<IndexMap<Uuid, Handler<T>>>>,
    worker: String,
    id: Uuid,
}
impl<T> Drop for Subscription<T> {
    fn drop(&mut self) {
        let (Some(registry), Some(group)) = (self.registry.upgrade(), self.group.upgrade()) else {
            return;
        };
        let mut groups = registry.groups.lock().unwrap();
        let empty = {
            let mut listeners = group.lock().unwrap();
            listeners.shift_remove(&self.id);
            listeners.is_empty()
        };
        if empty
            && groups
                .get(&self.worker)
                .is_some_and(|g| Arc::ptr_eq(g, &group))
        {
            groups.remove(&self.worker);
        }
    }
}
impl<T> Frames<T> {
    pub(super) fn subscribe(
        self: &Arc<Self>,
        worker: &str,
        handler: Handler<T>,
    ) -> Subscription<T> {
        let mut groups = self.groups.lock().unwrap();
        let group = groups.entry(worker.into()).or_default();
        let id = {
            let mut listeners = group.lock().unwrap();
            if let Some((id, _)) = listeners.iter().find(|(_, h)| Arc::ptr_eq(h, &handler)) {
                *id
            } else {
                let id = Uuid::new_v4();
                listeners.insert(id, handler);
                id
            }
        };
        Subscription {
            registry: Arc::downgrade(self),
            group: Arc::downgrade(group),
            worker: worker.into(),
            id,
        }
    }
    pub(super) fn deliver(&self, worker: &str, frame: T) -> anyhow::Result<()> {
        let group = self.groups.lock().unwrap().get(worker).cloned();
        let Some(group) = group else { return Ok(()) };
        let frame = Arc::new(frame);
        let mut visited = HashSet::new();
        loop {
            let next = group
                .lock()
                .unwrap()
                .iter()
                .find(|(id, _)| !visited.contains(*id))
                .map(|(id, h)| (*id, h.clone()));
            let Some((id, handler)) = next else { break };
            visited.insert(id);
            handler(frame.clone())?;
        }
        Ok(())
    }
    pub(super) fn clear(&self) {
        self.groups.lock().unwrap().clear();
    }
}
