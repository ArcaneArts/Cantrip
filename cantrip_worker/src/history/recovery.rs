//! Coherent authenticated archive recovery; no checkpoint or input authority.
use super::client::{Client, ServerRequestError};
use crate::{
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Result, bail};
use cantrip_history::{archive, content::Encryption};
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{Value, value::json};
use futures::future::BoxFuture;
use std::sync::Arc;
#[derive(Default)]
pub struct Options {
    pub signal: Option<Signal>,
    pub page_size: Option<Value>,
    pub batch_page_size: Option<Value>,
    pub on_retry: Option<Arc<dyn Fn(u64) -> Result<()> + Send + Sync>>,
}
fn active(signal: &Option<Signal>) -> Result<()> {
    if let Some(signal) = signal {
        signal.check()?;
    }
    Ok(())
}
pub fn read(
    binding: &Value,
    client: Client,
    service: Arc<dyn Encryption>,
    options: Options,
) -> BoxFuture<'static, Result<Value>> {
    let binding = binding.clone();
    owned(async move {
        let binding = checked("nativeHistoryBindingSchema", &binding)?;
        let mut attempts = 0;
        loop {
            active(&options.signal)?;
            let result = attempt(&binding, &client, service.clone(), &options).await;
            match result {
                Ok(value) => return Ok(value),
                Err(error) => {
                    active(&options.signal)?;
                    if !error
                        .downcast_ref::<ServerRequestError>()
                        .is_some_and(|error| {
                            error.status == 409
                                && error
                                    .code
                                    .as_ref()
                                    .is_some_and(|code| code == &"archive-snapshot-changed".into())
                        })
                    {
                        return Err(error);
                    }
                    attempts += 1;
                    if let Some(report) = &options.on_retry {
                        let _ = report(attempts);
                    }
                    active(&options.signal)?;
                    Guard::request(options.signal.clone()).delay(100).await?;
                }
            }
        }
    })
}
async fn attempt(
    binding: &Value,
    client: &Client,
    service: Arc<dyn Encryption>,
    options: &Options,
) -> Result<Value> {
    let mut snapshot: Option<Value> = None;
    let mut resources = Vec::new();
    for action in ["items", "turns", "batches"] {
        let mut pages = Vec::new();
        let mut cursor = Value::Null;
        loop {
            active(&options.signal)?;
            let mut request =
                json!({"chatId":binding["chatId"],"bindingId":binding["id"],"cursor":cursor});
            if let Some(snapshot) = &snapshot {
                request["snapshotId"] = snapshot.clone();
            }
            if let Some(limit) = if action == "batches" {
                &options.batch_page_size
            } else {
                &options.page_size
            } {
                request["limit"] = limit.clone();
            }
            let page = match action {
                "items" => client.archive(&request, options.signal.clone()).await?,
                "turns" => {
                    client
                        .archive_turns(&request, options.signal.clone())
                        .await?
                }
                _ => {
                    client
                        .archive_batches(&request, options.signal.clone())
                        .await?
                }
            };
            active(&options.signal)?;
            if ["id", "chatId", "threadId", "workerId"]
                .iter()
                .any(|key| page["binding"][key] != binding[key])
                || snapshot
                    .as_ref()
                    .is_some_and(|id| page["snapshotId"] != *id)
            {
                bail!("Native history recovery returned an unrelated or inconsistent snapshot.");
            }
            snapshot = Some(page["snapshotId"].clone());
            cursor = page["nextCursor"].clone();
            pages.push(page);
            if cursor.is_null() {
                break;
            }
        }
        resources.push((action, pages));
    }
    // Decryption starts only after every resource shares one committed snapshot.
    let mut result = json!({"binding":binding,"snapshotId":snapshot.unwrap()});
    for (action, pages) in resources {
        let mut entries = Vec::new();
        for page in pages {
            active(&options.signal)?;
            let service = service.clone();
            let signal = options.signal.clone();
            let opened = tokio::task::spawn_blocking(move || {
                let check = || active(&signal);
                match action {
                    "items" => archive::open_items(service.as_ref(), &page, Some(&check)),
                    "turns" => archive::open_turns(service.as_ref(), &page, Some(&check)),
                    _ => archive::open_batches(service.as_ref(), &page, Some(&check)),
                }
            })
            .await??;
            entries.extend(opened[action].as_array().unwrap().iter().cloned());
        }
        result[action] = Value::Array(entries);
    }
    active(&options.signal)?;
    Ok(result)
}
