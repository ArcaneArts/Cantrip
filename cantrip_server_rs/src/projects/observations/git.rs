//! Coalesce observations per durable operation, retaining in-flight work on close.
use super::Service;
use crate::{
    projects::git_operations,
    wire::{
        Value,
        value::{JsString, json},
    },
};
use anyhow::{Context, Result};
use futures::FutureExt;
use indexmap::IndexMap;
use std::sync::{Arc, Mutex};

struct Pending {
    owner: String,
    worker: String,
    notification: Value,
}
#[derive(Default)]
struct Entry {
    pending: Option<Pending>,
    running: bool,
    fingerprint: Option<Value>,
    observed_at: Option<JsString>,
}
pub(super) struct Registry {
    entries: IndexMap<Vec<u16>, Arc<Mutex<Entry>>>,
    revision: i64,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            entries: IndexMap::new(),
            revision: crate::auth::now().timestamp_millis() * 1000,
        }
    }
}
impl Registry {
    fn admit(&mut self, pending: Pending) -> Option<Arc<Mutex<Entry>>> {
        let mut key: Vec<u16> = format!("{}:{}", pending.owner, pending.worker)
            .encode_utf16()
            .collect();
        for field in ["projectId", "worktreeId", "operationId"] {
            key.push(u16::from(b':'));
            key.extend_from_slice(pending.notification[field].as_js_string()?.units());
        }
        let is_new = !self.entries.contains_key(&key);
        let entry = self.entries.entry(key.clone()).or_default().clone();
        if is_new && self.entries.len() > 4096 {
            let oldest = self
                .entries
                .iter()
                .find(|(candidate, entry)| **candidate != key && !entry.lock().unwrap().running)
                .map(|(candidate, _)| candidate.clone());
            if let Some(oldest) = oldest {
                self.entries.shift_remove(&oldest);
            }
        }
        let mut state = entry.lock().unwrap();
        let observed = pending.notification["observedAt"].as_js_string()?;
        if state.fingerprint.as_ref() == Some(&pending.notification["fingerprint"])
            || state
                .observed_at
                .as_ref()
                .is_some_and(|settled| observed.units() < settled.units())
            || state.pending.as_ref().is_some_and(|queued| {
                observed.units()
                    < queued.notification["observedAt"]
                        .as_js_string()
                        .unwrap()
                        .units()
            })
        {
            return None;
        }
        state.pending = Some(pending);
        if state.running {
            return None;
        }
        state.running = true;
        drop(state);
        Some(entry)
    }
    pub(super) fn next_revision(&mut self) -> i64 {
        self.revision = (self.revision + 1).max(crate::auth::now().timestamp_millis() * 1000);
        self.revision
    }
    pub(super) fn clear(&mut self) {
        self.entries.clear();
    }
}

impl Service {
    pub(super) fn git_observed(
        self: &Arc<Self>,
        owner: String,
        worker: String,
        notification: Value,
    ) {
        let mut state = self.state.lock().unwrap();
        if state.stopped {
            return;
        }
        let Some(entry) = state.git.admit(Pending {
            owner,
            worker,
            notification,
        }) else {
            return;
        };
        let service = self.clone();
        // Capture the entry itself: clearing the registry on shutdown must not
        // destroy the pending work already owned by the running consumer.
        drop(self.tasks.own(service.consume_git(entry)));
    }

