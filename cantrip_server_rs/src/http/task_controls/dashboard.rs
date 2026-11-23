use super::*;
use crate::{
    chats::{self, execution_lanes::LaneRepository, goals::Observation},
    projects::{repository::ProjectRepository, targets::TargetRepository},
    wire::{self, JsString, coercion::truthy},
    workers::command_bus::RequestTimeout,
};

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Task dashboard identity")?
        .lossy()
        .into_owned())
}
fn observed(worktree: Value, snapshot: Option<&Value>) -> Result<Value> {
    let length = if let Some(snapshot) = snapshot.filter(|s| !s.is_null()) {
        let files = wire::property(wire::property(Some(snapshot), "status")?, "files")?;
        match files {
            Some(Value::Array(items)) => Some(json!(items.len())),
            Some(Value::String(value)) => Some(json!(value.len())),
            _ => wire::property(files, "length")?.cloned(),
        }
    } else {
        None
    };
    Ok(
        json!({"dirty":truthy(length.as_ref()),"dirtyFileCount":length.filter(|v| !v.is_null()).unwrap_or(json!(0)),"worktree":worktree}),
    )
}

pub(super) async fn get(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
) -> Result<Response> {
    let database = service.repository.database.clone();
    let mut task = tasks::Repository::new(database.clone())
        .get(&owner, &chat)
        .await?;
    let context = chats::Repository::new(database.clone())
        .execution_context(&owner, &chat)
        .await?;
    let Some(context) =
        context.filter(|c| c["contextKind"] == "project" && c["experience"] == "task")
    else {
        return Ok(error(404, "Task not found."));
    };
    let Some(mut task) = task.take() else {
        return Ok(error(404, "Task not found."));
    };
    if !truthy(task.get("implementationStartedAt"))
        || (truthy(task.get("planGoalEnabled")) && !truthy(task.get("hasFinalPlan")))
    {
        return Ok(error(409, "Task implementation has not started."));
    }
    let project_id = text(&context["projectId"])?;
    let Some(project) = ProjectRepository::new(database.clone())?
        .get(&owner, &project_id)
        .await?
    else {
        return Ok(error(404, "Project not found."));
    };
    let folder = context["rootKind"] == "folder-root";
    let targets = TargetRepository::new(database.clone());
    let lanes = LaneRepository::new(database);
    let worker = text(&context["workerId"])?;
    let (lanes, worktrees, github) = tokio::try_join!(
        lanes.list_chat(&owner, &chat),
        async {
            if folder {
                Ok(Vec::new())
            } else {
                targets.worktrees(&owner, &project_id).await
            }
        },
        async {
            if folder {
                Ok(None)
            } else {
                targets
                    .github_context(&owner, &project_id, Some(&worker))
                    .await
            }
        },
    )?;
    let observations = futures::future::try_join_all(worktrees.into_iter().map(|worktree| {
        let (targets, owner, project_id) = (&targets, &owner, &project_id);
        async move {
            let snapshot = targets
                .status_snapshot(owner, project_id, &text(&worktree["id"])?)
                .await?;
            observed(worktree, snapshot.as_ref())
        }
    }))
    .await?;
    let active = observations
        .iter()
        .find(|o| o["worktree"]["id"] == context["worktreeId"]);
    if !folder && active.is_none() {
        return Ok(error(409, "Task worktree was not found."));
    }
    let (mut goal, mut goal_reason) = (Value::Null, Value::Null);
    if truthy(task.get("planGoalEnabled")) {
        if !truthy(context.get("threadId")) {
            goal_reason = json!("The Task Chat has no active Codex thread.");
        } else if !service.workers.bridge.is_connected(&worker) {
            goal_reason = json!("The project worker is offline.");
        } else {
            match service
                .execution
                .goals
                .read(&owner, &context, &task, Observation::default())
                .await
            {
                Ok(response) => {
                    goal = response["goal"].clone();
                    task = response["task"].clone();
                    if !truthy(Some(&goal)) {
                        goal_reason = json!(
                            "No Goal is attached to this session. Completion has not been confirmed. Use Retry / resume to restore the saved implementation Goal."
                        );
                    }
                }
                Err(_) => goal_reason = json!("Encrypted Goal status is unavailable."),
            }
        }
    }
    let (mut requests, mut request_reason) = (Vec::new(), Value::Null);
    if !folder {
        if let Some(github) = github {
            let github_worker = text(&github["workerId"])?;
            if !service.workers.bridge.is_connected(&github_worker) {
                request_reason = json!("The GitHub project worker is offline.");
            } else {
                let request = |state: &'static str| {
                    let service = service.clone();
                    let worker = github_worker.clone();
                    let repository = github["nameWithOwner"].clone();
                    let maintenance = service.worker_maintenance.clone();
                    maintenance.admit_owned(async move {
                        let filters = crate::settings::parse_response("githubIssueListFiltersSchema", Some(&Value::object([] as [(&str,Value);0])))?;
                        let reply = service.workers.commands.request_with_timeout(&worker, json!({"type":"github.pull-requests.list","repository":repository,"state":state,"cursor":Value::Null,"limit":100,"filters":filters}), RequestTimeout::Default, None).await?;
                        crate::settings::parse_response("githubPullRequestListSchema", reply.as_ref())
                    })
                };
                // Both commands own their admitted work: an early failure must
                // not cancel the other request that Promise.all already sent.
                let open = request("open");
                let closed = request("closed");
                let listed: Result<Vec<Value>> = async {
                    let (open,closed) = futures::try_join!(open,closed)?;
                    let mut all = open["pullRequests"].as_array().context("Open pull requests")?.clone();
                    all.extend_from_slice(closed["pullRequests"].as_array().context("Closed pull requests")?);
                    tasks::dashboard::associate_pull_requests(&json!({"activeWorktreeId":context["worktreeId"],"implementationStartedAt":task["implementationStartedAt"],"lanes":lanes,"pullRequests":all,"worktrees":observations}))
                }.await;
                match listed {
                    Ok(list) => requests = list,
                    Err(cause) => {
                        let message = crate::settings::operation_error_message(&cause);
                        request_reason = Value::String(JsString::new(
                            message.units().iter().take(2000).copied().collect(),
                        ));
                    }
                }
            }
        } else {
            request_reason = json!("This project is not linked to a GitHub repository.");
        }
    }
    let warnings = if folder {
        Vec::new()
    } else {
        tasks::dashboard::advisory_warnings(
            &json!({"activeWorktreeId":context["worktreeId"],"lanes":lanes,"pullRequests":requests,"state":task["state"],"worktrees":observations}),
        )?
    };
    let placement = if folder {
        let display = &project["source"]["displayPath"];
        json!({"kind":"folder","workerId":context["workerId"],"rootId":context["worktreeId"],"displayPath":if display.is_null() {&context["cwd"]} else {display}})
    } else {
        let active = active.context("Active Task worktree")?;
        json!({"kind":"git","workerId":context["workerId"],"worktreeId":active["worktree"]["id"],"worktreeName":active["worktree"]["name"],"branch":active["worktree"]["branch"],"isPrimary":active["worktree"]["isPrimary"],"dirty":active["dirty"],"dirtyFileCount":active["dirtyFileCount"]})
    };
    output(
        200,
        "taskImplementationOpaqueDashboardSchema",
        &json!({"task":task,"goal":goal,"goalUnavailableReason":goal_reason,"placement":placement,"pullRequests":requests,"pullRequestsUnavailableReason":request_reason,"warnings":warnings}),
    )
}
