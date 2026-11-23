//! Development-only RPC driver for the real Redis coordinator, never packaged.
use anyhow::{Context, Result, bail};
use cantrip_server::{
    coordination::{Options, RedisCoordinator},
    wire::{JsString, Value, parse_json_text},
};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

type Events = Arc<Mutex<Vec<Value>>>;
fn text(r: &Value, key: &str) -> JsString {
    r[key].as_js_string().expect("Fixture string").clone()
}
fn event(kind: &str) -> Value {
    Value::object([("kind", Value::String(kind.into()))])
}
fn record(events: &Events, kind: &str) {
    events.lock().unwrap().push(event(kind));
}
fn message(mut value: Value) -> Value {
    if let Some(payload) = value["payloadBase64"].as_str()
        && payload.len() > 4096
    {
        value["payloadBase64"] = Value::object([
            ("bytes", Value::Number(payload.len() as f64)),
            (
                "sha256",
                Value::String(format!("{:x}", Sha256::digest(payload.as_bytes())).into()),
            ),
        ]);
    }
    value
}
async fn dispatch(c: &Arc<RedisCoordinator>, events: &Events, r: &Value) -> Result<Value> {
    let result = match r["op"].as_str().unwrap_or("") {
        "start" => {
            c.start().await?;
            Value::Null
        }
        "close" => {
            c.close().await?;
            Value::Null
        }
        "events" => Value::Array(std::mem::take(&mut *events.lock().unwrap())),
        "stats" => c.stats(),
        "health" => Value::Bool(c.health().await?),
        "cachedWorker" => c.cached_worker(&text(r, "workerId")).unwrap_or(Value::Null),
        "findWorker" => c
            .find_worker(&text(r, "workerId"))
            .await?
            .unwrap_or(Value::Null),
        "claimWorker" => c
            .claim_worker(r["input"].clone())
            .await?
            .unwrap_or(Value::Null),
        "refreshWorker" => Value::Bool(
            c.refresh_worker(&text(r, "workerId"), &text(r, "connectionId"))
                .await?,
        ),
        "releaseWorker" => Value::Bool(
            c.release_worker(&text(r, "workerId"), &text(r, "connectionId"))
                .await?,
        ),
        "findSession" => c
            .find_worker_link_session(&text(r, "sessionId"))
            .await?
            .unwrap_or(Value::Null),
        "claimSession" => c
            .claim_worker_link_session(r["claim"].clone())
            .await?
            .unwrap_or(Value::Null),
        "refreshSession" => Value::Bool(c.refresh_worker_link_session(r["claim"].clone()).await?),
        "releaseSession" => Value::Bool(
            c.release_worker_link_session(&text(r, "sessionId"), &text(r, "authorityInstanceId"))
                .await?,
        ),
        "publish" => {
            c.publish(
                r["payload"].clone(),
                r.get("ttl").map(|v| v.as_f64().unwrap_or(f64::NAN)),
            )
            .await?;
            Value::Null
        }
        "blockingListener" => {
            let signal = Arc::new(tokio::sync::Notify::new());
            let events = events.clone();
            c.subscribe(Arc::new(move |value| {
                let signal = signal.clone();
                let events = events.clone();
                Box::pin(async move {
                    if value["kind"] == "await-next" {
                        record(&events, "blocked");
                        signal.notified().await;
                        record(&events, "resumed");
                    }
                    if value["kind"] == "unblock" {
                        record(&events, "unblock");
                        signal.notify_one();
                    }
                    Ok(())
                })
            }));
            Value::Null
        }
        "mutatingListeners" => {
            let removed = Arc::new(Mutex::new(0));
            let events_late = events.clone();
            let late: cantrip_server::coordination::Listener = Arc::new(move |_| {
                record(&events_late, "late");
                Box::pin(async { Ok(()) })
            });
            let weak = Arc::downgrade(c);
            let removed_id = removed.clone();
            c.subscribe(Arc::new(move |value| {
                if value["kind"] == "mutate-listeners"
                    && let Some(c) = weak.upgrade()
                {
                    c.unsubscribe(*removed_id.lock().unwrap());
                    c.subscribe(late.clone());
                }
                Box::pin(async { Ok(()) })
            }));
            let events = events.clone();
            *removed.lock().unwrap() = c.subscribe(Arc::new(move |_| {
                record(&events, "removed");
                Box::pin(async { Ok(()) })
            }));
            Value::Null
        }
        "failingListener" => {
            c.subscribe(Arc::new(|value| {
                Box::pin(async move {
                    if value["kind"] == "listener-error" {
                        bail!("Controlled callback failure");
                    }
                    Ok(())
                })
            }));
            let events = events.clone();
            c.subscribe(Arc::new(move |value| {
                if value["kind"] == "listener-error" {
                    record(&events, "after-error");
                }
                Box::pin(async { Ok(()) })
            }));
            Value::Null
        }
        _ => bail!("Unknown fixture operation"),
    };
    Ok(result)
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let events: Events = Arc::default();
    let mut coordinator = None;
    while let Some(line) = lines.next_line().await? {
        let request =
            parse_json_text(&line).map_err(|_| anyhow::anyhow!("Fixture request JSON"))?;
        let result = if request["op"] == "init" {
            let config = &request["options"];
            let mut options = Options::new(
                text(config, "url").as_str().unwrap().into(),
                text(config, "instanceId").as_str().unwrap().into(),
            );
            if let Some(prefix) = config["keyPrefix"].as_str() {
                options.key_prefix = prefix.into();
            }
            if let Some(ttl) = config["presenceTtlMs"].as_u64() {
                options.presence_ttl_ms = ttl;
            }
            if let Some(limit) = config["maximumInstances"].as_u64() {
                options.maximum_instances = limit;
            }
            let c = RedisCoordinator::new(options)?;
            let recorded = events.clone();
            c.subscribe(Arc::new(move |value| {
                recorded.lock().unwrap().push(Value::object([
                    ("kind", Value::String("message".into())),
                    ("value", message(value)),
                ]));
                Box::pin(async { Ok(()) })
            }));
            let result = c.start().await.map(|_| Value::Null);
            coordinator = Some(c);
            result
        } else {
            dispatch(
                coordinator.as_ref().context("Initialized coordinator")?,
                &events,
                &request,
            )
            .await
        };
        let mut response = Value::object([("id", request["id"].clone())]);
        match result {
            Ok(value) => response["result"] = value,
            Err(error) => response["error"] = Value::String(error.to_string().into()),
        }
        output.write_all(response.stringify().as_bytes()).await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    if let Some(c) = coordinator {
        c.close().await?;
    }
    Ok(())
}
