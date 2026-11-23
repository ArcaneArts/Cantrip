//! Disposable JSON driver plus a native stdio protocol peer; never production.
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    codex::{diagnostics, discovery, rpc_client::Client},
    installation::{Installation, verify},
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[path = "support/codex_peer.rs"]
mod peer;
#[derive(Default)]
struct Fixture {
    client: Option<Client>,
    pending: HashMap<String, Work<Value>>,
}
fn string(input: &Value, key: &str) -> cantrip_wire::JsString {
    input[key]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "".into())
}
fn options(input: &Value) -> discovery::Options {
    let mut options = discovery::Options::local(
        PathBuf::from(input["cwd"].as_str().unwrap()),
        std::env::vars().collect(),
    );
    options
        .environment
        .insert("PATH".into(), "/usr/bin:/bin".into());
    options
        .environment
        .insert("CANTRIP_CODEX_FIXTURE".into(), input["config"].stringify());
    options.bundled = input["bundled"] == true;
    if let Some(platform) = input["platform"].as_str() {
        options.platform = platform.to_owned();
    }
    if let Some(ms) = input["timeoutMs"].as_u64() {
        options.probe_timeout = Duration::from_millis(ms);
        options.version_timeout = Some(Duration::from_millis(ms));
    }
    options
}
impl Fixture {
    async fn run(&mut self, input: Value) -> Result<Value> {
        let name = input["name"].as_str().unwrap_or("a").to_owned();
        match input["op"].as_str().unwrap() {
            "semantic" => Ok(
                discovery::semantic(&string(&input, "value")).map_or(Value::Null, Value::String)
            ),
            "tested" => Ok(json!(discovery::tested(&string(&input, "value")))),
            "initialize" => Ok(discovery::initialize(
                &input["value"],
                input["experimental"] == true,
            )
            .unwrap_or(Value::Null)),
            "features" => Ok(discovery::feature_page(&input["value"]).unwrap_or(Value::Null)),
            "assess" => discovery::assess(&input["value"]),
            "methods" => Ok(json!({"core":discovery::CORE,"optional":discovery::OPTIONAL})),
            "methods.available" => Ok(json!(discovery::methods_available(
                &input["report"],
                input["methods"].as_array().unwrap()
            ))),
            "feature.usable" => Ok(json!(discovery::feature_usable(
                &input["report"],
                &input["value"]
            ))),
            "redact" => Ok(diagnostics::redact(
                &input["value"],
                &input["secrets"]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .map(|v| v.as_js_string().unwrap().clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                0,
            )),
            "exit" => Ok(json!(diagnostics::exit_with_status(
                input["status"].as_str().unwrap(),
                &string(&input, "tail")
            ))),
            "verify" => {
                let install = Installation {
                    binary: PathBuf::from(input["binary"].as_str().unwrap()),
                    manifest_path: input["manifestPath"].as_str().map(PathBuf::from),
                    source: "bundle",
                };
                Ok(verify::verify(
                    &install,
                    input["platform"].as_str().unwrap_or("darwin"),
                    input["architecture"].as_str().unwrap_or("arm64"),
                    Path::new(input["cwd"].as_str().unwrap()),
                )
                .await?
                .unwrap_or(Value::Null))
            }
            "discover" | "version" => {
                let options = options(&input);
                let binary = Path::new(input["binary"].as_str().unwrap());
                if input["op"] == "version" {
                    Ok(discovery::version(binary, &options)
                        .await
                        .map_or(Value::Null, Value::String))
                } else {
                    discovery::discover(
                        binary,
                        Path::new(input["home"].as_str().unwrap()),
                        &options,
                    )
                    .await
                }
            }
            "rpc.spawn" => {
                if let Some(client) = self.client.take() {
                    client.close().await?;
                }
                let options = options(&input);
                self.client = Some(
                    Client::spawn(
                        Path::new(input["binary"].as_str().unwrap()),
                        Path::new(input["home"].as_str().unwrap()),
                        &options.cwd,
                        &options.environment,
                        options.probe_timeout,
                    )
                    .await?,
                );
                Ok(Value::Null)
            }
            "rpc.request" => {
                let work = self
                    .client
                    .as_ref()
                    .unwrap()
                    .request(string(&input, "method"), input.get("params").cloned());
                self.pending.insert(name, work);
                Ok(Value::Null)
            }
            "rpc.concurrent" => {
                let client = self.client.as_ref().unwrap();
                let mut tasks = tokio::task::JoinSet::new();
                for index in 0..12 {
                    let client = client.clone();
                    tasks.spawn(async move {
                        client
                            .request("fixture/echo".into(), Some(json!({"value":index})))
                            .await
                    });
                }
                let mut replies = Vec::new();
                while let Some(reply) = tasks.join_next().await {
                    replies.push(reply??);
                }
                replies.sort_by_key(|value| value["result"].as_u64().unwrap());
                let mut ids = replies
                    .iter()
                    .map(|value| value["id"].as_u64().unwrap())
                    .collect::<Vec<_>>();
                ids.sort_unstable();
                Ok(
                    json!({"ids":ids,"results":replies.iter().map(|value| value["result"].clone()).collect::<Vec<_>>()}),
                )
            }
            "rpc.abandon" => {
                drop(
                    self.client
                        .as_ref()
                        .unwrap()
                        .request(string(&input, "method"), input.get("params").cloned()),
                );
                Ok(Value::Null)
            }
            "rpc.wait" => {
                let pattern = input.get("pattern").filter(|v| !v.is_null()).cloned();
                let predicate = Arc::new(move |value: &Value| {
                    pattern.as_ref().is_none_or(|pattern| {
                        pattern
                            .as_object()
                            .unwrap()
                            .iter()
                            .all(|(key, want)| value.get(&key.lossy()) == Some(want))
                    })
                });
                let work = self.client.as_ref().unwrap().wait(
                    string(&input, "method"),
                    predicate,
                    input["timeoutMs"].as_u64().map(Duration::from_millis),
                );
                self.pending.insert(name, work);
                Ok(Value::Null)
            }
            "rpc.notify" => {
                self.client
                    .as_ref()
                    .unwrap()
                    .notify(string(&input, "method"), input.get("params").cloned())?;
                Ok(Value::Null)
            }
            "rpc.close" => {
                if let Some(client) = self.client.take() {
                    client.close().await?;
                }
                Ok(Value::Null)
            }
            "await" => self.pending.remove(&name).unwrap().await,
            "tick" => {
                tokio::time::sleep(Duration::from_millis(input["ms"].as_u64().unwrap_or(10))).await;
                Ok(Value::Null)
            }
            _ => bail!("Unknown Codex fixture operation"),
        }
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    codex_utils_pty::init_spawn_helper(std::env::args_os());
    if std::env::args().any(|v| v == "--version" || v == "app-server") {
        return peer::run().await;
    }
    let mut fixture = Fixture::default();
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = input.next_line().await? {
        let input = parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result = match fixture.run(input).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":cantrip_worker::error::message(&error)}),
        };
        output
            .write_all((result.stringify() + "\n").as_bytes())
            .await?;
        output.flush().await?;
    }
    if let Some(client) = fixture.client {
        client.close().await?;
    }
    Ok(())
}
