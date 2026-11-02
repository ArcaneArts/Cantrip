//! Known Goal observations are refreshed on worker connection, never by badges.
use crate::{auth::service::AuthService, chats, project_alerts::Repository, wire::value::json};
use anyhow::Result;
use std::sync::Arc;

pub fn worker_connected(
    service: Arc<AuthService>,
    owner: String,
    worker: String,
    generation: String,
) {
    tokio::spawn(async move {
        let reconciler = service.clone();
        let outcome = service
            .scratch_roots
            .owned(async move {
                if reconciler
                    .workers
                    .bridge
                    .connection_identity(&worker)
                    .is_some_and(|i| i.owner != owner || i.process_generation != generation)
                {
                    return Ok(());
                }
                Repository::new(reconciler.repository.database.clone())
                    .register_goal_worker(&owner, &worker, &generation)
                    .await?;
                reconcile(&reconciler, &owner, &worker).await
            })
            .await;
        if outcome.is_err() {
            eprintln!(
                "{}",
                json!({"event":"project-alert.goal-reconciliation-pending"})
            );
        }
    });
}
async fn reconcile(service: &AuthService, owner: &str, worker: &str) -> Result<()> {
    let alerts = Repository::new(service.repository.database.clone());
    let chats = chats::Repository::new(service.repository.database.clone());
    let mut after = None;
    let mut failed = false;
    loop {
        let known = alerts.goal_chats(owner, worker, after.as_deref()).await?;
        for chat in &known {
            let observation:Result<()>=async {
                let Some(context)=chats.execution_context(owner,chat).await? else { return Ok(()); };
                if context["contextKind"]!="project" || context["experience"]!="agent" || context["workerId"]!=worker || context["threadId"].is_null() { return Ok(()); }
                let runtime=if context["modelRouteId"].is_null() {
                    service.model_routing.runtime_for_context(owner,&context).await?
                }else{Some(service.model_routing.bound_managed_runtime(owner,&context).await?)};
                let Some(runtime)=runtime else { return Ok(()); };
                let command=json!({"type":"chat.goal.get","chatId":context["chatId"],"cwd":context["cwd"],"threadId":context["threadId"],"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":chats::managed_console::permission_profile(&context)["effectiveId"],"protectObjective":true});
                service.workers.commands.request(worker,command,Some(std::time::Duration::from_secs(15)),None).await?;
                Ok(())
            }.await;
            failed |= observation.is_err();
        }
        if known.len() < 100 {
            break;
        }
        after = known.last().cloned();
    }
    if failed {
        anyhow::bail!("Goal observation reconciliation remains pending");
    }
    Ok(())
}
