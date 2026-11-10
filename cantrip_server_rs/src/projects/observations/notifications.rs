//! Resolve worker inventory and filesystem notifications against owned routing paths.
use super::Service;
use crate::wire::{Value, value::json};
use anyhow::Context;
use futures::FutureExt;
use std::sync::Arc;

fn logged(
    worker: String,
    kind: &'static str,
    future: futures::future::BoxFuture<'static, anyhow::Result<()>>,
) -> futures::future::BoxFuture<'static, anyhow::Result<()>> {
    async move {
        if let Err(error) = future.await {
            use crate::operations::logging::{self, LogCall};
            (logging::server_logger())(LogCall::event("warn", "Could not apply worker notification", json!({"err":json!({"message":error.to_string()}),"notificationType":kind,"workerId":worker})));
        }
        Ok(())
    }.boxed()
}

impl Service {
    pub fn subscribe(self: &Arc<Self>, worker: &str) {
        let mut state = self.state.lock().unwrap();
        if state.stopped {
            return;
        }
        state
            .subscriptions
            .entry(worker.to_owned())
            .or_insert_with(|| {
                let weak = Arc::downgrade(self);
                let worker = worker.to_owned();
                self.bridge.subscribe_owned_notifications(
                    &worker.clone(),
                    Arc::new(move |owner, notification| {
                        let Some(service) = weak.upgrade() else {
                            return async { Ok(()) }.boxed();
                        };
                        if notification["type"] == "codegraph.status.observed" {
                            return logged(
                                worker.clone(),
                                "codegraph.status.observed",
                                service.codegraph_observed(
                                    owner,
                                    worker.clone(),
                                    &notification["status"],
                                ),
                            );
                        }
                        let kind = match notification["type"].as_str() {
                            Some("worktree.filesystem.changed") => "worktree.filesystem.changed",
                            Some("worktree.inventory.observed") => "worktree.inventory.observed",
                            Some("worktree.status.observed") => "worktree.status.observed",
                            _ => return async { Ok(()) }.boxed(),
                        };
                        if notification["type"] == "worktree.inventory.observed"
                            && (notification["inventory"]["sourcePath"]
                                != notification["sourcePath"]
                                || notification["inventory"]["primaryPath"] == "")
                        {
                            return async { Ok(()) }.boxed();
                        }
                        let state = service.state.lock().unwrap();
                        if state.stopped {
                            return async { Ok(()) }.boxed();
                        }
                        let retained = service.clone();
                        let worker = worker.clone();
                        logged(
                            worker.clone(),
                            kind,
                            service.tasks.own(async move {
                                if kind == "worktree.inventory.observed" {
                                    retained
                                        .inventory_observed(&owner, &worker, &notification)
                                        .await
                                } else if kind == "worktree.status.observed" {
                                    retained
                                        .status_observed(&owner, &worker, &notification)
                                        .await
                                } else {
                                    retained
                                        .filesystem_changed(&owner, &worker, &notification)
                                        .await
                                }
                            }),
                        )
                    }),
                )
            });
    }

    async fn status_observed(
        &self,
        owner: &str,
        worker: &str,
        notification: &Value,
    ) -> anyhow::Result<()> {
        let Some(context) = self
            .repository
            .observation_context(
                owner,
                worker,
                notification["sourcePath"]
                    .as_str()
                    .context("Status observation source")?,
                notification["worktreePath"]
                    .as_str()
                    .context("Status observation worktree")?,
            )
            .await?
        else {
            return Ok(());
        };
        let status = &notification["result"];
        if status["worktree"]["path"] != notification["worktreePath"] {
            return Ok(());
        }
        let project = context["projectId"]
            .as_str()
            .context("Status observation project")?;
        let worktree = context["worktreeId"]
            .as_str()
            .context("Status observation worktree identity")?;
        let Some(recorded) = self
            .repository
            .record_worktree_status(owner, project, worktree, status)
            .await?
        else {
            return Ok(());
        };
        let Some(live) = self.live.upgrade() else {
            return Ok(());
        };
        if !live.publishing_enabled() {
            return Ok(());
        }
        if recorded["snapshotChanged"] == true {
            let publish = || -> anyhow::Result<()> {
                let payload = crate::wire::parse_property(
                    "worktreeStatusResultSchema",
                    "status",
                    &recorded["status"]["status"],
                )
                .map_err(crate::settings::response_error)?;
                let payload =
                    crate::settings::parse_response("appLiveEventPayloadSchema", Some(&payload))?;
                live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"worktree-status","action":"updated","entityId":worktree,"revision":Value::Null,"payload":payload}))?;
                Ok(())
            };
            if let Err(error) = publish() {
                use crate::operations::logging::{self, LogCall};
                (logging::server_logger())(LogCall::event(
                    "error",
                    "Could not publish worktree status",
                    json!({"err":json!({"message":error.to_string()}),"projectId":project,"worktreeId":worktree}),
                ));
            }
        }
        if recorded["metadataChanged"] == true {
            live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"worktree","action":"invalidated","entityId":worktree,"revision":Value::Null,"payload":Value::Null}))?;
        }
        Ok(())
    }

    async fn inventory_observed(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        notification: &Value,
    ) -> anyhow::Result<()> {
        let inventory = &notification["inventory"];
        let Some(context) = self
            .repository
            .observation_context(
                owner,
                worker,
                notification["sourcePath"]
                    .as_str()
                    .context("Inventory observation source")?,
                inventory["primaryPath"]
                    .as_str()
                    .context("Inventory observation Primary")?,
            )
            .await?
        else {
            return Ok(());
        };
        let project = context["projectId"]
            .as_str()
            .context("Inventory observation project")?;
        if self
            .repository
            .reconcile_worktrees(owner, project, worker, inventory, None)
            .await?
            .is_none()
        {
            return Ok(());
        }
        if let Some(live) = self.live.upgrade() {
            live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"worktree","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null}))?;
        }
        self.schedule_worker(owner.to_owned(), worker.to_owned());
        Ok(())
    }

    async fn filesystem_changed(
        &self,
        owner: &str,
        worker: &str,
        notification: &Value,
    ) -> anyhow::Result<()> {
        let context = self
            .repository
            .observation_context(
                owner,
                worker,
                notification["sourcePath"]
                    .as_str()
                    .context("Filesystem observation source")?,
                notification["worktreePath"]
                    .as_str()
                    .context("Filesystem observation worktree")?,
            )
            .await?;
        if let (Some(context), Some(live)) = (context, self.live.upgrade()) {
            live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":context["projectId"]}),"resource":"explorer-filesystem","action":"invalidated","entityId":context["worktreeId"],"revision":Value::Null,"payload":Value::Null}))?;
        }
        Ok(())
    }
}
