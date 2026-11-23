use super::{Service, text};
use crate::wire::{Value, value::json};
use anyhow::{Result, ensure};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;

impl Service {
    pub fn remove(
        self: &Arc<Self>,
        owner: String,
        project: String,
        worktree: String,
        input: Value,
        retire: BoxFuture<'static, Result<()>>,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let service = self.clone();
        self.coordinator
            .serialize(&owner.clone(), &project.clone(), true, move || {
                async move {
                    service
                        .remove_in_project(&owner, &project, &worktree, &input, retire)
                        .await
                }
                .boxed()
            })
    }
    async fn remove_in_project(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        input: &Value,
        retire: BoxFuture<'static, Result<()>>,
    ) -> Result<Option<Value>> {
        let Some(context) = self
            .repository
            .worktree_context(owner, project, worktree)
            .await?
        else {
            return Ok(None);
        };
        ensure!(
            context["worktree"]["isPrimary"] != true,
            "Primary cannot be removed as a worktree."
        );
        ensure!(
            context["worktree"]["origin"] != "external" || input["allowExternal"] == true,
            "Removing an external worktree requires explicit authorization."
        );
        if let Some(blockers) = self
            .repository
            .worktree_removal_blockers(owner, project, worktree)
            .await?
        {
            ensure!(
                [
                    "activeChatIds",
                    "activeLeaseChatIds",
                    "boundCodeTabIds",
                    "runningTerminalIds"
                ]
                .iter()
                .all(|key| blockers[*key].as_array().is_none_or(|rows| rows.is_empty())),
                "Stop active chats and terminals, release chat leases, and retarget or delete bound Code tabs before removal."
            );
        }
        retire.await?;
        let previous = text(&context["worktree"], "lifecycleState")?;
        self.repository
            .set_worktree_lifecycle(owner, project, worktree, "removing")
            .await?;
        let result:Result<Option<Value>>=async {
            let worker=text(&context,"workerId")?;
            let result=self.request(worker,json!({"type":"worktree.remove","sourcePath":context["sourcePath"],"worktreePath":context["worktree"]["path"],"force":input["force"],"allowExternal":input["allowExternal"]}),"worktreeRemoveResultSchema").await?;
            Ok(self.repository.reconcile_worktrees(owner,project,worker,&result["inventory"],None).await?.and_then(|rows|rows.into_iter().find(|row|row["id"]==worktree)))
        }.await;
        if result.is_err() {
            self.repository
                .set_worktree_lifecycle(owner, project, worktree, previous)
                .await?;
        }
        result
    }
}
