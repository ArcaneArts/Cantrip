//! Disposable IPC access to the real native public HTTP client and cache.
use anyhow::{Context, Result};
use cantrip_server::{
    settings::openrouter::{CatalogCache, HttpCatalogFetcher},
    wire::Value,
};
use std::{
    io::{self, BufRead, Write},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[tokio::main]
async fn main() -> Result<()> {
    let clock = Arc::new(AtomicU64::new(1000_f64.to_bits()));
    let read_clock = Arc::clone(&clock);
    let cache = CatalogCache::with_options(
        Arc::new(HttpCatalogFetcher::new()?),
        Arc::new(move || f64::from_bits(read_clock.load(Ordering::SeqCst))),
        100.0,
    );
    let mut output = io::stdout().lock();
    writeln!(
        output,
        "{{\"event\":\"server.listening\",\"origin\":\"openrouter-http-fixture\"}}"
    )?;
    output.flush()?;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        clock.store(
            request["now"].as_f64().context("fixture clock")?.to_bits(),
            Ordering::SeqCst,
        );
        let read = cache
            .read(
                &request["baseUrl"]
                    .as_js_string()
                    .context("fixture URL")?
                    .lossy(),
                request["key"].as_str().context("fixture key")?,
                request["force"] == true,
            )
            .await;
        let value = match read {
            Ok(read) => Value::object([
                ("snapshot", Value::from_serialize(&*read.snapshot)),
                ("servedStale", Value::Bool(read.served_stale)),
                ("background", Value::Bool(read.background_refresh.is_some())),
            ]),
            Err(error) => Value::object([("error", Value::String(error.0.clone()))]),
        };
        let reply = Value::object([
            ("id", request["id"].clone()),
            ("rejected", Value::Bool(false)),
            ("value", value),
        ]);
        writeln!(output, "{}", reply.stringify())?;
        output.flush()?;
    }
    cache.drain().await;
    Ok(())
}
