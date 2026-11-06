//! CLI Run commands share domain services without imposing an MCP worker binding.
use crate::{
    auth::service::AuthService,
    cli::{Error, concat, optional, required},
    run_configurations::{Repository, definitions, lifecycle, output},
    settings::parse_response as parse,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

fn copy(input: &mut Value, arguments: &Value, key: &str) {
    if let Some(value) = arguments.get(key) {
        input[key] = value.clone();
    }
}
fn message(parts: &[Value]) -> Value {
    Value::String(concat(parts))
}
pub(super) async fn execute(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    call: &Value,
) -> Result<Value> {
    let project = context["projectId"].as_str().context("CLI Run project")?;
    let action = call["command"]
        .as_str()
        .context("CLI Run command")?
        .strip_prefix("run.")
        .unwrap();
    let arguments = &call["arguments"];
    let target = json!({"kind":"project","projectId":project});
    let repository = Repository::new(service.repository.database.clone());
    if crate::cli::is_mutation(call["command"].as_str().unwrap())
        && context["permissionProfileId"] == ":read-only"
    {
        return Err(Error::new(
            409,
            "conflict",
            "Run configuration mutations are unavailable in a read-only execution context.",
        )
        .into());
    }
    let mut input = json!({"operationId":call["requestId"],"projectId":project});
    let result = match action {
        "list" | "show" | "detect" => {
            if action == "show" {
                input["configurationId"] = required(arguments, "configurationId")?;
            }
            if action == "detect" {
                let mut query = json!({"operationId":call["requestId"]});
                if let Some(provider) = arguments.get("provider").filter(|v| !v.is_null()) {
                    query["provider"] = provider.clone();
                }
                let query = parse("runConfigurationDetectQuerySchema", Some(&query))?;
                copy(&mut input, &query, "provider");
            }
            let (mut data, source) = definitions::read_with_source(
                service,
                owner,
                if action == "show" { "get" } else { action },
                &input,
            )
            .await?;
            let summary = match action {
                "list" => {
                    let runtimes = repository.list(owner, project, None, None, 256).await?;
                    let active = runtimes
                        .iter()
                        .filter(|r| {
                            matches!(
                                r["state"].as_str(),
                                Some("starting" | "running" | "restarting" | "stopping")
                            )
                        })
                        .map(|r| &r["configurationId"])
                        .collect::<Vec<_>>();
                    let mut entries = data["inventory"]["entries"]
                        .as_array()
                        .context("Run inventory entries")?
                        .clone();
                    entries.sort_by_key(|e| !active.contains(&&e["id"]));
                    let count = entries.len();
                    data["inventory"]["entries"] = Value::Array(entries);
                    data["runtimes"] = Value::Array(runtimes);
                    json!(format!(
                        "Found {count} project Run configuration{}.",
                        if count == 1 { "" } else { "s" }
                    ))
                }
                "show" => {
                    if data["result"]["found"] != true {
                        return Err(Error::new(
                            404,
                            "not-found",
                            concat(&[
                                json!("Run configuration "),
                                input["configurationId"].clone(),
                                json!(" was not found."),
                            ]),
                        )
                        .into());
                    }
                    message(&[
                        json!("Read Run configuration "),
                        input["configurationId"].clone(),
                        json!("."),
                    ])
                }
                _ => {
                    let count = data["candidates"]
                        .as_array()
                        .context("Run detection candidates")?
                        .len();
                    json!(format!(
                        "Detected {count} Run configuration candidate{}.",
                        if count == 1 { "" } else { "s" }
                    ))
                }
            };
            json!({"summary":summary,"target":target,"worktreeId":source["worktreeId"],"data":data})
        }
        "create" | "update" | "delete" => {
            if action == "delete" {
                input["configurationId"] = required(arguments, "configurationId")?;
                input["expectedRevision"] = required(arguments, "revision")?;
            } else {
                let revision = if action == "create" {
                    Value::Null
                } else {
                    required(arguments, "revision")?
                };
                let mut request =
                    json!({"operationId":call["requestId"],"expectedRevision":revision});
                copy(&mut request, arguments, "document");
                let request = parse("runConfigurationApiWriteRequestSchema", Some(&request))?;
                if action == "update"
                    && request["document"]["id"] != required(arguments, "configurationId")?
                {
                    return Err(Error::new(
                        400,
                        "invalid",
                        "The requested and document configuration IDs must match.",
                    )
                    .into());
                }
                input["expectedRevision"] = revision;
                input["document"] = request["document"].clone();
            }
            let (data, source) = definitions::mutate_with_source(
                service.clone(),
                owner.to_owned(),
                if action == "delete" {
                    "delete"
                } else {
                    "write"
                },
                input.clone(),
            )
            .await?;
            let outcome = &data["result"]["outcome"];
            let summary = if action == "delete" {
                if outcome != "deleted" {
                    let missing = outcome == "not-found";
                    return Err(Error::new(
                        if missing { 404 } else { 409 },
                        if missing { "not-found" } else { "conflict" },
                        concat(&[
                            json!("Run configuration delete was rejected: "),
                            outcome.clone(),
                            json!("."),
                        ]),
                    )
                    .into());
                }
                message(&[
                    json!("Deleted Run configuration "),
                    input["configurationId"].clone(),
                    json!("."),
                ])
            } else {
                if data["result"].get("entry").is_none() {
                    return Err(Error::new(
                        409,
                        "conflict",
                        concat(&[
                            json!("Run configuration write was rejected: "),
                            outcome.clone(),
                            json!("."),
                        ]),
                    )
                    .into());
                }
                message(&[
                    json!(if outcome == "created" {
                        "Created Run configuration "
                    } else {
                        "Updated Run configuration "
                    }),
                    data["result"]["entry"]["id"].clone(),
                    json!("."),
                ])
            };
            json!({"summary":summary,"target":target,"worktreeId":source["worktreeId"],"mutated":action=="delete" || outcome!="unchanged","data":data})
        }
        "start" | "restart" | "stop" => {
            input["configurationId"] = required(arguments, "configurationId")?;
            input["targetWorktreeId"] = optional(arguments, "worktreeId")?.unwrap_or(Value::Null);
            input["operation"] = json!(action);
            let input = parse(
                "runConfigurationRuntimeLifecycleRequestSchema",
                Some(&input),
            )?;
            let data = lifecycle::operate(service.clone(), owner.to_owned(), input).await?;
            json!({"summary":message(&[data["operation"]["operation"].clone(),json!(" "),data["operation"]["outcome"].clone(),json!(" for Run configuration "),data["operation"]["configurationId"].clone(),json!(".")]),"target":target,"worktreeId":data["operation"]["worktreeId"],"mutated":data["operation"]["outcome"]=="accepted","data":data})
        }
        "status" => {
            input["configurationId"] =
                optional(arguments, "configurationId")?.unwrap_or(Value::Null);
            input["targetWorktreeId"] = optional(arguments, "worktreeId")?.unwrap_or(Value::Null);
            input["limit"] = json!(256);
            let input = parse("runConfigurationRuntimeStatusQuerySchema", Some(&input))?;
            let configuration = input["configurationId"].as_js_string().map(|s| s.lossy());
            let worktree = input["targetWorktreeId"].as_js_string().map(|s| s.lossy());
            let runtimes = repository
                .list(
                    owner,
                    project,
                    configuration.as_deref(),
                    worktree.as_deref(),
                    256,
                )
                .await?;
            let count = runtimes.len();
            let data = parse(
                "runConfigurationRuntimeStatusResultSchema",
                Some(
                    &json!({"operationId":input["operationId"],"projectId":project,"runtimes":runtimes}),
                ),
            )?;
            json!({"summary":format!("Found {count} Run configuration runtime{}.",if count==1 {""} else {"s"}),"target":target,"worktreeId":optional(arguments,"worktreeId")?.unwrap_or(Value::Null),"data":data})
        }
        "logs" => {
            let worktree = optional(arguments, "worktreeId")?.unwrap_or(Value::Null);
            let selected = super::agent_runs::target(service, owner, project, &worktree).await?;
            input["configurationId"] = required(arguments, "configurationId")?;
            input["worktreeId"] = selected["worktree"]["id"].clone();
            copy(&mut input, arguments, "tail");
            let input = parse("runConfigurationRuntimeOutputQuerySchema", Some(&input))?;
            let configuration = input["configurationId"]
                .as_js_string()
                .context("Run output configuration")?
                .lossy();
            let runtime = repository
                .get(
                    owner,
                    project,
                    &configuration,
                    input["worktreeId"]
                        .as_str()
                        .context("Run output worktree")?,
                )
                .await?;
            let data = output::read(service, runtime.as_ref(), &input, None).await?;
            json!({"summary":message(&[json!("Read Run configuration "),data["configurationId"].clone(),json!(" output.")]),"target":target,"worktreeId":data["worktreeId"],"data":data})
        }
        "secret-set" => {
            let mut request = json!({"operationId":call["requestId"]});
            copy(&mut request, arguments, "reference");
            copy(&mut request, arguments, "protectedValue");
            let request = parse("runConfigurationSecretSetRequestSchema", Some(&request))?;
            let data = parse(
                "runConfigurationSecretSetResultSchema",
                Some(&repository.set_secret(owner, project, &request).await?),
            )?;
            definitions::invalidate(&service.live, owner, project, Value::Null);
            json!({"summary":message(&[json!("Stored Run configuration secret "),data["secret"]["reference"].clone(),json!(".")]),"target":target,"worktreeId":Value::Null,"mutated":data["replayed"]==false,"data":data})
        }
        _ => unreachable!("validated CLI Run command"),
    };
    parse("cantripCliCommandResultSchema", Some(&result))
}
