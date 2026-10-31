use super::*;

// Keep child futures on the heap: this dispatcher combines many independent
// repositories and must also run on platforms with a 1 MiB thread stack.
pub fn run<'a>(
    database: &'a Arc<Database>,
    request: &'a Value,
    repository: &'a ProjectRepository,
    folders: &'a cantrip_server::projects::folders::FolderRepository,
    placement: &'a cantrip_server::projects::placement::PlacementRepository,
    live: &'a cantrip_server::live::repository::LiveRepository,
    chats: &'a cantrip_server::chats::Repository,
) -> futures::future::BoxFuture<'a, Result<Value>> {
    if request["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("run-runtime-") || op.starts_with("run-secret-"))
    {
        return super::run_configurations::run(database, request);
    }
    // The umbrella poll frame retained 373760 bytes on Windows.
    // Target resolution must poll only its own selected future.
    if request["op"] == "target-resolve" {
        return Box::pin(async move {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|workers| workers.iter().any(|w| w == worker))
            };
            cantrip_server::projects::targets::TargetRepository::new(database.clone())
                .resolve(
                    request["owner"].as_str().context("Fixture owner")?,
                    request["project"].as_str().context("Fixture project")?,
                    &request["target"],
                    request["connected"]
                        .as_array()
                        .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                    request["allowUnavailable"].as_bool().unwrap_or(false),
                )
                .boxed()
                .await
        });
    }
    Box::pin(async move {
        if request["op"] == "worktree-coordinator" {
            super::worktree_coordinator::run(database.clone(), request)
                .boxed()
                .await
        } else if request["op"] == "sql" {
            database
                .execute(request["sql"].as_str().context("Fixture SQL")?)
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "query-json" {
            let query = request["sql"]
                .as_str()
                .context("Fixture query")?
                .trim_end_matches(';');
            let rows = database
                .query(
                    &format!("SELECT result::text FROM ({query}) observation"),
                    &[],
                )
                .boxed()
                .await?;
            rows.first()
                .map(|row| Ok(serde_json::from_str::<Value>(&row.get::<String>(0)?)?))
                .transpose()
                .map(|value| value.unwrap_or(Value::Null))
        } else if request["op"] == "surface-context" {
            Ok(
                cantrip_server::remote_surfaces::Repository::new(database.clone())
                    .context(
                        request["owner"].as_str().context("Surface owner")?,
                        &request["surface"]
                            .as_js_string()
                            .context("Surface ID")?
                            .lossy(),
                    )
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null),
            )
        } else if request["op"] == "surface-status" {
            let id = request["surface"]
                .as_js_string()
                .context("Surface ID")?
                .lossy();
            let status = request["status"]
                .as_js_string()
                .context("Surface status")?
                .lossy();
            let error = request["error"]
                .as_js_string()
                .map(|v| v.lossy().into_owned());
            cantrip_server::remote_surfaces::Repository::new(database.clone())
                .set_status(&id, &status, error.as_deref())
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "surface-reset" {
            cantrip_server::remote_surfaces::Repository::new(database.clone())
                .reset_transient()
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "surface-ensure-browsers" {
            cantrip_server::remote_surfaces::Repository::new(database.clone())
                .ensure_browsers(request["owner"].as_str().context("Surface owner")?)
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "chat-context" {
            let chat = request["chat"]
                .as_js_string()
                .context("Chat identity")?
                .lossy();
            Ok(chats
                .execution_context(request["owner"].as_str().context("Chat owner")?, &chat)
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        } else if request["op"] == "mcp-effective" {
            Ok(Value::Array(
                chats
                    .effective_mcp_servers(
                        request["owner"].as_str().context("MCP owner")?,
                        request.get("project").and_then(Value::as_str),
                        request["worker"].as_str().context("MCP worker")?,
                        request
                            .get("audience")
                            .and_then(Value::as_str)
                            .unwrap_or("ide"),
                    )
                    .boxed()
                    .await?,
            ))
        } else if request["op"] == "terminal-services" {
            let maintenance =
                cantrip_server::workers::maintenance::Repository::new(database.clone());
            Ok(Value::Array(
                maintenance
                    .list(
                        request["worker"].as_str().context("Service worker")?,
                        request["server"].as_str().context("Service server")?,
                    )
                    .boxed()
                    .await?,
            ))
        } else if request["op"] == "terminal-status" {
            let maintenance =
                cantrip_server::workers::maintenance::Repository::new(database.clone());
            maintenance
                .set_status(
                    request["terminal"].as_str().context("Terminal identity")?,
                    request["status"].as_str().context("Terminal status")?,
                )
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"]
            .as_str()
            .is_some_and(|op| op.starts_with("terminal-"))
        {
            let repo = cantrip_server::terminals::Repository::new(database.clone());
            let owner = request["owner"].as_str().context("Terminal owner")?;
            let terminal = request["terminal"]
                .as_js_string()
                .map(|s| s.lossy().into_owned())
                .unwrap_or_default();
            match request["op"].as_str().unwrap() {
                "terminal-list" => Ok(Value::Array(
                    repo.list(
                        owner,
                        request["project"].as_str().context("Terminal project")?,
                    )
                    .boxed()
                    .await?,
                )),
                "terminal-context" => Ok(repo
                    .context(owner, &terminal)
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-update" => Ok(repo
                    .update(owner, &terminal, &request["input"])
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-worktree" => Ok(repo
                    .update_worktree(owner, &terminal, &request["input"])
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-delete" => Ok(repo
                    .delete(owner, &terminal)
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-service" => Ok(repo
                    .configure_service(owner, &terminal, &request["input"])
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-create" => {
                    let connected = |id: &str| {
                        request["connected"]
                            .as_array()
                            .is_some_and(|v| v.iter().any(|v| v == id))
                    };
                    Ok(repo
                        .create(
                            owner,
                            request["project"].as_str().context("Terminal project")?,
                            &request["input"],
                            Some(&connected),
                        )
                        .boxed()
                        .await?
                        .unwrap_or(Value::Null))
                }
                _ => anyhow::bail!("Unknown terminal operation"),
            }
        } else if request["op"]
            .as_str()
            .is_some_and(|s| s.starts_with("folder-"))
        {
            folder_operation(folders, request).boxed().boxed().await
        } else if request["op"] == "transaction" {
            let statements = request["statements"]
                .as_array()
                .context("Fixture transaction statements")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .context("Fixture statement")
                        .map(str::to_owned)
                })
                .collect::<Result<Vec<_>>>()?;
            database
                .transaction(|transaction| {
                    Box::pin(async move {
                        for statement in statements {
                            transaction.execute(&statement).boxed().await?;
                        }
                        Ok(())
                    })
                })
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if matches!(
            request["op"].as_str(),
            Some(
                "worktree-rollback"
                    | "worktree-set-lifecycle"
                    | "worktree-observe"
                    | "worktree-removal-blockers"
            )
        ) {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            let owner = request["owner"].as_str().context("Worktree owner")?;
            let project = request["project"].as_str().context("Worktree project")?;
            if request["op"] == "worktree-rollback" {
                return Ok(Value::Bool(
                    repo.rollback_worktree_creation(
                        owner,
                        project,
                        request["worker"].as_str().context("Worktree worker")?,
                        &request["created"],
                    )
                    .boxed()
                    .await?,
                ));
            }
            let worktree = request["worktree"].as_str().context("Worktree id")?;
            Ok(match request["op"].as_str() {
                Some("worktree-set-lifecycle") => {
                    repo.set_worktree_lifecycle(
                        owner,
                        project,
                        worktree,
                        request["state"].as_str().context("Worktree state")?,
                    )
                    .boxed()
                    .await?
                }
                Some("worktree-observe") => {
                    repo.observe_worktree(owner, project, worktree, &request["observed"])
                        .boxed()
                        .await?
                }
                _ => {
                    repo.worktree_removal_blockers(owner, project, worktree)
                        .boxed()
                        .await?
                }
            }
            .unwrap_or(Value::Null))
        } else if request["op"] == "inventory-reconcile" {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            Ok(repo
                .reconcile_worktrees(
                    request["owner"].as_str().context("Inventory owner")?,
                    request["project"].as_str().context("Inventory project")?,
                    request["worker"].as_str().context("Inventory worker")?,
                    &request["inventory"],
                    request.get("created"),
                )
                .boxed()
                .await?
                .map(Value::Array)
                .unwrap_or(Value::Null))
        } else if request["op"] == "observation-context" {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            Ok(repo
                .observation_context(
                    request["owner"].as_str().context("Observation owner")?,
                    request["worker"].as_str().context("Observation worker")?,
                    request["source"].as_str().context("Observation source")?,
                    request["worktreePath"]
                        .as_str()
                        .context("Observation worktree path")?,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        } else if request["op"] == "observation-operation" {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            Ok(repo
                .active_observation_operation(
                    request["owner"].as_str().context("Observation owner")?,
                    request["project"].as_str().context("Observation project")?,
                    request["worktree"]
                        .as_str()
                        .context("Observation worktree")?,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        } else if request["op"] == "observation-source" {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            let connected = request["connected"]
                .as_array()
                .context("Connected workers")?;
            Ok(repo
                .observation_source(
                    request["owner"].as_str().context("Observation owner")?,
                    request["project"].as_str().context("Observation project")?,
                    &|worker| connected.iter().any(|value| value == worker),
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        } else if request["op"] == "observation-targets" || request["op"] == "observation-paths" {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            let owner = request["owner"].as_str().context("Observation owner")?;
            let worker = request["worker"].as_str().context("Observation worker")?;
            if request["op"] == "observation-targets" {
                Ok(Value::Array(
                    repo.observation_targets(
                        owner,
                        worker,
                        request["gitOnly"] == true,
                        request.get("limit").and_then(Value::as_i64).unwrap_or(128),
                    )
                    .boxed()
                    .await?,
                ))
            } else {
                Ok(Value::from_serialize(
                    &repo
                        .reconcile_observation_paths(
                            owner,
                            worker,
                            request["paths"].as_array().context("Observation paths")?,
                        )
                        .boxed()
                        .await?,
                ))
            }
        } else if request["op"] == "git-agent-usage" {
            use cantrip_server::settings::{
                repository::SettingsRepository, telemetry::repository_agent::RepositoryAgentUsage,
            };
            SettingsRepository::new(database.clone())
                .record_repository_agent_usage(RepositoryAgentUsage {
                    owner: request["owner"].as_str().context("Usage owner")?,
                    project: request["project"].as_str().context("Usage project")?,
                    worker: request["worker"].as_str().context("Usage worker")?,
                    operation: request["operation"].as_str().context("Usage operation")?,
                    runtime: &request["runtime"],
                    execution: &request["execution"],
                    server_version: "fixture-version",
                })
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "worktree-context" || request["op"] == "github-context" {
            let repo = cantrip_server::projects::targets::TargetRepository::new(database.clone());
            let owner = request["owner"].as_str().context("Context owner")?;
            let project = request["project"].as_str().context("Context project")?;
            Ok(if request["op"] == "worktree-context" {
                repo.worktree_context(
                    owner,
                    project,
                    request["worktree"].as_str().context("Context worktree")?,
                )
                .boxed()
                .await?
            } else {
                repo.github_context(
                    owner,
                    project,
                    request.get("worker").and_then(Value::as_str),
                )
                .boxed()
                .await?
            }
            .unwrap_or(Value::Null))
        } else if request["op"] == "catalog-repository" {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|workers| workers.iter().any(|w| w == worker))
            };
            Ok(
                cantrip_server::projects::targets::TargetRepository::new(database.clone())
                    .catalog(
                        request["owner"].as_str().context("Fixture owner")?,
                        request["project"].as_str().context("Fixture project")?,
                        request["connected"]
                            .as_array()
                            .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                    )
                    .boxed()
                    .await?
                    .unwrap_or(Value::Null),
            )
        } else if request["op"] == "chat-model" {
            let reasoning = request.get("reasoningEffort").map(|v| v.as_str());
            Ok(chats
                .select_model(
                    request["owner"].as_str().context("Chat owner")?,
                    request["chat"].as_str().context("Chat identity")?,
                    request["model"].as_str().context("Model identity")?,
                    reasoning,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null))
        } else if request["op"] == "chat-runtime" {
            let nullable = |key| request.get(key).and_then(Value::as_str).map(str::to_owned);
            chats
                .update_runtime(cantrip_server::chats::RuntimeUpdate {
                    chat: request["chat"].as_str().context("Runtime chat")?.into(),
                    worker: request["worker"].as_str().context("Runtime worker")?.into(),
                    worktree: nullable("worktree"),
                    thread: nullable("thread"),
                    route: request["route"].as_str().context("Runtime route")?.into(),
                    status: request
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("ready")
                        .into(),
                    provider_account: request
                        .get("providerAccountId")
                        .map(|v| v.as_str().map(str::to_owned)),
                    scratch_root: nullable("scratchRoot"),
                })
                .boxed()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "chat-guard" {
            let request = request.clone();
            database
                .transaction(move |tx| {
                    Box::pin(async move {
                        use cantrip_server::chats::guard::{self, Access};
                        let chat = request["chat"].as_str().context("Guard chat")?;
                        guard::lock_chat(
                            tx,
                            request["owner"].as_str().context("Guard owner")?,
                            chat,
                        )
                        .boxed()
                        .await?;
                        guard::assert_runtime_writable(
                            tx,
                            chat,
                            request.get("generation").and_then(Value::as_str),
                            request.get("epoch").and_then(Value::as_str),
                            if request["access"] == "attach" {
                                Access::Attach
                            } else {
                                Access::Write
                            },
                        )
                        .boxed()
                        .await?;
                        Ok(Value::Null)
                    })
                })
                .boxed()
                .await
        } else if request["op"] == "target-catalog" {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|workers| workers.iter().any(|w| w == worker))
            };
            cantrip_server::projects::targets::catalog::build(
                &request["input"],
                request["connected"]
                    .as_array()
                    .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
            )
        } else if request["op"] == "placement" {
            let connected = |worker: &str| {
                request["connected"]
                    .as_array()
                    .is_some_and(|workers| workers.iter().any(|w| w == worker))
            };
            placement
                .resolve(
                    request["owner"].as_str().context("Fixture owner")?,
                    request["project"].as_str().context("Fixture project")?,
                    request["surface"].as_str().context("Fixture surface")?,
                    request.get("target").filter(|v| !v.is_null()),
                    request["connected"]
                        .as_array()
                        .map(|_| &connected as &(dyn Fn(&str) -> bool + Send + Sync)),
                    request["allowOffline"].as_bool().unwrap_or(false),
                )
                .boxed()
                .await
        } else if request["op"] == "scope" {
            Ok(Value::Bool(
                live.authorize(
                    request["owner"].as_str().context("Scope owner")?,
                    &request["scope"],
                )
                .boxed()
                .await?,
            ))
        } else if request["op"] == "session-active" {
            Ok(Value::Bool(
                live.session_active(
                    request["session"].as_str().context("Session identity")?,
                    request["owner"].as_str().context("Session owner")?,
                )
                .boxed()
                .await?,
            ))
        } else {
            Ok(Value::Array(
                repository
                    .list(request["owner"].as_str().context("Fixture owner")?)
                    .boxed()
                    .await?,
            ))
        }
    })
}
