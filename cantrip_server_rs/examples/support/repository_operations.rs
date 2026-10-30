use super::*;

// Keep unrelated repository operations out of the caller's async poll frame.
pub fn run<'a>(
    database: &'a Arc<Database>,
    request: &'a Value,
    repository: &'a ProjectRepository,
    folders: &'a cantrip_server::projects::folders::FolderRepository,
    placement: &'a cantrip_server::projects::placement::PlacementRepository,
    live: &'a cantrip_server::live::repository::LiveRepository,
    chats: &'a cantrip_server::chats::Repository,
) -> futures::future::BoxFuture<'a, Result<Value>> {
    Box::pin(async move {
        if request["op"] == "sql" {
            database
                .execute(request["sql"].as_str().context("Fixture SQL")?)
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
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "surface-reset" {
            cantrip_server::remote_surfaces::Repository::new(database.clone())
                .reset_transient()
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "surface-ensure-browsers" {
            cantrip_server::remote_surfaces::Repository::new(database.clone())
                .ensure_browsers(request["owner"].as_str().context("Surface owner")?)
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "chat-context" {
            let chat = request["chat"]
                .as_js_string()
                .context("Chat identity")?
                .lossy();
            Ok(chats
                .execution_context(request["owner"].as_str().context("Chat owner")?, &chat)
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
                    .await?,
                )),
                "terminal-context" => {
                    Ok(repo.context(owner, &terminal).await?.unwrap_or(Value::Null))
                }
                "terminal-update" => Ok(repo
                    .update(owner, &terminal, &request["input"])
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-worktree" => Ok(repo
                    .update_worktree(owner, &terminal, &request["input"])
                    .await?
                    .unwrap_or(Value::Null)),
                "terminal-delete" => {
                    Ok(repo.delete(owner, &terminal).await?.unwrap_or(Value::Null))
                }
                "terminal-service" => Ok(repo
                    .configure_service(owner, &terminal, &request["input"])
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
                        .await?
                        .unwrap_or(Value::Null))
                }
                _ => anyhow::bail!("Unknown terminal operation"),
            }
        } else if request["op"]
            .as_str()
            .is_some_and(|s| s.starts_with("folder-"))
        {
            folder_operation(folders, request).boxed().await
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
                            transaction.execute(&statement).await?;
                        }
                        Ok(())
                    })
                })
                .await?;
            Ok(Value::Null)
        } else if request["op"] == "target-resolve" {
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
                .await
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
                        .await?;
                        Ok(Value::Null)
                    })
                })
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
                .await
        } else if request["op"] == "scope" {
            Ok(Value::Bool(
                live.authorize(
                    request["owner"].as_str().context("Scope owner")?,
                    &request["scope"],
                )
                .await?,
            ))
        } else if request["op"] == "session-active" {
            Ok(Value::Bool(
                live.session_active(
                    request["session"].as_str().context("Session identity")?,
                    request["owner"].as_str().context("Session owner")?,
                )
                .await?,
            ))
        } else {
            Ok(Value::Array(
                repository
                    .list(request["owner"].as_str().context("Fixture owner")?)
                    .await?,
            ))
        }
    })
}
