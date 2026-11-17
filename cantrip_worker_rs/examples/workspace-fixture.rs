//! Local synthetic/disposable workspace differential driver, never shipped.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    encryption::{Identity, Service},
    filesystem::{folders, repository, source_path, storage},
    protected_content,
    repository_operations::RepositoryOperations,
    routing::Registry,
    workspace::{self, Limits, Scope},
};
use std::io::{self, BufRead};
use std::sync::Arc;
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    if cantrip_worker::git::editor::run(std::env::args_os())? {
        return Ok(());
    }
    let mut registry: Option<Registry> = None;
    let mut service: Option<Arc<Service>> = None;
    let mut operations = RepositoryOperations::default();
    let mut github: Option<(std::path::PathBuf, cantrip_worker::github::Client)> = None;
    let mut worktrees: Option<Arc<cantrip_worker::git::worktrees::Manager>> = None;
    let mut replay = protected_content::RepositoryOperationReplayGuard::default();
    let scope = Scope::default();
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{}", e.lossy()))?;
        let run = async {
            let opened = || {
                registry
                    .as_ref()
                    .ok_or_else(|| anyhow!("Fixture registry not open"))
            };
            let encryption = || {
                service
                    .as_ref()
                    .ok_or_else(|| anyhow!("Fixture encryption not open"))
            };
            match input["op"].as_str().unwrap_or("") {
                "github-search"=>cantrip_worker::github::search_query(input["repository"].as_js_string().unwrap(),input["kind"].as_str().unwrap(),input["state"].as_str().unwrap(),&input["filters"],input["now"].as_i64()).map(Value::String),
                "github"=> {
                    let directory=cantrip_worker::filesystem::paths::native(input["directory"].as_js_string().unwrap());
                    if github.as_ref().is_some_and(|(path,_)|*path!=directory) {
                        github.take().unwrap().1.drain().await?;
                    }
                    let (_,client)=github.get_or_insert_with(||(directory.clone(),cantrip_worker::github::Client::new(&directory)));
                    client.execute(&input["command"], &scope).await
                }
                "github-drain"=> {
                    if let Some((_,client))=&github {client.drain().await?;}
                    Ok(Value::Null)
                },
                "worktree-open"=>{
                    worktrees=Some(Arc::new(cantrip_worker::git::worktrees::Manager::new(
                        &cantrip_worker::filesystem::paths::native(input["directory"].as_js_string().unwrap())
                    )));
                    Ok(Value::Null)
                }
                "worktree"=>worktrees.as_ref().ok_or_else(||anyhow!("Worktree manager not open"))?
                    .execute(&input["command"],&scope,None).await,
                "worktree-remove-hook"=>{
                    let marker=cantrip_worker::filesystem::paths::native(input["marker"].as_js_string().unwrap());
                    let fail=input["fail"]==true;
                    let callback=move |path:std::path::PathBuf|->futures::future::BoxFuture<'static,Result<()>> {
                        let marker=marker.clone();
                        Box::pin(async move {
                            tokio::fs::write(marker,cantrip_worker::filesystem::paths::text(&path).lossy().as_bytes()).await?;
                            if fail {return Err(anyhow!("Owned removal hook failed."));}
                            Ok(())
                        })
                    };
                    worktrees.as_ref().ok_or_else(||anyhow!("Worktree manager not open"))?
                        .execute(&input["command"],&scope,Some(&callback)).await
                }
                "worktree-batch"=>{
                    let manager=worktrees.as_ref().ok_or_else(||anyhow!("Worktree manager not open"))?;
                    let results=futures::future::join_all(input["commands"].as_array().unwrap().iter().map(|command|manager.execute(command,&scope,None))).await;
                    Ok(json!(results.into_iter().map(|result|match result {
                        Ok(value)=>json!({"ok":true,"value":value}),
                        Err(error)=>json!({"ok":false,"error":error.to_string()}),
                    }).collect::<Vec<_>>()))
                }
                "worktree-authorize"=>worktrees.as_ref().ok_or_else(||anyhow!("Worktree manager not open"))?
                    .authorize_targets(
                        &cantrip_worker::filesystem::paths::native(input["sourcePath"].as_js_string().unwrap()),
                        &input["paths"].as_array().unwrap().iter().map(|path|cantrip_worker::filesystem::paths::native(path.as_js_string().unwrap())).collect::<Vec<_>>(),
                        &scope,
                    ).await.map(|value|json!(value)),
                "git-context" => {
                    operations = RepositoryOperations::new(
                        std::path::Path::new(input["directory"].as_str().unwrap()),
                        input["workerId"].as_js_string().unwrap(),
                    );
                    Ok(Value::Null)
                }
                "git" => cantrip_worker::git::execute(&input["command"], &scope).await,
                "git-preview-stop"=> {
                    let (stop,receiver)=tokio::sync::watch::channel(false);
                    let scope=Scope::with_stop(receiver);
                    let mut query=Box::pin(cantrip_worker::git::execute(&input["command"],&scope));
                    let ready=input["ready"].as_str().unwrap();
                    tokio::select! {
                        result=&mut query=>result,
                        observed=tokio::time::timeout(std::time::Duration::from_secs(10),async {
                            while !tokio::fs::try_exists(ready).await? {tokio::time::sleep(std::time::Duration::from_millis(5)).await;}
                            Ok::<_,std::io::Error>(())
                        })=>{
                            stop.send(true)?;
                            let result=query.await;
                            observed??;
                            result
                        }
                    }
                }
                "git-record" => cantrip_worker::git::stored::record(
                    &input["command"],
                    &input["workerId"],
                    &input["state"],
                    input.get("existing").filter(|v| !v.is_null()),
                    input.get("id"),
                    input["now"].as_str(),
                ),
                "git-put" => cantrip_worker::git::stored::put(
                    std::path::Path::new(input["directory"].as_str().unwrap()),
                    &input["command"],
                    &input["ownerId"],
                    &input["workerId"],
                    &input["record"],
                )
                .await
                .map(|_| Value::Null),
                "git-stored" => cantrip_worker::git::stored::read(
                    std::path::Path::new(input["directory"].as_str().unwrap()),
                    &input["command"],
                    &input["ownerId"],
                    &input["workerId"],
                )
                .await
                .map(|v| v.unwrap_or(Value::Null)),
                "folder-location" => Ok(storage::folder_location(
                    std::path::Path::new(input["directory"].as_str().unwrap()),
                    input["projectId"].as_js_string().unwrap(),
                    &input["storage"],
                )?
                .value()),
                "source-path" => Ok(json!(source_path::normalize(
                    input["path"].as_js_string().unwrap(),
                    input["windows"] == true
                )?)),
                "github-origin-name" => Ok(repository::github_repository_from_remote(
                    input["origin"].as_js_string().unwrap(),
                )
                .map(Value::String)
                .unwrap_or(Value::Null)),
                "folder-inspect" => {
                    repository::inspect_checkout(
                        std::path::Path::new(input["path"].as_str().unwrap()),
                        &scope,
                    )
                    .await
                }
                "folder-materialize" => {
                    folders::Manager::new(std::path::Path::new(
                        input["directory"].as_str().unwrap(),
                    ))
                    .materialize(&input["input"], &scope)
                    .await
                }
                "folder-resolve" => {
                    folders::Manager::new(std::path::Path::new(
                        input["directory"].as_str().unwrap(),
                    ))
                    .resolve(
                        input["projectId"].as_js_string().unwrap(),
                        &input["storage"],
                        &scope,
                    )
                    .await
                }
                "folder-delete" => {
                    folders::Manager::new(std::path::Path::new(
                        input["directory"].as_str().unwrap(),
                    ))
                    .delete(
                        input["projectId"].as_js_string().unwrap(),
                        &input["storage"],
                        &scope,
                    )
                    .await
                }
                "folder-command" => {
                    folders::Manager::new(std::path::Path::new(
                        input["directory"].as_str().unwrap(),
                    ))
                    .execute_routed(&input["command"], opened()?, &scope)
                    .await
                }
                "open-service" => {
                    if let Some(service) = service.take() {
                        service.close().await?;
                    }
                    let url = input["serverUrl"].as_str().unwrap();
                    let identity = Identity::open(
                        std::path::Path::new(input["directory"].as_str().unwrap()),
                        url,
                        input["workerId"].as_js_string().unwrap(),
                        false,
                    )?;
                    let created = Service::new(identity, url, cantrip_worker::http::client()?)?;
                    let registration = created.registration();
                    service = Some(created);
                    Ok(registration)
                }
                "accept" => Ok(encryption()?.accept_bootstrap(&input["payload"])?),
                "lock" => {
                    encryption()?.lock();
                    Ok(Value::Null)
                }
                "repository-command" => {
                    operations
                        .execute(&input["command"], encryption()?, opened()?, &scope)
                        .await
                }
                "worker-repository-protect" => protected_content::protect_repository_content(
                    encryption()?,
                    &input["context"],
                    &input["content"],
                    input["schema"].as_str().unwrap(),
                ),
                "worker-repository-open" => protected_content::open_repository_content(
                    encryption()?,
                    &input["context"],
                    &input["encrypted"],
                    input["schema"].as_str().unwrap(),
                    input["historical"] == true,
                ),
                "repository-aad" => {
                    cantrip_crypto::content::repository_operation_associated_data(&input["context"])
                }
                "repository-encrypt" => cantrip_crypto::content::encrypt_repository_operation(
                    &cantrip_crypto::decode(input["key"].as_str().unwrap())?,
                    &input["context"],
                    &cantrip_crypto::decode(input["bytes"].as_str().unwrap())?,
                ),
                "repository-decrypt" => Ok(json!(cantrip_crypto::encode(
                    &cantrip_crypto::content::decrypt_repository_operation(
                        &cantrip_crypto::decode(input["key"].as_str().unwrap())?,
                        &input["context"],
                        &input["encrypted"]
                    )?
                ))),
                "replay-reserve" => {
                    replay.reserve(&input["context"])?;
                    Ok(Value::Null)
                }
                "operation-access" => Ok(json!(
                    input["types"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(
                            |kind| cantrip_protocol::repository_operations::operation_access(
                                kind.as_str().unwrap()
                            )
                        )
                        .collect::<Vec<_>>()
                )),
                "schema-validate" => Ok(
                    match cantrip_protocol::parse(
                        input["schema"].as_str().unwrap(),
                        input.get("value"),
                    ) {
                        Ok(value) => json!({"ok":value}),
                        Err(cantrip_protocol::ValidationError::Invalid(issues)) => {
                            json!({"issues":issues})
                        }
                        Err(cantrip_protocol::ValidationError::Operation) => {
                            anyhow::bail!("Unsupported fixture schema")
                        }
                    },
                ),
                "attach" => {
                    workspace::attach_root(input["root"].as_js_string().unwrap(), opened()?, &scope)
                        .await
                }
                "open-registry" => {
                    registry = Some(Registry::new(std::path::Path::new(
                        input["directory"].as_str().unwrap(),
                    )));
                    Ok(Value::Null)
                }
                "resolve" => opened()?.resolve(&input["value"]).await,
                "metadata-protect" => opened()?.protect_metadata(&input["value"]).await,
                "metadata-resolve" => opened()?.resolve_metadata(&input["value"]).await,
                "result-protect" => {
                    opened()?
                        .protect_result(input["kind"].as_str().unwrap(), &input["value"])
                        .await
                }
                "origin" => Ok(workspace::parse_github_origin(
                    input["origin"].as_js_string().unwrap(),
                )
                .unwrap_or(Value::Null)),
                "classify" => {
                    workspace::classify_origin(&input["origin"], 1024 * 1024, 5000, &scope).await
                }
                "discover" => {
                    let mut limits = Limits::default();
                    let overrides = &input["limits"];
                    for (name, value) in [
                        ("durationMs", &mut limits.duration_ms),
                        ("maxCandidates", &mut limits.max_candidates),
                        ("maxDepth", &mut limits.max_depth),
                        ("maxDirectories", &mut limits.max_directories),
                        ("maxEntries", &mut limits.max_entries),
                    ] {
                        if let Some(number) = overrides[name].as_f64() {
                            *value = number;
                        }
                    }
                    let mut progress = Vec::new();
                    let result = workspace::discover(
                        input["root"].as_js_string().unwrap(),
                        &limits,
                        &scope,
                        |value| progress.push(value),
                    )
                    .await?;
                    Ok(json!({"result":result,"first":progress.first(),"last":progress.last()}))
                }
                "validate" => workspace::validate_import(&input["input"], &scope).await,
                "command" => {
                    let mut events = Vec::new();
                    let result =
                        workspace::execute_routed(&input["command"], opened()?, &scope, |event| {
                            events.push(event)
                        })
                        .await?;
                    Ok(json!({"result":result,"first":events.first(),"last":events.last()}))
                }
                _ => Err(anyhow!("Unknown workspace fixture operation")),
            }
        }
        .await;
        let result = match run {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => {
                let code = error
                    .downcast_ref::<folders::AttachmentError>()
                    .map(|e| e.code)
                    .or_else(|| {
                        error
                            .downcast_ref::<workspace::WorkspaceError>()
                            .map(|e| e.code)
                    })
                    .or_else(|| {
                        error
                            .downcast_ref::<cantrip_worker::routing::ProtectedError>()
                            .and_then(|e| e.code)
                    });
                json!({"ok":false,"error":cantrip_worker::git::error_message(&error),"code":code})
            }
        };
        println!(
            "{}",
            json!({"id":input["requestId"],"result":result})
                .stringify()
                .replace('\u{2028}', "\\u2028")
                .replace('\u{2029}', "\\u2029")
        );
    }
    if let Ok(client) = operations.github() {
        client.drain().await?;
    }
    if let Some((_, client)) = github {
        client.drain().await?;
    }
    if let Some(service) = service {
        service.close().await?;
    }
    Ok(())
}
