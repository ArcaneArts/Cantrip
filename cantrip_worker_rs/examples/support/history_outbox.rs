//! Synthetic IPC adapter for the real native outbox, never a production helper.
use super::*;
use cantrip_history::outbox::{self, Outbox, Recovery};
use std::sync::atomic::{AtomicUsize, Ordering};

pub async fn run(
    handles: &mut HashMap<String, Outbox>,
    service: Arc<Keys>,
    input: &Value,
) -> Result<Value> {
    let handle = input["handle"].as_str().unwrap_or("a");
    match input["op"].as_str().unwrap() {
        "outbox.open" => {
            let names = ["workerId", "chatId", "bindingId"].map(|key| {
                input[key].as_js_string().cloned().unwrap_or_else(|| {
                    match key {
                        "workerId" => "worker",
                        "chatId" => "chat",
                        _ => "binding",
                    }
                    .into()
                })
            });
            let scope = outbox::scope(service.as_ref(), &names[0], &names[1], &names[2])?;
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = calls.clone();
            let recovery = input.get("recovery").cloned();
            let recover_error = input.get("recoveryError").cloned();
            let after = input.get("identityAfterRecovery").cloned();
            let keys = service.clone();
            let recover: Option<Recovery> = if recovery.is_some() || recover_error.is_some() {
                Some(Arc::new(move || {
                    let (recovery, error, after, keys, counter) = (
                        recovery.clone(),
                        recover_error.clone(),
                        after.clone(),
                        keys.clone(),
                        counter.clone(),
                    );
                    Box::pin(async move {
                        counter.fetch_add(1, Ordering::Relaxed);
                        if let Some(after) = after {
                            *keys.0.lock().unwrap() = after;
                        }
                        if let Some(error) = error {
                            bail!("{}", error.as_str().unwrap());
                        }
                        Ok(recovery.unwrap())
                    })
                }))
            } else {
                None
            };
            let outbox = Outbox::open(
                PathBuf::from(input["directory"].as_str().unwrap()),
                scope,
                service,
                recover,
            )
            .await?;
            let result = json!({"directory":outbox.directory().to_string_lossy(),"streamId":outbox.stream_id(),"scope":outbox.scope(),"recoveryCalls":calls.load(Ordering::Relaxed)});
            handles.insert(handle.to_owned(), outbox);
            Ok(result)
        }
        "outbox.baseline" => Ok(
            outbox::baseline::prepare(&input["recovery"], &input["scope"])?.unwrap_or(Value::Null),
        ),
        "outbox.digest" => Ok(json!(outbox::baseline::payload_digest(
            &input["batch"],
            &input["previousDigest"]
        ))),
        "outbox.validate-baseline" => Ok(json!(outbox::baseline::validate(
            &input["entries"],
            &input["streamId"]
        )?)),
        "outbox.verify-rejection" => outbox::baseline::verify_rejection(
            &input["rejection"],
            &input["request"],
            &input["code"],
        ),
        "outbox.batch" => {
            let jobs = input["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    handles
                        .get(entry["handle"].as_str().unwrap())
                        .unwrap()
                        .append(
                            entry["recordId"].as_js_string().unwrap(),
                            entry["body"].as_js_string().unwrap(),
                        )
                })
                .collect::<Vec<_>>();
            let mut result = Vec::new();
            for job in jobs {
                result.push(job.await?);
            }
            Ok(json!(result))
        }
        op => {
            let outbox = handles
                .get(handle)
                .ok_or_else(|| anyhow!("Missing outbox handle"))?;
            let id = input["recordId"]
                .as_js_string()
                .cloned()
                .unwrap_or_else(|| "".into());
            match op {
                "outbox.append" => {
                    outbox
                        .append(&id, input["body"].as_js_string().unwrap())
                        .await
                }
                "outbox.pending" => Ok(json!(outbox.pending().await?)),
                "outbox.body" => Ok(json!(outbox.open_body(&input["record"])?.as_str())),
                "outbox.ack" => {
                    outbox.acknowledge_committed(&input["receipt"]).await?;
                    Ok(Value::Null)
                }
                "outbox.receipt" => {
                    outbox
                        .committed_receipt(
                            &id,
                            input.get("expectedBody").and_then(Value::as_js_string),
                        )
                        .await
                }
                "outbox.replace" => Ok(json!(
                    outbox
                        .replace_rejected(
                            &input["rejection"],
                            &id,
                            input["body"].as_js_string().unwrap()
                        )
                        .await?
                )),
                "outbox.replacement" => outbox.replacement(&id).await,
                "outbox.abandon" => {
                    drop(outbox.append(&id, input["body"].as_js_string().unwrap()));
                    Ok(json!(outbox.pending().await?))
                }
                _ => bail!("Unknown outbox fixture operation"),
            }
        }
    }
}
