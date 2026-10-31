use super::*;
use crate::wire::value::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Command,
    sync::{Weak, atomic::AtomicI64},
};
struct Pending {
    kind: &'static str,
    root: Option<String>,
    send: Option<oneshot::Sender<Result<Value>>>,
}
#[derive(Default)]
struct Control {
    trace: Mutex<Vec<Value>>,
    pending: Mutex<Vec<Pending>>,
    counts: Mutex<HashMap<&'static str, usize>>,
    service: Mutex<Weak<LogicalDelivery>>,
    now: AtomicI64,
    input: Value,
}
impl Control {
    fn issue(&self, kind: &'static str, mut args: Value) -> BoxFuture<'_, Result<Value>> {
        let mut counts = self.counts.lock().unwrap();
        let index = counts.entry(kind).or_default();
        args["kind"] = json!(kind);
        args["index"] = json!(*index);
        *index += 1;
        drop(counts);
        let root = args["command"]["rootOperationId"]
            .as_str()
            .or_else(|| {
                args["identity"]
                    .as_array()
                    .and_then(|a| a.get(3))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned);
        self.trace.lock().unwrap().push(args);
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().push(Pending {
            kind,
            root,
            send: Some(send),
        });
        async move {
            receive
                .await
                .context("Controlled completion operation dropped")?
        }
        .boxed()
    }
    fn complete(&self, step: &Value) -> Result<()> {
        let mut pending = self.pending.lock().unwrap();
        let call = pending
            .iter_mut()
            .find(|p| {
                p.send.is_some()
                    && step["kind"] == p.kind
                    && step
                        .get("root")
                        .and_then(Value::as_str)
                        .is_none_or(|r| p.root.as_deref() == Some(r))
            })
            .with_context(|| format!("Missing completion operation {}", step.stringify()))?;
        let value = if let Some(error) = step.get("error").and_then(Value::as_str) {
            Err(anyhow::anyhow!(error.to_owned()))
        } else {
            Ok(step.get("value").cloned().unwrap_or(Value::Null))
        };
        anyhow::ensure!(
            call.send.take().unwrap().send(value).is_ok(),
            "Completion operation cancelled"
        );
        Ok(())
    }
}
fn identity(entry: &Value) -> Value {
    json!([
        entry["ownerId"].clone(),
        entry["workerId"].clone(),
        entry["chatId"].clone(),
        entry["rootOperationId"].clone(),
        entry["rootOperationGeneration"].clone()
    ])
}
impl Backend for Control {
    fn pending(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        let p = self.issue("list", json!({"limit":64}));
        async move { Ok(p.await?.as_array().context("Completion rows")?.clone()) }.boxed()
    }
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        let command = json!({"type":"chat.native-logical.complete","chatId":entry["chatId"],"rootOperationId":entry["rootOperationId"],"rootOperationGeneration":entry["rootOperationGeneration"]});
        let options = json!({"ownerId":entry["ownerId"],"timeoutMs":10000});
        let p = self.issue(
            "request",
            json!({"workerId":entry["workerId"],"command":command,"options":options}),
        );
        async move {
            p.await?;
            Ok(())
        }
        .boxed()
    }
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        let p = self.issue("ack", json!({"identity":identity(&entry)}));
        async move {
            p.await?;
            Ok(())
        }
        .boxed()
    }
    fn defer(&self, entry: Value, at: i64) -> BoxFuture<'_, Result<()>> {
        let p = self.issue("defer", json!({"identity":identity(&entry),"at":at}));
        async move {
            p.await?;
            Ok(())
        }
        .boxed()
    }
}
async fn settle() {
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
}
async fn run(input: &Value) -> Result<Value> {
    let control = Arc::new(Control {
        input: input.clone(),
        now: AtomicI64::new(1700000000000),
        ..Default::default()
    });
    let errors = control.clone();
    let clock = control.clone();
    let service = LogicalDelivery::with_backend(
        control.clone(),
        Arc::new(move |error, entry| {
            errors
                .trace
                .lock()
                .unwrap()
                .push(json!({"kind":"error","message":error.to_string(),"entry":entry}));
            if let Some(now) = errors.input.get("clockOnError").and_then(Value::as_f64) {
                errors.now.store(now as i64, Ordering::Relaxed);
            }
            if errors.input["stopOnError"] == true {
                errors.service.lock().unwrap().upgrade().unwrap().stop();
            }
        }),
        Arc::new(move || clock.now.load(Ordering::Relaxed)),
        Duration::from_millis(
            input
                .get("intervalMs")
                .and_then(Value::as_f64)
                .unwrap_or(1000.0) as u64,
        ),
    );
    *control.service.lock().unwrap() = Arc::downgrade(&service);
    let mut runs = Vec::<(String, Sweep)>::new();
    let mut observations = Vec::<Value>::new();
    for step in input["steps"]
        .as_array()
        .context("Completion delivery steps")?
    {
        match step["op"].as_str().context("Completion operation")? {
            "run" => {
                let future = service.run_once();
                let previous = runs
                    .iter()
                    .find(|(_, f)| f.ptr_eq(&future))
                    .map(|(id, _)| id.clone());
                let id = step["id"].as_str().context("Sweep id")?.to_owned();
                control
                    .trace
                    .lock()
                    .unwrap()
                    .push(json!({"kind":"run","id":id,"coalescedWith":previous}));
                runs.push((id, future));
            }
            "complete" => control.complete(step)?,
            "wait" => {
                let future = runs
                    .iter()
                    .find(|(id, _)| step["id"] == id.as_str())
                    .context("Sweep waiter")?
                    .1
                    .clone();
                anyhow::ensure!(
                    future.now_or_never().is_some(),
                    "Completion sweep did not settle"
                );
                control
                    .trace
                    .lock()
                    .unwrap()
                    .push(json!({"kind":"settled","id":step["id"]}));
            }
            "drop" => runs.retain(|(id, _)| step["id"] != id.as_str()),
            "observe" => observations
                .push(json!({"name":step["name"],"trace":control.trace.lock().unwrap().clone()})),
            "start" => service.start(),
            "stop" => service.stop(),
            "advance" => {
                let ms = step["ms"].as_f64().context("Clock step")? as u64;
                control.now.fetch_add(ms as i64, Ordering::Relaxed);
                tokio::time::advance(Duration::from_millis(ms)).await;
            }
            _ => anyhow::bail!("Unknown completion step"),
        }
        settle().await;
    }
    anyhow::ensure!(
        control
            .pending
            .lock()
            .unwrap()
            .iter()
            .all(|p| p.send.is_none()),
        "Unfinished completion operations"
    );
    assert_eq!(service.state.lock().unwrap().active, 0);
    service.drained().await;
    service.stop();
    let trace = control.trace.lock().unwrap().clone();
    Ok(json!({"trace":trace,"observations":observations}))
}
#[tokio::test(start_paused = true)]
async fn logical_completion_delivery_matches_unchanged_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/completion-delivery-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Completion oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for case in cases.as_array().context("Completion scenarios")? {
        assert_eq!(
            run(case).await.with_context(|| case["name"].stringify())?,
            case["expected"],
            "{}",
            case["name"].stringify()
        );
    }
    println!(
        "{} unchanged Source logical completion scenarios matched",
        cases.as_array().unwrap().len()
    );
    Ok(())
}
