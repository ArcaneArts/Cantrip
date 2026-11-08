//! Local completion fences contain no protected approval payloads.
use anyhow::{Result, ensure};
use futures::{FutureExt, future::BoxFuture};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub type Scope = (String, String, String);
type Key = (Scope, String);
#[derive(Default)]
struct State {
    commands: HashMap<Scope, HashMap<uuid::Uuid, watch::Sender<bool>>>,
    command_count: usize,
    inserts: HashMap<Key, watch::Sender<bool>>,
}
#[derive(Default)]
pub struct Publications(Mutex<State>);
enum Kind {
    Command(Scope, uuid::Uuid),
    Insert(Key),
}
pub struct Completion {
    registry: Arc<Publications>,
    kind: Kind,
}
impl Drop for Completion {
    fn drop(&mut self) {
        let mut state = self.registry.0.lock().unwrap();
        let sender = match &self.kind {
            Kind::Command(scope, id) => {
                let group = state.commands.get_mut(scope).unwrap();
                let sender = group.remove(id);
                if group.is_empty() {
                    state.commands.remove(scope);
                }
                state.command_count -= 1;
                sender
            }
            Kind::Insert(key) => state.inserts.remove(key),
        };
        if let Some(sender) = sender {
            sender.send_replace(true);
        }
    }
}
impl Publications {
    pub fn begin(self: &Arc<Self>, scope: Scope) -> Result<Completion> {
        let mut state = self.0.lock().unwrap();
        ensure!(
            state.command_count < 256,
            "Computer-use approval publication is unavailable."
        );
        let id = uuid::Uuid::new_v4();
        state
            .commands
            .entry(scope.clone())
            .or_default()
            .insert(id, watch::channel(false).0);
        state.command_count += 1;
        Ok(Completion {
            registry: self.clone(),
            kind: Kind::Command(scope, id),
        })
    }
    pub fn insert(self: &Arc<Self>, scope: Scope, request: String) -> Result<Completion> {
        let mut state = self.0.lock().unwrap();
        let key = (scope, request);
        ensure!(
            !state.inserts.contains_key(&key) && state.inserts.len() < 256,
            "Computer-use approval publication is unavailable."
        );
        state.inserts.insert(key.clone(), watch::channel(false).0);
        Ok(Completion {
            registry: self.clone(),
            kind: Kind::Insert(key),
        })
    }
    pub fn wait_commands(&self, scope: &Scope) -> BoxFuture<'static, ()> {
        // Snapshot now: subsequent commands cannot extend this notification.
        let pending = self
            .0
            .lock()
            .unwrap()
            .commands
            .get(scope)
            .map(|group| {
                group
                    .values()
                    .map(watch::Sender::subscribe)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        async move {
            futures::future::join_all(pending.into_iter().map(wait)).await;
        }
        .boxed()
    }
    pub fn wait_insert(&self, scope: Scope, request: String) -> BoxFuture<'static, ()> {
        let pending = self
            .0
            .lock()
            .unwrap()
            .inserts
            .get(&(scope, request))
            .map(watch::Sender::subscribe);
        async move {
            if let Some(pending) = pending {
                wait(pending).await;
            }
        }
        .boxed()
    }
}
async fn wait(mut pending: watch::Receiver<bool>) {
    let _ = pending.wait_for(|done| *done).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> Scope {
        ("owner".into(), "worker".into(), "chat".into())
    }
    #[test]
    fn notification_snapshot_excludes_commands_started_after_it() -> Result<()> {
        let registry = Arc::new(Publications::default());
        let first = registry.begin(scope())?;
        let snapshot = registry.wait_commands(&scope());
        let second = registry.begin(scope())?;
        drop(first);
        assert!(snapshot.now_or_never().is_some());
        assert!(registry.wait_commands(&scope()).now_or_never().is_none());
        drop(second);
        assert!(registry.wait_commands(&scope()).now_or_never().is_some());
        Ok(())
    }
    #[test]
    fn unfinished_insert_remains_fenced_after_command_and_waiter_end() -> Result<()> {
        let registry = Arc::new(Publications::default());
        let command = registry.begin(scope())?;
        let insert = registry.insert(scope(), "request".into())?;
        assert!(
            registry
                .wait_insert(scope(), "request".into())
                .now_or_never()
                .is_none()
        );
        drop(command);
        assert!(registry.insert(scope(), "request".into()).is_err());
        let snapshot = registry.wait_insert(scope(), "request".into());
        drop(insert);
        assert!(snapshot.now_or_never().is_some());
        assert!(registry.insert(scope(), "request".into()).is_ok());
        Ok(())
    }
    #[test]
    fn both_fence_limits_release_all_slots_after_completion() -> Result<()> {
        let registry = Arc::new(Publications::default());
        let commands = (0..256)
            .map(|_| registry.begin(scope()))
            .collect::<Result<Vec<_>>>()?;
        assert!(registry.begin(scope()).is_err());
        let inserts = (0..256)
            .map(|n| registry.insert(scope(), n.to_string()))
            .collect::<Result<Vec<_>>>()?;
        assert!(registry.insert(scope(), "overflow".into()).is_err());
        drop(commands);
        drop(inserts);
        assert!(registry.begin(scope()).is_ok());
        assert!(registry.insert(scope(), "overflow".into()).is_ok());
        Ok(())
    }
}
