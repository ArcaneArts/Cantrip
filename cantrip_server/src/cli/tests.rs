use crate::{
    cli::{self, context::Reader, selectors},
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

struct Views {
    value: Value,
    calls: Mutex<Vec<Value>>,
}
impl Views {
    async fn read(&self, method: &str, id: Value, result: Option<Value>) -> Result<Option<Value>> {
        self.calls
            .lock()
            .unwrap()
            .push(json!({"method":method,"id":id}));
        // Source's async repository promises yield before each awaited result.
        tokio::task::yield_now().await;
        if let Some(error) = self.value["errors"]
            .get(method)
            .and_then(Value::as_js_string)
        {
            anyhow::bail!("{}", error.lossy());
        }
        Ok(result)
    }
}
impl Reader for Views {
    fn chat<'a>(&'a self, id: &'a Value) -> BoxFuture<'a, Result<Option<Value>>> {
        async move {
            self.read(
                "chat",
                id.clone(),
                self.value["chats"]
                    .as_object()
                    .and_then(|chats| id.as_js_string().and_then(|id| chats.get(id)))
                    .cloned(),
            )
            .await
        }
        .boxed()
    }
    fn thread<'a>(
        &'a self,
        worker: &'a Value,
        thread: &'a Value,
    ) -> BoxFuture<'a, Result<Vec<Value>>> {
        async move {
            Ok(self
                .read(
                    "thread",
                    json!([worker, thread]),
                    self.value.get("threads").cloned(),
                )
                .await?
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default())
        }
        .boxed()
    }
    fn terminal<'a>(&'a self, id: &'a Value) -> BoxFuture<'a, Result<Option<Value>>> {
        async move {
            self.read("terminal", id.clone(), self.value.get("terminal").cloned())
                .await
        }
        .boxed()
    }
    fn roots<'a>(&'a self, worker: &'a Value) -> BoxFuture<'a, Result<Vec<Value>>> {
        async move {
            Ok(self
                .read(
                    "roots",
                    Value::Array(vec![worker.clone(), json!(128)]),
                    self.value.get("roots").cloned(),
                )
                .await?
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default())
        }
        .boxed()
    }
}
fn outcome(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":value}),
        Err(error) => {
            let (status, code, message) = if let Some(error) = error.downcast_ref::<cli::Error>() {
                (error.status, error.code, error.message.clone())
            } else {
                (400, "invalid", error.to_string().into())
            };
            json!({"failure":json!({"status":status,"code":code,"error":Value::String(message)})})
        }
    }
}
#[tokio::test]
async fn native_cli_contexts_and_selectors_match_actual_source_functions() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/cli-context-oracle.mjs",
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout)?;
    let cases = oracle["cases"].as_array().context("Source CLI cases")?;
    for (index, case) in cases.iter().enumerate() {
        let reader = Arc::new(Views {
            value: case["views"].clone(),
            calls: Mutex::new(Vec::new()),
        });
        let call = &case["call"];
        let resolved =
            cli::context::resolve(reader.clone(), call, call["command"] == "status").await;
        let result = match resolved {
            Err(error) => Err(error),
            Ok(context) => match case["kind"].as_str() {
                Some("scope") => Ok(context.unwrap_or(Value::Null)),
                Some("worktree") => {
                    let selected = cli::optional(&call["arguments"], "worktree");
                    selected
                        .and_then(|selector| {
                            selectors::worktree(
                                &context.unwrap(),
                                case["views"]["worktrees"].as_array().unwrap(),
                                selector.as_ref().and_then(Value::as_js_string),
                            )
                        })
                        .map(|w| w["id"].clone())
                }
                Some("branch") => selectors::derived_branch(
                    call["arguments"]["name"].as_js_string().unwrap(),
                    case["views"]["worktrees"].as_array().unwrap(),
                )
                .map(Value::String),
                _ => anyhow::bail!("Unknown Source CLI case kind"),
            },
        };
        assert_eq!(
            outcome(result),
            case["outcome"],
            "CLI case{index}: {} {}",
            case["kind"],
            case["variant"]
        );
        // A failing parallel read still completes independently, as Source's
        // already-started Promise.all collaborator does.
        tokio::task::yield_now().await;
        let mut calls = reader.calls.lock().unwrap().clone();
        calls.sort_by_key(|v| v["method"].as_str().unwrap().to_owned());
        assert_eq!(
            Value::Array(calls),
            case["calls"],
            "CLI read boundaries case{index}"
        );
    }
    let targets = oracle["targets"]
        .as_array()
        .context("Source selector cases")?;
    for (index, case) in targets.iter().enumerate() {
        let candidates = case["candidates"].as_array().unwrap();
        assert_eq!(
            selectors::target_default(candidates, &case["input"])?,
            case["outcome"],
            "Target default{index}"
        );
        if let Some(selector) = case["input"]["selector"].as_js_string() {
            assert_eq!(
                selectors::target_exact(candidates, selector)?.unwrap_or(Value::Null),
                case["exact"],
                "Target exact{index}"
            );
            assert_eq!(
                selectors::target_explicit(candidates, selector)?,
                case["explicit"],
                "Target explicit{index}"
            );
        }
    }
    for case in oracle["strings"]
        .as_array()
        .context("Source tool strings")?
    {
        for (name, result) in [
            ("required", cli::required(&case["args"], "key")),
            (
                "optional",
                cli::optional(&case["args"], "key").map(|v| v.unwrap_or(Value::Null)),
            ),
        ] {
            let actual = match result {
                Ok(value) => json!({"ok":value}),
                Err(error) => json!({"error":error.to_string()}),
            };
            assert_eq!(
                actual, case["result"][name],
                "CLI string{name} {}",
                case["args"]
            );
        }
    }
    for case in oracle["mutations"]
        .as_array()
        .context("Source CLI mutation catalog")?
    {
        assert_eq!(
            cli::is_mutation(case["command"].as_str().unwrap()),
            case["mutation"] == true,
            "{}",
            case["command"]
        );
    }
    println!(
        "{} Source CLI context/worktree/branch cases and{} target cases matched",
        cases.len(),
        targets.len()
    );
    Ok(())
}
