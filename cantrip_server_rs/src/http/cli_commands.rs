//! Full legacy CLI dispatcher. Public context remains independent of MCP bindings.
use crate::{
    auth::service::AuthService,
    cli::{self, Error, concat, optional, require_chat_lane, required, selectors},
    projects::{repository::ProjectRepository, targets::TargetRepository},
    settings::parse_response as parse,
    wire::{JsString, Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

fn mutation(mut result: Value, context: &Value) -> Result<Value> {
    let suffix = concat(&[
        json!(" CLI context: project "),
        context["projectId"].clone(),
        json!(", worktree "),
        context["worktreeId"].clone(),
        json!("."),
    ]);
    let summary = result["summary"]
        .as_js_string()
        .context("CLI mutation summary")?;
    // String.slice's negative end is relative to the original string length.
    let end = 2000_i64 - suffix.len() as i64;
    let end = if end < 0 {
        (summary.len() as i64 + end).max(0) as usize
    } else {
        (end as usize).min(summary.len())
    };
    let mut units = summary.units()[..end].to_vec();
    units.extend(suffix.units());
    result["summary"] = Value::String(JsString::new(units));
    result["mutated"] = json!(true);
    parse("cantripCliCommandResultSchema", Some(&result))
}
async fn worktree(
    service: &AuthService,
    owner: &str,
    context: &Value,
    selector: Option<&Value>,
) -> Result<Value> {
    let trees = TargetRepository::for_mcp(service.repository.database.clone())
        .worktrees(owner, context["projectId"].as_str().context("CLI project")?)
        .await?;
    selectors::worktree(context, &trees, selector.and_then(Value::as_js_string))
}
async fn target(
    service: &AuthService,
    owner: &str,
    context: &Value,
    kind: Option<&str>,
    selector: Option<&Value>,
) -> Result<Value> {
    let project = context["projectId"].as_str().context("CLI project")?;
    let selected = TargetRepository::for_mcp(service.repository.database.clone())
        .select_cli(
            owner,
            project,
            kind,
            selector.and_then(Value::as_js_string),
            context,
            Some(&|id| service.workers.bridge.is_connected(id)),
        )
        .await?
        .ok_or_else(|| Error::new(404, "not-found", "The current project no longer exists."))?;
    match selected["outcome"].as_str() {
        Some("selected") => Ok(selected["target"].clone()),
        Some("ambiguous") => Err(selectors::ambiguous(
            kind.unwrap_or("execution"),
            selected["matches"]
                .as_array()
                .context("CLI target matches")?,
        )
        .into()),
        Some("not-found") => Err(Error::new(
            404,
            "not-found",
            concat(&[
                json!("Target "),
                selector.cloned().unwrap_or(Value::Null),
                json!(format!(
                    " was not found. Run `cantrip target list{}` to see available targets.",
                    kind.map(|k| format!(" --kind {k}")).unwrap_or_default()
                )),
            ]),
        )
        .into()),
        _ => Err(Error::new(
            503,
            "unavailable",
            format!(
                "No available {} target was found.",
                kind.unwrap_or("execution")
            ),
        )
        .into()),
    }
}
async fn agent(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    let mut context = context.clone();
    context["contextKind"] = json!("project");
    if operation.starts_with("policy.") {
        super::agent_metadata::execute(service, owner, &context, operation, arguments).await
    } else if operation.starts_with("worktree.") {
        super::agent_worktrees::execute(service, owner, &context, operation, arguments).await
    } else if operation.starts_with("target.") {
        super::agent_targets::execute(service, owner, &context, operation, arguments).await
    } else {
        super::agent_surfaces::execute(service, owner, &context, operation, arguments).await
    }
}
pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    call: &Value,
) -> Result<Value> {
    let command = call["command"].as_str().context("CLI command")?;
    let reader = Arc::new(cli::repository::Repository {
        database: service.repository.database.clone(),
        owner: owner.to_owned(),
    });
    let context = cli::context::resolve(reader, call, command == "status").await?;
    if command == "status" {
        let worker_id = context
            .as_ref()
            .map(|context| context["workerId"].clone())
            .unwrap_or_else(|| call["workerId"].clone());
        let worker = TargetRepository::for_mcp(service.repository.database.clone())
            .worker(owner, &worker_id)
            .await?
            .ok_or_else(|| {
                Error::new(
                    404,
                    "not-found",
                    "The connected worker is no longer registered.",
                )
            })?;
        let mut result = json!({"summary":concat(&[json!("Connected through "),worker["name"].clone(),json!(if context.is_some() {"; project context is ready."} else {"; no project context was inferred."})]),"data":json!({"worker":json!({"id":worker_id,"name":worker["name"],"online":worker_id.as_str().is_some_and(|id|service.workers.bridge.is_connected(id))}),"context":context})});
        if let Some(context) = &context {
            result["worktreeId"] = context["worktreeId"].clone();
        }
        return parse("cantripCliCommandResultSchema", Some(&result));
    }
    let context = context.ok_or_else(|| {
        Error::new(
            400,
            "context-not-found",
            "Cantrip project context is required.",
        )
    })?;
    let project = context["projectId"].as_str().context("CLI project")?;
    if command.starts_with("worktree.")
        && ProjectRepository::new(service.repository.database.clone())?
            .get(owner, project)
            .await?
            .as_ref()
            .is_none_or(|p| p["capabilities"]["worktrees"] != true)
    {
        return Err(Error::new(
            409,
            "unsupported-capability",
            "This worker-managed folder does not support Cantrip worktree commands.",
        )
        .into());
    }
    let arguments = &call["arguments"];
    let selector = optional(arguments, "target")?;
    if command.starts_with("run.") {
        return super::cli_runs::execute(service, owner, &context, call).await;
    }
    let result = match command {
        "policy.list" | "worktree.list" => {
            agent(
                service,
                owner,
                &context,
                command,
                &Value::Object(Default::default()),
            )
            .await?
        }
        "policy.read" => {
            agent(
                service,
                owner,
                &context,
                command,
                &json!({"policyId":required(arguments,"policyId")?}),
            )
            .await?
        }
        "worktree.create" => {
            let name = required(arguments, "name")?;
            let intent = required(arguments, "intent")?;
            let mut branch = optional(arguments, "branch")?;
            if intent == "newBranch" && branch.is_none() {
                let trees = TargetRepository::for_mcp(service.repository.database.clone())
                    .worktrees(owner, project)
                    .await?;
                branch = Some(Value::String(selectors::derived_branch(
                    name.as_js_string().unwrap(),
                    &trees,
                )?));
            }
            let switch = arguments["switch"] == true;
            if switch {
                require_chat_lane(&context)?;
            }
            let mut input = json!({"name":name,"intent":intent,"branch":branch,"baseRevision":optional(arguments,"baseRevision")?});
            if switch {
                input["purpose"] = Value::String(concat(&[
                    json!("Continue in "),
                    name,
                    json!(" from the Cantrip CLI"),
                ]));
            }
            mutation(
                agent(
                    service,
                    owner,
                    &context,
                    if switch { "worktree.acquire" } else { command },
                    &input,
                )
                .await?,
                &context,
            )?
        }
        "worktree.switch" => {
            require_chat_lane(&context)?;
            let selected = worktree(
                service,
                owner,
                &context,
                Some(&required(arguments, "worktree")?),
            )
            .await?;
            mutation(agent(service,owner,&context,command,&json!({"worktreeId":selected["id"],"purpose":concat(&[json!("Switch to "),selected["name"].clone(),json!(" from the Cantrip CLI")])})).await?,&context)?
        }
        "worktree.status" | "worktree.remove" => {
            let selector = if command == "worktree.remove" {
                Some(required(arguments, "worktree")?)
            } else {
                optional(arguments, "worktree")?
            };
            let selected = worktree(service, owner, &context, selector.as_ref()).await?;
            let result = agent(
                service,
                owner,
                &context,
                command,
                &json!({"worktreeId":selected["id"]}),
            )
            .await?;
            if command == "worktree.remove" {
                mutation(result, &context)?
            } else {
                result
            }
        }
        "worktree.release" => {
            require_chat_lane(&context)?;
            mutation(
                agent(
                    service,
                    owner,
                    &context,
                    command,
                    &json!({"purpose":"Release from the Cantrip CLI"}),
                )
                .await?,
                &context,
            )?
        }
        "target.list" => {
            let mut input = Value::Object(Default::default());
            if let Some(kind) = optional(arguments, "kind")? {
                input["kind"] = kind;
            }
            agent(service, owner, &context, command, &input).await?
        }
        "target.show"
        | "target.resolve-browser"
        | "target.resolve-explorer"
        | "target.resolve-terminal" => {
            let root_kind = if context["rootKind"] == "folder-root" {
                "worker"
            } else {
                "worktree"
            };
            let kind = match command {
                "target.show" => {
                    if selector.is_some() {
                        None
                    } else {
                        Some(root_kind)
                    }
                }
                "target.resolve-browser" => Some("browser"),
                "target.resolve-explorer" => Some("explorer"),
                _ => Some("terminal"),
            };
            let selected = match target(service, owner, &context, kind, selector.as_ref()).await {
                Err(error)
                    if command == "target.resolve-browser"
                        && selector.is_none()
                        && error
                            .downcast_ref::<Error>()
                            .is_some_and(|error| error.code == "unavailable") =>
                {
                    target(service, owner, &context, Some(root_kind), None).await?
                }
                other => other?,
            };
            agent(
                service,
                owner,
                &context,
                "target.inspect",
                &json!({"target":selected}),
            )
            .await?
        }
        "browser.create" => {
            let input = parse("encryptedBrowserCreateSchema", Some(arguments))?;
            let browser = crate::browsers::Repository::new(service.repository.database.clone())
                .create(
                    owner,
                    project,
                    &input,
                    Some(&|id| service.workers.bridge.is_connected(id)),
                )
                .await?
                .context("Browser project was not found.")?;
            for resource in ["browser", "project-tab-layout"] {
                if let Err(failure)=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":resource,"action":"invalidated","entityId":browser["id"],"revision":Value::Null,"payload":Value::Null})) {
                    use crate::operations::logging::{self,LogCall};
                    (logging::server_logger())(LogCall::event("error","Could not publish application live invalidation",json!({"err":json!({"message":failure.to_string()}),"resource":resource})));
                }
            }
            let selected = parse(
                "executionTargetSchema",
                Some(
                    &json!({"kind":"surface","projectId":project,"surfaceKind":"browser","surfaceId":browser["id"]}),
                ),
            )?;
            service.live.hub.request_control(owner,json!({"kind":"focus-surface","projectId":project,"surfaceKind":"browser","surfaceId":browser["id"]}),5000).await?;
            mutation(
                parse(
                    "cantripCliCommandResultSchema",
                    Some(
                        &json!({"summary":"Opened a new Browser tab.","target":selected,"worktreeId":context["worktreeId"],"mutated":true,"data":browser}),
                    ),
                )?,
                &context,
            )?
        }
        "explorer.list" | "explorer.read" | "explorer.write" | "terminal.read"
        | "terminal.send" | "terminal.restart" | "browser.services" | "browser.open" => {
            let kind = command.split('.').next().unwrap();
            let selected = target(service, owner, &context, Some(kind), selector.as_ref()).await?;
            let mut input = if matches!(
                command,
                "explorer.list"
                    | "explorer.read"
                    | "explorer.write"
                    | "terminal.read"
                    | "terminal.send"
            ) {
                arguments.clone()
            } else {
                Value::Object(Default::default())
            };
            input["target"] = selected;
            if command == "browser.open" {
                for key in ["expectedStateRevision", "stateProtection"] {
                    if let Some(value) = arguments.get(key) {
                        input[key] = value.clone();
                    }
                }
            }
            let result = agent(service, owner, &context, command, &input).await?;
            if cli::is_mutation(command) {
                mutation(result, &context)?
            } else {
                result
            }
        }
        _ => unreachable!("validated CLI command"),
    };
    Ok(result)
}
