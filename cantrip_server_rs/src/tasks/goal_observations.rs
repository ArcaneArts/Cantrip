//! Ephemeral authority for passive native Goal reads. Never execution admission.
use super::*;
fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::new(
        "stale-version",
        "The Task or its native session changed during Goal observation.",
    )
    .into())
}
async fn snapshot(tx: &Transaction<'_>, owner: &str, chat: &str, target: &Value) -> Result<Value> {
    if !lock_user(tx, owner).await? {
        return stale();
    }
    tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats", &[&owner,&chat]).await?;
    let source=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',jsonb_build_object('id',c.id,'projectId',c.project_id,'experience',c.experience,'placementRevision',c.placement_revision,'managedInputRevision',c.managed_input_revision,'automationPaused',c.automation_paused,'status',c.status,'activeWorkerId',c.active_worker_id,'activeWorktreeId',c.active_worktree_id,'activeWorktreeWorkerId',w.worker_id,'activeWorktreePath',w.path,'archivedAt',c.archived_at),'project',jsonb_build_object('taskSchedulingPaused',p.task_scheduling_paused),'taskRowVersion',t.row_version)::text FROM chats c JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 JOIN project_worktrees w ON w.id=c.active_worktree_id AND w.project_id=p.id JOIN tasks t ON t.chat_id=c.id WHERE c.id=$2 LIMIT 1 FOR UPDATE OF c,p,t,w",&[&owner,&chat]).await?;
    let Some(mut source) = source.filter(|s| s["chat"]["archivedAt"].is_null()) else {
        return stale();
    };
    let runtime=one(Executor::Transaction(tx),"SELECT jsonb_build_object('id',r.id,'threadId',r.codex_thread_id,'modelRouteId',r.model_route_id,'providerAccountId',r.provider_account_id)::text FROM chat_runtime_sessions r WHERE r.chat_id=$1 AND r.worker_id=$2 AND r.worktree_id=$3 LIMIT 1 FOR UPDATE",&[&chat,&text(&target["workerId"])?,&text(&target["worktreeId"])?]).await?;
    let lane=one(Executor::Transaction(tx),"SELECT jsonb_build_object('id',l.id,'activatedAt',l.activated_at,'workerId',l.worker_id,'worktreeId',l.worktree_id,'threadId',l.codex_thread_id)::text FROM chat_execution_lanes l WHERE l.chat_id=$1 AND l.state='active' LIMIT 1 FOR UPDATE",&[&chat]).await?;
    let cycle=one(Executor::Transaction(tx),"SELECT jsonb_build_object('dispatch',jsonb_build_object('id',c.id,'operationId',c.operation_id,'state',c.state,'fencingToken',c.fencing_token,'leaseOwner',c.lease_owner,'physicalWorkerId',c.physical_worker_id,'worktreeId',c.worktree_id,'codexThreadId',c.codex_thread_id,'modelRouteId',c.model_route_id,'providerAccountId',c.provider_account_id),'goalInput',CASE WHEN c.goal_input IS NULL THEN NULL ELSE jsonb_build_object('operationId',c.goal_input->'receipt'->'operationId','deferred',c.goal_input->'deferred','firstDispatchedOperationId',c.goal_input->'firstDispatchedOperationId','failedBeforeDispatch',COALESCE(c.goal_input->'failedBeforeDispatch','false'::jsonb),'terminalObservedAt',c.goal_input->'terminal'->'observedAt','terminalProjectedAt',c.goal_input->'terminal'->'projectedAt') END)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1 FOR UPDATE",&[&owner,&chat]).await?;
    source["runtime"] = runtime.unwrap_or(Value::Null);
    source["lane"] = lane.unwrap_or(Value::Null);
    source["dispatch"] = cycle
        .as_ref()
        .map(|c| c["dispatch"].clone())
        .unwrap_or(Value::Null);
    source["goalInput"] = cycle
        .as_ref()
        .map(|c| c["goalInput"].clone())
        .unwrap_or(Value::Null);
    Ok(source)
}
fn dispatch_identity(d: &Value) -> Value {
    if d.is_null() {
        return Value::Null;
    }
    json!({"id":d["id"],"operationId":d["operationId"],"state":d["state"],"fencingToken":d["fencingToken"],
        "leaseOwner":d["leaseOwner"],"physicalWorkerId":d["physicalWorkerId"],"worktreeId":d["worktreeId"],
        "codexThreadId":d["codexThreadId"],"modelRouteId":d["modelRouteId"],"providerAccountId":d["providerAccountId"]})
}
pub(crate) async fn assert_in(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    fence: &Value,
) -> Result<()> {
    if snapshot(tx, owner, chat, &fence["target"]).await? != fence["snapshot"] {
        return stale();
    }
    Ok(())
}
pub(crate) fn after_projection(fence: &Value, version: &Value) -> Value {
    let mut fence = fence.clone();
    fence["snapshot"]["taskRowVersion"] = version.clone();
    fence
}
impl Repository {
    pub async fn capture_goal_observation(
        &self,
        owner: &str,
        context: &Value,
        task: &Value,
    ) -> Result<Value> {
        if context["contextKind"] != "project"
            || context["experience"] != "task"
            || !truthy(context.get("threadId"))
            || context["chatId"] != task["chatId"]
        {
            return stale();
        }
        let (owner, context, task) = (owner.to_owned(), context.clone(), task.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let target=json!({"workerId":context["workerId"],"worktreeId":context["worktreeId"],"threadId":context["threadId"],"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"]});
            let s=snapshot(tx,&owner,&text(&context["chatId"])?,&target).await?;
            let active=s["chat"]["activeWorktreeWorkerId"]==target["workerId"] && s["chat"]["activeWorktreeId"]==target["worktreeId"] &&
                s["runtime"]["threadId"]==target["threadId"] && s["runtime"]["modelRouteId"]==target["modelRouteId"] && s["runtime"]["providerAccountId"]==target["providerAccountId"];
            // Recovery can observe the retained session before restoring placement.
            let retained=s["dispatch"]["physicalWorkerId"]==target["workerId"] && s["dispatch"]["worktreeId"]==target["worktreeId"] &&
                s["dispatch"]["codexThreadId"]==target["threadId"] && s["dispatch"]["modelRouteId"]==target["modelRouteId"] && s["dispatch"]["providerAccountId"]==target["providerAccountId"];
            if (!active && !retained) || s["taskRowVersion"]!=task["rowVersion"] || s["chat"]["projectId"]!=context["projectId"] || s["chat"]["experience"]!="task" ||
                s["chat"]["automationPaused"]!=context["automationPaused"] || s["chat"]["status"]!=context["status"] || s["lane"]["id"]!=context["executionLaneId"] ||
                context.get("managedInputRevision").is_some_and(|r|*r!=s["chat"]["managedInputRevision"]) || s["dispatch"]!=dispatch_identity(&task["dispatch"]) {return stale();}
            Ok(json!({"target":target,"snapshot":s}))
        })).await
    }
    pub async fn validate_goal_observation(
        &self,
        owner: &str,
        chat: &str,
        fence: &Value,
    ) -> Result<()> {
        let (owner, chat, fence) = (owner.to_owned(), chat.to_owned(), fence.clone());
        self.database
            .transaction(|tx| Box::pin(async move { assert_in(tx, &owner, &chat, &fence).await }))
            .await
    }
}
