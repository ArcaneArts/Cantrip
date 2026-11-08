//! Development-only driver of the actual filesystem archive; never packaged.
use anyhow::{Context, Result};
use cantrip_server::{
    operations::log_archive::{Archive, Options},
    wire::Value,
};
use serde_json::json;
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};

fn main() -> Result<()> {
    let mut archive: Option<Archive> = None;
    let clock = Arc::new(AtomicI64::new(0));
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        if let Some(now) = request["now"].as_i64() {
            clock.store(now, Ordering::Relaxed);
        }
        let result = match request["op"].as_str().context("operation")? {
            "open" => {
                let mut options = Options::server(
                    PathBuf::from(request["directory"].as_str().context("directory")?),
                    serde_json::from_str(&request["legacy"].stringify())?,
                );
                options.source = request["source"].as_str().unwrap_or("server").into();
                options.max_bytes = request["maxBytes"].as_u64().unwrap_or(options.max_bytes);
                options.part_bytes = request["partBytes"].as_u64().unwrap_or(options.part_bytes);
                options.compression_age_ms = request["compressionAgeMs"]
                    .as_i64()
                    .unwrap_or(options.compression_age_ms);
                let clock = clock.clone();
                options.clock = Arc::new(move || clock.load(Ordering::Relaxed));
                Archive::new(options).map(|value| {
                    archive = Some(value);
                })
            }
            operation => {
                let archive = archive.as_mut().context("open archive")?;
                match operation {
                    "initialize" => archive.initialize(),
                    "append" => archive.append(&request["record"]),
                    "maintain" => archive.maintain(),
                    "close" => {
                        archive.close();
                        Ok(())
                    }
                    _ => anyhow::bail!("unknown operation"),
                }
            }
        };
        let next = archive
            .as_mut()
            .and_then(|archive| archive.next_delay_ms.take());
        println!(
            "{}",
            json!({"ok":result.is_ok(),"error":result.err().map(|error|error.to_string()),"scheduledDelayMs":next})
        );
        io::stdout().flush()?;
    }
    Ok(())
}