    async fn consume_git(self: Arc<Self>, entry: Arc<Mutex<Entry>>) -> Result<()> {
        loop {
            let pending = {
                let mut state = entry.lock().unwrap();
                let Some(pending) = state.pending.take() else {
                    state.running = false;
                    break;
                };
                if state.fingerprint.as_ref() == Some(&pending.notification["fingerprint"]) {
                    continue;
                }
                pending
            };
            let retained = self.clone();
            let notification = pending.notification.clone();
            let owner = pending.owner.clone();
            let worker = pending.worker.clone();
            let result = self
                .project_operations
                .serialize_background(
                    &pending.owner,
                    pending.notification["projectId"]
                        .as_str()
                        .context("Git observation project")?,
                    true,
                    move || {
                        async move { retained.reconcile_git(&owner, &worker, &notification).await }
                            .boxed()
                    },
                )
                .await;
            match result {
                Ok(true) => {
                    let mut state = entry.lock().unwrap();
                    state.fingerprint = Some(pending.notification["fingerprint"].clone());
                    state.observed_at = pending.notification["observedAt"].as_js_string().cloned();
                }
                Ok(false) => {}
                Err(error) => {
                    use crate::operations::logging::{self, LogCall};
                    (logging::server_logger())(LogCall::event(
                        "warn",
                        "Could not reconcile observed Git operation state",
                        json!({"err":json!({"message":error.to_string()}),"operationId":pending.notification["operationId"],"workerId":pending.worker}),
                    ));
                    self.schedule_worker(pending.owner, pending.worker);
                }
            }
        }
        Ok(())
    }

    async fn reconcile_git(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        notification: &Value,
    ) -> Result<bool> {
        let project = notification["projectId"]
            .as_str()
            .context("Git observation project")?;
        let tree = notification["worktreeId"]
            .as_str()
            .context("Git observation worktree")?;
        let operation = notification["operationId"]
            .as_str()
            .context("Git observation operation")?;
        let Some(context) = self
            .repository
            .worktree_context(owner, project, tree)
            .await?
        else {
            return Ok(false);
        };
        if context["workerId"] != worker
            || context["sourcePath"] != notification["sourcePath"]
            || context["worktree"]["path"] != notification["worktreePath"]
        {
            return Ok(false);
        }
        let Some(durable) = self
            .git_operations
            .get(owner, project, tree, operation)
            .await?
        else {
            return Ok(false);
        };
        if durable["workerId"] != worker {
            return Ok(false);
        }
        if git_operations::terminal(&durable["state"]) {
            if durable["state"] != notification["state"]["state"]
                || durable["currentHead"] != notification["state"]["currentHead"]
            {
                return Ok(false);
            }
            self.publish_git_conflicts(owner, project, tree, &notification["conflicts"]);
            return Ok(true);
        }
        let response = self.commands.request(worker, json!({"type":"git.operation.inspect","cwd":context["worktree"]["path"],"context":git_operations::context(&durable)}), None, None).await?;
        let state = crate::settings::parse_response(
            "gitManagedOperationWorkerStateSchema",
            response.as_ref(),
        )?;
        let matches = git_operations::observation_matches(&state, &notification["state"]);
        let Some(updated) = self
            .git_operations
            .update(owner, project, tree, operation, &state)
            .await?
        else {
            return Ok(false);
        };
        let status = status_from_git(&context["worktree"], &state["status"])?;
        self.record_live_status(owner, project, tree, &status)
            .await?;
        self.publish_git_operation(owner, &updated);
        if matches {
            self.publish_git_conflicts(owner, project, tree, &notification["conflicts"]);
        } else {
            self.git_invalidation(owner, project, tree, "git-conflict");
        }
        if git_operations::terminal(&updated["state"]) {
            self.git_invalidation(owner, project, tree, "worktree");
        }
        self.schedule_worker(owner.to_owned(), worker.to_owned());
        // The serialized project's change callback additionally invalidates
        // its entire worktree list and schedules project observation.
        // Source also schedules this worker explicitly before that callback.
        Ok(true)
    }
}

fn status_from_git(worktree: &Value, status: &Value) -> Result<Value> {
    let branch = crate::wire::coercion::truthy(status.get("branch"));
    crate::settings::parse_response(
        "worktreeStatusResultSchema",
        Some(&json!({"worktree":json!({
        "path":worktree["path"],"head":status["head"],"branch":if branch {status["branch"].clone()} else {Value::Null},
        "detached":!branch,"isPrimary":worktree["isPrimary"],"managed":worktree["isPrimary"]!=true && worktree["origin"]!="external",
        "locked":worktree["locked"],"lockReason":worktree["lockReason"],"prunable":worktree["lifecycleState"]=="prunable",
        "pruneReason":Value::Null,"missing":worktree["lifecycleState"]=="missing"
    }),"status":status})),
    )
}
