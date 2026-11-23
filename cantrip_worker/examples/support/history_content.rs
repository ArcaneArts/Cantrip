//! Disposable driver over real content crypto/preparation/recovery APIs.
use super::*;
use cantrip_crypto::content::{self as crypto, Communication};
use cantrip_history::{archive, canonical};
use cantrip_worker::history::{client, preparation, recovery};
use std::sync::atomic::{AtomicUsize, Ordering};
fn kind(input: &Value) -> Result<Communication> {
    Ok(match input["kind"].as_str().unwrap() {
        "message" => Communication::Message,
        "prompt" => Communication::QueuedPrompt,
        "draft" => Communication::ComposerDraft,
        "plan" => Communication::Plan,
        "request" => Communication::InteractionRequest,
        "response" => Communication::InteractionResponse,
        _ => bail!("Unknown communication fixture kind"),
    })
}
pub async fn run(service: Arc<Keys>, input: Value) -> Result<Value> {
    if input["op"] == "content.recovery" {
        let token = input["token"].as_str().unwrap().to_owned();
        let client = client::Client::new(client::Options {
            server_url: input["serverUrl"].as_str().unwrap().to_owned(),
            worker_id: input["binding"]["workerId"].as_js_string().unwrap().clone(),
            token: Arc::new(move || Ok(token.clone())),
            metadata_signal: None,
        })?;
        let signal = if let Some(ms) = input["abortAfterMs"].as_u64() {
            let (abort, signal) = cantrip_worker::metadata::Abort::new();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                abort.abort(anyhow!("fixture stopped"));
            });
            Some(signal)
        } else {
            None
        };
        let retries = Arc::new(Mutex::new(Vec::<u64>::new()));
        let observed = retries.clone();
        let result = recovery::read(
            &input["binding"],
            client,
            service,
            recovery::Options {
                signal,
                page_size: input.get("pageSize").cloned(),
                batch_page_size: input.get("batchPageSize").cloned(),
                on_retry: Some(Arc::new(move |attempt| {
                    observed.lock().unwrap().push(attempt);
                    bail!("ignored fixture reporting error")
                })),
            },
        )
        .await?;
        return Ok(json!({"snapshot":result,"retries":retries.lock().unwrap().clone()}));
    }
    tokio::task::spawn_blocking(move || {
        let bound = &input["binding"];
        let identity = &input["identity"];
        let revision = &input["revision"];
        let calls = AtomicUsize::new(0);
        let check = || {
            let next = calls.fetch_add(1, Ordering::SeqCst) + 1;
            if input["stopAt"].as_u64() == Some(next as u64) {
                bail!("fixture stopped");
            }
            Ok(())
        };
        match input["op"].as_str().unwrap() {
            "content.item.protect" => canonical::protect_item(
                service.as_ref(),
                bound,
                identity,
                revision,
                &input["source"],
            ),
            "content.item.open" => {
                canonical::open_item(service.as_ref(), bound, identity, &input["evidence"])
            }
            "content.turn.protect" => canonical::protect_turn(
                service.as_ref(),
                bound,
                &input["header"],
                &input["content"],
            ),
            "content.turn.open" => canonical::open_turn(service.as_ref(), bound, &input["turn"]),
            "content.turn.prepare" => preparation::turn(
                service.as_ref(),
                bound,
                &input["snapshot"],
                &input["turnId"],
                revision,
            ),
            "content.usage" => {
                Ok(
                    preparation::usage(&input["threadId"], &input["turnId"], &input["metadata"])?
                        .unwrap_or(Value::Null),
                )
            }
            "content.usage.reconcile" => {
                let (evidence, totals) =
                    preparation::reconcile_usage(input.get("previous"), &input["incoming"])?;
                Ok(json!({"evidence":evidence,"totals":totals}))
            }
            "content.attribution" => Ok(canonical::model_attribution(
                &input["threadId"],
                &input["turnId"],
                &input["metadata"],
            )
            .unwrap_or(Value::Null)),
            "content.message.protect" => {
                canonical::protect_message(service.as_ref(), &input["id"], &input["message"])
            }
            "content.message.open" => {
                let key = service.material(input.get("keyRevision").and_then(Value::as_u64))?;
                canonical::open_message(&key.key, &Value::String(key.owner_id), &input["message"])
            }
            "content.prepare" => canonical::prepare_item(
                service.as_ref(),
                bound,
                &input["rendered"],
                &input["mapping"],
                revision,
                &input["order"],
                &input["attachments"],
            ),
            "content.communication.protect" => {
                let key = service.material(input["context"]["keyRevision"].as_u64())?;
                crypto::encrypt_communication(
                    kind(&input)?,
                    &key.key,
                    &input["context"],
                    &input["content"],
                )
            }
            "content.communication.open" => {
                let key = service.material(input["context"]["keyRevision"].as_u64())?;
                crypto::decrypt_communication(
                    kind(&input)?,
                    &key.key,
                    &input["context"],
                    &input["encrypted"],
                    input.get("classification"),
                )
            }
            "content.archive.items" => {
                archive::open_items(service.as_ref(), &input["page"], Some(&check))
            }
            "content.archive.turns" => {
                archive::open_turns(service.as_ref(), &input["page"], Some(&check))
            }
            "content.archive.batches" => {
                archive::open_batches(service.as_ref(), &input["page"], Some(&check))
            }
            _ => bail!("Unknown history content fixture operation"),
        }
    })
    .await?
}
