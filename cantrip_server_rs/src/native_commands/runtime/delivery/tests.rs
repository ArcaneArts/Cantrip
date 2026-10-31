use super::*;
use crate::wire::value::json;
use anyhow::Context;
use std::{collections::HashMap, path::PathBuf, process::Command, sync::Weak};

struct Pending {
    kind: &'static str,
    chat: Option<String>,
    send: Option<oneshot::Sender<Result<Value>>>,
}
#[derive(Default)]
struct Control {
    trace: Mutex<Vec<Value>>,
    pending: Mutex<Vec<Pending>>,
    counts: Mutex<HashMap<&'static str, usize>>,
    service: Mutex<Weak<QueueDelivery>>,
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
        self.trace.lock().unwrap().push(args.clone());
        let (send, receive) = oneshot::channel();
        self.pending.lock().unwrap().push(Pending {
            kind,
            chat: args["chatId"].as_str().map(str::to_owned),
            send: Some(send),
        });
        async move {
            receive
                .await
                .context("Controlled delivery operation dropped")?
        }
        .boxed()
    }
    fn complete(&self, step: &Value) -> Result<()> {
        let mut pending = self.pending.lock().unwrap();
        let call = pending
            .iter_mut()
            .find(|call| {
                call.send.is_some()
                    && step["kind"] == call.kind
                    && step
                        .get("chat")
                        .and_then(Value::as_str)
                        .is_none_or(|chat| call.chat.as_deref() == Some(chat))
            })
            .with_context(|| format!("Missing pending delivery operation {}", step.stringify()))?;
        let result = match step.get("error").and_then(Value::as_str) {
            Some(error) => Err(anyhow::anyhow!(error.to_owned())),
            None => Ok(step.get("value").cloned().unwrap_or(Value::Null)),
        };
        anyhow::ensure!(
            call.send.take().unwrap().send(result).is_ok(),
            "Delivery operation was cancelled"
        );
        Ok(())
    }
}
impl Backend for Control {
    fn pending_dispatches(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        let pending = self.issue("dispatches", Value::Object(Default::default()));
        async move {
            Ok(pending
                .await?
                .as_array()
                .context("Dispatch entries")?
                .clone())
        }
        .boxed()
    }
    fn pending_notifications(&self) -> BoxFuture<'_, Result<Vec<Value>>> {
        let pending = self.issue("notifications", Value::Object(Default::default()));
        async move {
            Ok(pending
                .await?
                .as_array()
                .context("Notification entries")?
                .clone())
        }
        .boxed()
    }
    fn publish(&self, entry: &Value) -> Result<()> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":"publish","ownerId":entry["ownerId"],"chatId":entry["chatId"]}));
        if self.input["stopOnPublish"] == true {
            self.service.lock().unwrap().upgrade().unwrap().stop();
        }
        if let Some(error) = self.input["publishErrors"]
            .get(entry["chatId"].as_str().unwrap())
            .and_then(Value::as_str)
        {
            anyhow::bail!("{error}");
        }
        Ok(())
    }
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        let command = json!({"type":"chat.queue.changed","chatId":entry["chatId"],"revision":entry["revision"]});
        let options = json!({"ownerId":entry["ownerId"],"timeoutMs":10000});
        let result=self.issue("request",json!({"chatId":entry["chatId"],"workerId":entry["workerId"],"command":command,"options":options}));
        async move {
            result.await?;
            Ok(())
        }
        .boxed()
    }
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        let result = self.issue(
            "acknowledge",
            json!({"chatId":entry["chatId"],"revision":entry["revision"]}),
        );
        async move {
            result.await?;
            Ok(())
        }
        .boxed()
    }
    fn defer(&self, entry: Value) -> BoxFuture<'_, Result<()>> {
        let result = self.issue("defer", json!({"chatId":entry["chatId"]}));
        async move {
            result.await?;
            Ok(())
        }
        .boxed()
    }
}
// The service owns finite task groups; controlled I/O remains pending until the
// next explicit step. Yield through those groups before observing the boundary.
async fn settle() {
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
}
async fn run(input: &Value) -> Result<Value> {
    let control = Arc::new(Control {
        input: input.clone(),
        ..Control::default()
    });
    let dispatch = (input["dispatch"] != false).then(|| {
        let control = control.clone();
        Arc::new(move |owner: String, chat: String| {
            let control = control.clone();
            async move {
                control
                    .issue("dispatch", json!({"ownerId":owner,"chatId":chat}))
                    .await?;
                Ok(())
            }
            .boxed()
        }) as Dispatch
    });
    let errors = control.clone();
    let service = QueueDelivery::with_backend(
        control.clone(),
        dispatch,
        Arc::new(move |error| {
            errors
                .trace
                .lock()
                .unwrap()
                .push(json!({"kind":"error","message":error.to_string()}));
        }),
    );
    *control.service.lock().unwrap() = Arc::downgrade(&service);
    let mut runs = Vec::<(String, Sweep)>::new();
    let mut observations = Vec::<Value>::new();
    for step in input["steps"].as_array().context("Delivery steps")? {
        match step["op"].as_str().context("Delivery step operation")? {
            "run" => {
                let future = service.run_once();
                let previous = runs
                    .iter()
                    .find(|(_, run)| run.ptr_eq(&future))
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
                    "Delivery sweep did not settle"
                );
                control
                    .trace
                    .lock()
                    .unwrap()
                    .push(json!({"kind":"settled","id":step["id"]}));
            }
            "observe" => observations
                .push(json!({"name":step["name"],"trace":control.trace.lock().unwrap().clone()})),
            "stop" => service.stop(),
            "start" => service.start(),
            "advance" => {
                tokio::time::advance(Duration::from_millis(
                    step["ms"].as_f64().context("Clock step")? as u64,
                ))
                .await
            }
            _ => anyhow::bail!("Unknown delivery scenario step"),
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
        "Unfinished delivery operations"
    );
    assert_eq!(
        service.state.lock().unwrap().active,
        0,
        "Owned requests and recovery groups drained"
    );
    service.drained().await;
    service.stop();
    let trace = control.trace.lock().unwrap().clone();
    Ok(json!({"trace":trace,"observations":observations}))
}
#[tokio::test(start_paused = true)]
async fn queue_delivery_recovery_and_shutdown_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/queue-delivery-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Delivery oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for case in cases.as_array().context("Delivery scenarios")? {
        assert_eq!(
            run(case).await.with_context(|| case["name"].stringify())?,
            case["expected"],
            "{}",
            case["name"].stringify()
        );
    }
    println!(
        "{} actual queue delivery scenarios matched",
        cases.as_array().unwrap().len()
    );
    Ok(())
}
