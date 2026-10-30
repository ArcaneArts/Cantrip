//! Reserve revisions before database awaits; only the latest observation may publish.
use super::Service;
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use indexmap::IndexMap;
use std::sync::Arc;

struct Observation {
    fingerprint: String,
    published: Option<String>,
    revision: i64,
}
pub(super) struct Registry {
    revision: i64,
    observations: IndexMap<String, Observation>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            revision: crate::auth::now().timestamp_millis() * 1000,
            observations: IndexMap::new(),
        }
    }
}
impl Registry {
    fn admit(&mut self, key: String, fingerprint: String, now: i64) -> i64 {
        self.revision = (self.revision + 1).max(now * 1000);
        let published = self
            .observations
            .shift_remove(&key)
            .and_then(|previous| previous.published);
        self.observations.insert(
            key,
            Observation {
                fingerprint,
                published,
                revision: self.revision,
            },
        );
        if self.observations.len() > 4096 {
            self.observations.shift_remove_index(0);
        }
        self.revision
    }
    fn publish(&mut self, key: &str, revision: i64) -> bool {
        let Some(latest) = self.observations.get_mut(key) else {
            return false;
        };
        if latest.revision != revision || latest.published.as_ref() == Some(&latest.fingerprint) {
            return false;
        }
        latest.published = Some(latest.fingerprint.clone());
        true
    }
    pub(super) fn clear(&mut self) {
        self.observations.clear();
    }
}
impl Service {
    pub(super) fn codegraph_observed(
        self: &Arc<Self>,
        owner: String,
        worker: String,
        status: &Value,
    ) -> BoxFuture<'static, Result<()>> {
        let parsed = (|| -> Result<_> {
            let status =
                crate::settings::parse_response("codeGraphProjectStatusSchema", Some(status))?;
            let project = status["projectId"]
                .as_str()
                .context("CodeGraph project")?
                .to_owned();
            let worktree = status["worktreeId"]
                .as_str()
                .context("CodeGraph worktree")?
                .to_owned();
            Ok((status, project, worktree))
        })();
        let (status, project, worktree) = match parsed {
            Ok(value) => value,
            Err(error) => return async move { Err(error) }.boxed(),
        };
        let mut state = self.state.lock().unwrap();
        if state.stopped {
            return async { Ok(()) }.boxed();
        }
        let key = format!("{owner}:{worker}:{project}:{worktree}");
        let revision = state.codegraph.admit(
            key.clone(),
            status.stringify(),
            crate::auth::now().timestamp_millis(),
        );
        let service = self.clone();
        self.tasks.own(async move {
            let context = service.repository.worktree_context(&owner, &project, &worktree).await?;
            if context.is_none_or(|context| context["workerId"] != worker.as_str()) { return Ok(()); }
            if !service.state.lock().unwrap().codegraph.publish(&key, revision) { return Ok(()); }
            if let Some(live) = service.live.upgrade()
                && let Err(error) = live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"codegraph-status","action":"updated","entityId":worktree,"revision":revision,"payload":status})) {
                    use crate::operations::logging::{self, LogCall};
                    (logging::server_logger())(LogCall::event("error", "Could not publish CodeGraph status", json!({"err":json!({"message":error.to_string()}),"projectId":project,"worktreeId":worktree})));
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_completions_duplicates_and_unpublished_retries() {
        let mut registry = Registry {
            revision: 0,
            observations: IndexMap::new(),
        };
        let first = registry.admit("key".into(), "old".into(), 10);
        let second = registry.admit("key".into(), "new".into(), 9);
        assert!(second > first);
        assert!(!registry.publish("key", first));
        assert!(registry.publish("key", second));
        let duplicate = registry.admit("key".into(), "new".into(), 11);
        assert!(!registry.publish("key", duplicate));
        let rejected = registry.admit("key".into(), "retry".into(), 12);
        let retry = registry.admit("key".into(), "retry".into(), 13);
        assert!(!registry.publish("key", rejected));
        assert!(registry.publish("key", retry));
    }
    #[test]
    fn bounded_registry_refreshes_recent_keys_and_clears_inflight_revisions() {
        let mut registry = Registry::default();
        for n in 0..4096 {
            registry.admit(n.to_string(), "value".into(), 1);
        }
        let refreshed = registry.admit("0".into(), "value".into(), 1);
        registry.admit("new".into(), "value".into(), 1);
        assert_eq!(registry.observations.len(), 4096);
        assert!(!registry.observations.contains_key("1"));
        assert!(registry.publish("0", refreshed));
        registry.clear();
        assert!(!registry.publish("0", refreshed));
    }
}
