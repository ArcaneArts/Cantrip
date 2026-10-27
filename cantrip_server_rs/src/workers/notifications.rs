//! Worker notification subscriptions retain insertion order and reconnect scope.
use crate::wire::Value;
use futures::FutureExt;
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};
use uuid::Uuid;

pub type NotificationFuture = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;
pub type NotificationHandler = Arc<dyn Fn(Arc<Value>) -> NotificationFuture + Send + Sync>;
pub(super) type Group = Arc<Mutex<IndexMap<Uuid, NotificationHandler>>>;

#[derive(Default)]
pub(super) struct Notifications {
    groups: Mutex<HashMap<String, Group>>,
}

pub struct NotificationSubscription {
    registry: Weak<Notifications>,
    group: Weak<Mutex<IndexMap<Uuid, NotificationHandler>>>,
    worker: String,
    id: Uuid,
}

impl Drop for NotificationSubscription {
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
                .is_some_and(|current| Arc::ptr_eq(current, &group))
        {
            groups.remove(&self.worker);
        }
    }
}

impl Notifications {
    pub(super) fn subscribe(
        self: &Arc<Self>,
        worker: &str,
        handler: NotificationHandler,
    ) -> NotificationSubscription {
        let mut groups = self.groups.lock().unwrap();
        let group = groups.entry(worker.into()).or_default();
        let id = {
            let mut listeners = group.lock().unwrap();
            if let Some((id, _)) = listeners
                .iter()
                .find(|(_, current)| Arc::ptr_eq(current, &handler))
            {
                *id
            } else {
                let id = Uuid::new_v4();
                listeners.insert(id, handler);
                id
            }
        };
        NotificationSubscription {
            registry: Arc::downgrade(self),
            group: Arc::downgrade(group),
            worker: worker.into(),
            id,
        }
    }

    pub(super) fn group(&self, worker: &str) -> Option<Group> {
        self.groups.lock().unwrap().get(worker).cloned()
    }

    pub(super) fn deliver(group: Group, notification: Value) {
        let notification = Arc::new(notification);
        let mut visited = HashSet::new();
        let mut pending = Vec::new();
        loop {
            // Release locks before invoking application code. Read the live
            // group so removals and additions during a callback retain Set
            // iteration behavior.
            let next = group
                .lock()
                .unwrap()
                .iter()
                .find(|(id, _)| !visited.contains(*id))
                .map(|(id, handler)| (*id, handler.clone()));
            let Some((id, handler)) = next else { break };
            visited.insert(id);
            let mut future = handler(notification.clone());
            // A JS async listener runs through its first await immediately.
            // Poll that prefix in delivery order, then let pending listeners
            // continue independently. Rejections do not fail other listeners.
            if future.as_mut().now_or_never().is_none() {
                pending.push(future);
            }
        }
        for future in pending {
            tokio::spawn(async move {
                let _ = future.await;
            });
        }
    }

    pub(super) fn clear(&self) {
        self.groups.lock().unwrap().clear();
    }
}
