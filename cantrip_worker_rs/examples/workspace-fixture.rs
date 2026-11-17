//! Local synthetic/disposable workspace differential driver, never shipped.
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    routing::Registry,
    workspace::{self, Limits, Scope},
};
use std::io::{self, BufRead};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut registry: Option<Registry> = None;
    let scope = Scope::default();
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{}", e.lossy()))?;
        let run = async {
            let opened = || {
                registry
                    .as_ref()
                    .ok_or_else(|| anyhow!("Fixture registry not open"))
            };
            match input["op"].as_str().unwrap_or("") {
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
                    .downcast_ref::<workspace::WorkspaceError>()
                    .map(|e| e.code)
                    .or_else(|| {
                        error
                            .downcast_ref::<cantrip_worker::routing::ProtectedError>()
                            .and_then(|e| e.code)
                    });
                json!({"ok":false,"error":error.to_string(),"code":code})
            }
        };
        println!(
            "{}",
            json!({"id":input["requestId"],"result":result}).stringify()
        );
    }
    Ok(())
}
