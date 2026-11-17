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
    let mut registry: Option<Registry> = None;
    let mut service: Option<Arc<Service>> = None;
    let mut operations = RepositoryOperations::default();
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
                "git-context" => {
                    operations = RepositoryOperations::new(
                        std::path::Path::new(input["directory"].as_str().unwrap()),
                        input["workerId"].as_js_string().unwrap(),
                    );
                    Ok(Value::Null)
                }
                "git" => cantrip_worker::git::execute(&input["command"], &scope).await,
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
            json!({"id":input["requestId"],"result":result}).stringify()
        );
    }
    if let Some(service) = service {
        service.close().await?;
    }
    Ok(())
}
