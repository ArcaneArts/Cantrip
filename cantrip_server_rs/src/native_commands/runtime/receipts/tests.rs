use super::*;
use crate::wire::value::json;
use futures::{FutureExt, future::BoxFuture, task::noop_waker_ref};
use std::{
    path::PathBuf,
    process::Command,
    task::{Context as TaskContext, Poll},
};
use tokio::sync::oneshot;

struct Read {
    id: String,
    index: usize,
    send: Option<oneshot::Sender<Result<Option<Value>>>>,
}
struct Wait {
    id: String,
    abort: watch::Sender<Option<Arc<str>>>,
    future: Option<BoxFuture<'static, Result<Value>>>,
    result: Option<Value>,
}
fn poll(waits: &mut [Wait]) {
    let mut cx = TaskContext::from_waker(noop_waker_ref());
    for wait in waits {
        let Some(future) = &mut wait.future else {
            continue;
        };
        if let Poll::Ready(result) = future.as_mut().poll(&mut cx) {
            wait.future = None;
            wait.result = Some(match result {
                Ok(value) => json!({"ok":value}),
                Err(error) => json!({"error":error.to_string()}),
            });
        }
    }
}
async fn run(input: &Value) -> Result<Value> {
    let hub = ReceiptNotifications::default();
    let reads = Arc::new(Mutex::new(Vec::<Read>::new()));
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let mut waits = Vec::<Wait>::new();
    let mut results = Vec::<Value>::new();
    let mut observations = Vec::<Value>::new();
    for step in input["steps"].as_array().context("Receipt steps")? {
        let id = step.get("id").and_then(Value::as_str).unwrap_or("a");
        match step["op"].as_str().context("Receipt step")? {
            "start" => {
                let initial = step.get("aborted").and_then(Value::as_str).map(Arc::from);
                let (abort, signal) = watch::channel(initial);
                let (hub, reads, calls, id) =
                    (hub.clone(), reads.clone(), calls.clone(), id.to_owned());
                let chat = step.get("chat").cloned().unwrap_or(json!("chat"));
                let wait_id = id.clone();
                let future = async move {
                    let mut index = 0;
                    hub.wait(
                        chat.as_js_string().context("Chat key")?,
                        signal,
                        move || {
                            let (send, receive) = oneshot::channel();
                            reads.lock().unwrap().push(Read {
                                id: id.clone(),
                                index,
                                send: Some(send),
                            });
                            calls.lock().unwrap().push(json!({"id":id,"index":index}));
                            index += 1;
                            async move { receive.await.context("Controlled receipt read ended")? }
                        },
                    )
                    .await
                }
                .boxed();
                waits.push(Wait {
                    id: wait_id,
                    abort,
                    future: Some(future),
                    result: None,
                });
            }
            "reply" | "reject" => {
                let index = step["index"].as_f64().context("Read index")? as usize;
                let send = reads
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .find(|read| read.id == id && read.index == index)
                    .context("Expected read was started")?
                    .send
                    .take()
                    .context("Read already replied")?;
                let value = if step["op"] == "reject" {
                    Err(anyhow::anyhow!(
                        step["error"].as_str().context("Read error")?.to_owned()
                    ))
                } else {
                    Ok((!step["value"].is_null()).then(|| step["value"].clone()))
                };
                anyhow::ensure!(send.send(value).is_ok(), "Receipt read was cancelled");
            }
            "notify" => hub.notify(step["chat"].as_js_string().context("Notice Chat")?),
            "abort" => {
                waits
                    .iter()
                    .find(|wait| wait.id == id)
                    .context("Waiter")?
                    .abort
                    .send_replace(Some(Arc::from(
                        step["reason"].as_str().context("Abort reason")?,
                    )));
            }
            "advance" => {
                tokio::time::advance(Duration::from_millis(
                    step["ms"].as_f64().context("Clock step")? as u64,
                ))
                .await;
                tokio::task::yield_now().await;
            }
            "wait" => {
                poll(&mut waits);
                let result = waits
                    .iter()
                    .find(|wait| wait.id == id)
                    .context("Waiter")?
                    .result
                    .as_ref()
                    .context("Waiter did not finish")?;
                let mut result = result.clone();
                result["id"] = json!(id);
                results.push(result);
            }
            "observe" => observations
                .push(json!({"name":step["name"],"calls":calls.lock().unwrap().clone()})),
            _ => anyhow::bail!("Unknown receipt scenario step"),
        }
        poll(&mut waits);
    }
    anyhow::ensure!(
        waits.iter().all(|wait| wait.result.is_some()),
        "Unfinished receipt waiter"
    );
    assert!(
        hub.listeners.lock().unwrap().is_empty(),
        "All subscriptions were removed"
    );
    let calls = calls.lock().unwrap().clone();
    Ok(json!({"calls":calls,"results":results,"observations":observations}))
}

#[tokio::test(start_paused = true)]
async fn notification_cancellation_and_poll_races_match_actual_source() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/native-queue-receipts-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Receipt oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for case in cases.as_array().context("Receipt scenarios")? {
        assert_eq!(
            run(case).await?,
            case["expected"],
            "{}",
            case["name"].stringify()
        );
    }
    println!(
        "{} actual queue receipt notification scenarios matched",
        cases.as_array().unwrap().len()
    );
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn dropping_waiters_and_abort_controllers_does_not_retain_subscriptions() -> Result<()> {
    let hub = ReceiptNotifications::default();
    let (abort, signal) = watch::channel(None);
    let chat = JsString::from("chat");
    let mut future = Box::pin(hub.wait(&chat, signal, || async { Ok(None) }));
    let mut cx = TaskContext::from_waker(noop_waker_ref());
    assert!(future.as_mut().poll(&mut cx).is_pending());
    assert_eq!(hub.listeners.lock().unwrap().len(), 1);
    drop(abort);
    assert!(future.as_mut().poll(&mut cx).is_pending());
    drop(future);
    assert!(hub.listeners.lock().unwrap().is_empty());
    hub.notify(&chat);
    assert!(hub.listeners.lock().unwrap().is_empty());
    Ok(())
}
