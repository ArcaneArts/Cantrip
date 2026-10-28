use anyhow::{Context, Result};
use cantrip_server::{
    settings::openrouter::{CatalogFailure, HydrationResult, RuntimeHydrator},
    wire::{JsString, Value},
};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
};
use tokio::sync::{mpsc, oneshot};

struct Oracle(Option<Child>);
impl Drop for Oracle {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
type Read = Shared<BoxFuture<'static, HydrationResult>>;
type Reply = oneshot::Sender<Result<bool, CatalogFailure>>;
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("fixture text")
}
async fn run(input: &Value) -> Result<Value> {
    let (sender, mut receive) = mpsc::unbounded_channel::<(JsString, Value, Reply)>();
    let hydrator = RuntimeHydrator::new();
    let mut reads: HashMap<String, Read> = HashMap::new();
    let mut replies = vec![];
    let mut calls = vec![];
    let mut results = vec![];
    for step in input["steps"].as_array().context("hydration steps")? {
        let index = step["index"].as_u64().unwrap_or(0) as usize;
        match text(step, "op")? {
            "start" => {
                let sender = sender.clone();
                let owner = step["owner"].clone();
                let future = hydrator
                    .hydrate(
                        step["runtimes"].as_array().context("runtimes")?,
                        Arc::new(move |provider| {
                            let (send, receive) = oneshot::channel();
                            assert!(
                                sender.send((provider, owner.clone(), send)).is_ok(),
                                "fixture loader receiver"
                            );
                            async move {
                                receive
                                    .await
                                    .context("fixture loader response")?
                                    .map_err(anyhow::Error::new)
                            }
                            .boxed()
                        }),
                    )
                    .shared();
                reads.insert(text(step, "id")?.into(), future);
            }
            "load" => {
                while replies.len() <= index {
                    let (provider, owner, reply) =
                        receive.recv().await.context("pending provider load")?;
                    calls.push(if input["trackOwners"] == true {
                        Value::object([("provider", Value::String(provider)), ("owner", owner)])
                    } else {
                        Value::String(provider)
                    });
                    replies.push(Some(reply));
                }
            }
            "resolve" => {
                replies[index]
                    .take()
                    .context("pending load")?
                    .send(Ok(step["value"].as_bool().context("load result")?))
                    .ok()
                    .context("load receiver")?;
            }
            "reject" => {
                replies[index]
                    .take()
                    .context("pending load")?
                    .send(Err(CatalogFailure(
                        step["error"].as_js_string().context("load error")?.clone(),
                    )))
                    .ok()
                    .context("load receiver")?;
            }
            "invalidate" => {
                hydrator.invalidate(step["provider"].as_js_string().context("provider ID")?)
            }
            "mark" => hydrator.mark_hydrated(
                step["provider"]
                    .as_js_string()
                    .context("provider ID")?
                    .clone(),
            ),
            "settle" => hydrator.drain().await,
            "wait" => {
                let id = text(step, "id")?;
                let result = reads.get(id).context("hydration read")?.clone().await;
                results.push(match result {
                    Ok(value) => Value::object([
                        ("id", Value::String(id.into())),
                        ("value", Value::Bool(value)),
                    ]),
                    Err(error) => Value::object([
                        ("id", Value::String(id.into())),
                        (
                            "error",
                            Value::String(
                                error
                                    .downcast_ref::<CatalogFailure>()
                                    .context("original loader failure")?
                                    .0
                                    .clone(),
                            ),
                        ),
                    ]),
                });
            }
            _ => anyhow::bail!("unknown hydration step"),
        }
    }
    hydrator.drain().await;
    Ok(Value::object([
        ("results", Value::Array(results)),
        ("calls", Value::Array(calls)),
    ]))
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hydration_timelines_match_actual_node() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut oracle = Oracle(Some(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/openrouter-hydrator-oracle.mjs",
            ])
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    ));
    let stdout = oracle
        .0
        .as_mut()
        .unwrap()
        .stdout
        .take()
        .context("hydrator oracle stdout")?;
    let mut count = 0;
    let mut receipt = None;
    for line in BufReader::new(stdout).lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if case.get("done").is_some() {
            receipt = case["done"].as_u64();
            continue;
        }
        anyhow::ensure!(receipt.is_none(), "case after completion");
        let actual = tokio::time::timeout(std::time::Duration::from_secs(10), run(&case["input"]))
            .await
            .with_context(|| format!("hydration scenario {}", case["input"]["name"]))??;
        anyhow::ensure!(
            actual == case["expected"],
            "hydration case {} {} actual {} expected {}",
            case["id"],
            case["input"]["name"],
            actual.stringify(),
            case["expected"].stringify()
        );
        count += 1;
    }
    anyhow::ensure!(
        oracle.0.as_mut().unwrap().wait()?.success() && count > 0 && receipt == Some(count),
        "incomplete hydration oracle"
    );
    oracle.0 = None;
    println!("{count} actual Node OpenRouter runtime hydration timelines matched");
    Ok(())
}
