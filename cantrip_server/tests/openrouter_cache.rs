use anyhow::{Context, Result};
use cantrip_server::{
    settings::openrouter::{
        CatalogCache, CatalogFailure, CatalogFetcher, CatalogRead, FetchResponse,
    },
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
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};

type HeaderResponse = Result<(u16, JsString, Option<JsString>), CatalogFailure>;
struct Pending {
    url: String,
    etag: Option<JsString>,
    headers: Option<oneshot::Sender<HeaderResponse>>,
    body: Option<oneshot::Sender<Result<Value, CatalogFailure>>>,
    started: Option<oneshot::Receiver<()>>,
}
struct ControlledFetcher(mpsc::UnboundedSender<Pending>);
impl CatalogFetcher for ControlledFetcher {
    fn fetch(
        &self,
        url: url::Url,
        etag: Option<JsString>,
    ) -> BoxFuture<'static, Result<FetchResponse, CatalogFailure>> {
        let sender = self.0.clone();
        async move {
            let (headers, receive_headers) = oneshot::channel();
            let (body, receive_body) = oneshot::channel();
            let (started, receive_started) = oneshot::channel();
            assert!(
                sender
                    .send(Pending {
                        url: url.into(),
                        etag,
                        headers: Some(headers),
                        body: Some(body),
                        started: Some(receive_started),
                    })
                    .is_ok(),
                "active fixture receiver"
            );
            let (status, status_text, etag) = receive_headers.await.expect("header response")?;
            Ok(FetchResponse {
                status,
                status_text,
                etag,
                body: async move {
                    let _ = started.send(());
                    receive_body.await.expect("body response")
                }
                .boxed(),
            })
        }
        .boxed()
    }
}
type ReadFuture = Shared<BoxFuture<'static, Result<Arc<CatalogRead>, Arc<CatalogFailure>>>>;
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("fixture text")
}
fn failed(id: &str, error: &CatalogFailure) -> Value {
    Value::object([
        ("id", Value::String(id.into())),
        ("error", Value::String(error.0.clone())),
    ])
}
async fn run(input: &Value) -> Result<Value> {
    let clock = Arc::new(AtomicU64::new(1000_f64.to_bits()));
    let clock_read = Arc::clone(&clock);
    let (sender, mut requests) = mpsc::unbounded_channel();
    let cache = CatalogCache::with_options(
        Arc::new(ControlledFetcher(sender)),
        Arc::new(move || f64::from_bits(clock_read.load(Ordering::SeqCst))),
        input["ttl"].as_f64().unwrap_or(100.0),
    );
    let mut reads: HashMap<String, ReadFuture> = HashMap::new();
    let mut pending: Vec<Pending> = vec![];
    let mut result = vec![];
    for step in input["steps"].as_array().context("fixture steps")? {
        let index = step["index"].as_u64().unwrap_or(0) as usize;
        match text(step, "op")? {
            "clock" => clock.store(
                step["now"].as_f64().context("clock")?.to_bits(),
                Ordering::SeqCst,
            ),
            "read" => {
                let cache = Arc::clone(&cache);
                let base = text(step, "base")?.to_owned();
                let key = text(step, "key")?.to_owned();
                let force = step["force"].as_bool().context("force")?;
                let read = async move { cache.read(&base, &key, force).await.map(Arc::new) }
                    .boxed()
                    .shared();
                // Poll once to perform synchronous admission before starting
                // the next read, exactly as calling an async JS method does.
                let mut start = read.clone();
                let _ = futures::poll!(&mut start);
                reads.insert(text(step, "id")?.into(), read);
            }
            "request" => {
                while pending.len() <= index {
                    pending.push(requests.recv().await.context("catalog request")?);
                }
            }
            "headers" => {
                let response = (
                    step["status"].as_u64().context("response status")? as u16,
                    step["statusText"].as_js_string().context("reason")?.clone(),
                    step["etag"].as_js_string().cloned(),
                );
                pending[index]
                    .headers
                    .take()
                    .context("pending headers")?
                    .send(Ok(response))
                    .ok()
                    .context("header receiver")?;
            }
            "fetch-error" => {
                pending[index]
                    .headers
                    .take()
                    .context("pending headers")?
                    .send(Err(CatalogFailure(
                        step["error"].as_js_string().context("error")?.clone(),
                    )))
                    .ok()
                    .context("header receiver")?;
            }
            "wait-body" => {
                pending[index]
                    .started
                    .take()
                    .context("pending body start")?
                    .await?;
            }
            "body" => {
                pending[index]
                    .body
                    .take()
                    .context("pending body")?
                    .send(Ok(step["value"].clone()))
                    .ok()
                    .context("body receiver")?;
            }
            "body-error" => {
                pending[index]
                    .body
                    .take()
                    .context("pending body")?
                    .send(Err(CatalogFailure(
                        step["error"].as_js_string().context("error")?.clone(),
                    )))
                    .ok()
                    .context("body receiver")?;
            }
            "wait" | "background" => {
                let id = text(step, "id")?;
                match reads.get(id).context("started read")?.clone().await {
                    Err(error) => result.push(failed(id, &error)),
                    Ok(read) => {
                        if step["op"] == "background" {
                            match read
                                .background_refresh
                                .clone()
                                .context("background refresh")?
                                .await
                            {
                                Err(error) => result.push(failed(id, &error)),
                                Ok(snapshot) => result.push(Value::object([
                                    ("id", Value::String(id.into())),
                                    ("background", Value::from_serialize(&*snapshot)),
                                ])),
                            }
                        } else {
                            result.push(Value::object([
                                ("id", Value::String(id.into())),
                                (
                                    "value",
                                    Value::object([
                                        ("snapshot", Value::from_serialize(&*read.snapshot)),
                                        ("servedStale", Value::Bool(read.served_stale)),
                                        (
                                            "background",
                                            Value::Bool(read.background_refresh.is_some()),
                                        ),
                                    ]),
                                ),
                            ]));
                        }
                    }
                }
            }
            _ => anyhow::bail!("unknown cache step"),
        }
    }
    cache.drain().await;
    Ok(Value::object([
        ("result", Value::Array(result)),
        (
            "requests",
            Value::Array(
                pending
                    .into_iter()
                    .map(|request| {
                        Value::object([
                            ("url", Value::String(request.url.into())),
                            (
                                "etag",
                                request.etag.map(Value::String).unwrap_or(Value::Null),
                            ),
                            ("accept", Value::String("application/json".into())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_timelines_match_actual_node() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut child = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/openrouter-cache-oracle.mjs",
        ])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdout = child.stdout.take().context("cache oracle stdout")?;
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
            .with_context(|| format!("cache scenario {}", case["input"]["name"]))??;
        anyhow::ensure!(
            actual == case["expected"],
            "cache case {} {} actual {} expected {}",
            case["id"],
            case["input"]["name"],
            actual.stringify(),
            case["expected"].stringify()
        );
        count += 1;
    }
    anyhow::ensure!(
        child.wait()?.success() && count > 0 && receipt == Some(count),
        "incomplete cache oracle"
    );
    println!("{count} actual Node OpenRouter cache timelines matched");
    Ok(())
}
