//! Permanent-offline callbacks execute before a replacement lifecycle is
//! published. Temporary transport interruption retains the reconnect grace.
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};
use uuid::Uuid;
pub type OfflineHandler = Arc<dyn Fn() + Send + Sync>;
type Group = Arc<Mutex<IndexMap<Uuid, OfflineHandler>>>;
#[derive(Default)]
pub(super) struct OfflineListeners {
    groups: Mutex<HashMap<String, Group>>,
}
pub struct OfflineSubscription {
    registry: Weak<OfflineListeners>,
    group: Weak<Mutex<IndexMap<Uuid, OfflineHandler>>>,
    worker: String,
    id: Uuid,
}
impl Drop for OfflineSubscription {
    fn drop(&mut self) {
        let (Some(registry), Some(group)) = (self.registry.upgrade(), self.group.upgrade()) else {
            return;
        };
        let mut groups = registry.groups.lock().unwrap();
        let empty = {
            let mut g = group.lock().unwrap();
            g.shift_remove(&self.id);
            g.is_empty()
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
impl OfflineListeners {
    pub(super) fn subscribe(
        self: &Arc<Self>,
        worker: &str,
        handler: OfflineHandler,
    ) -> OfflineSubscription {
        let mut groups = self.groups.lock().unwrap();
        let group = groups.entry(worker.into()).or_default();
        let id = {
            let mut g = group.lock().unwrap();
            if let Some((id, _)) = g.iter().find(|(_, h)| Arc::ptr_eq(h, &handler)) {
                *id
            } else {
                let id = Uuid::new_v4();
                g.insert(id, handler);
                id
            }
        };
        OfflineSubscription {
            registry: Arc::downgrade(self),
            group: Arc::downgrade(group),
            worker: worker.into(),
            id,
        }
    }
    pub(super) fn deliver(&self, worker: &str) {
        let group = self.groups.lock().unwrap().get(worker).cloned();
        let Some(group) = group else { return };
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
            handler();
        }
    }
    pub(super) fn clear(&self) {
        self.groups.lock().unwrap().clear();
    }
}
