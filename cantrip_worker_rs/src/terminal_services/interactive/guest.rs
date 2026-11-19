use super::{Display, Entry, Location, Resize};
use crate::{cantrip_os::terminal::Pty, terminal_services::output::Utf8};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{Value, value::json};
use codex_utils_pty::TerminalSize;
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};

pub(super) fn spawn(
    mut pty: Pty,
    location: Location,
    size: TerminalSize,
    exited: impl FnOnce(&Value) + Send + 'static,
) -> (Entry, impl Future<Output = ()> + Send + 'static) {
    let (stop, stopping) = watch::channel(false);
    let (finished, done) = watch::channel(false);
    let (resize, sizes) = mpsc::channel(64);
    let (writer, input) = mpsc::channel(64);
    let state = Arc::new(Mutex::new(Display::new(size)));
    let entry = Entry {
        location,
        stop,
        done,
        writer,
        resize,
        state: state.clone(),
    };
    let actor = async move {
        let result = match drive(&mut pty, stopping, input, sizes, &state).await {
            Ok(result) => result,
            Err(_) => {
                // A lost carrier is evidence of uncertainty. Retaining native.json
                // allows a later connection to observe that exact process.
                let _ = pty.observe_outcome("unknown");
                state.lock().unwrap().write(
                    "\r\n[The Linux terminal connection ended. Its outcome is unknown.]\r\n",
                );
                json!({"status":"exited","exitCode":198,"signal":Value::Null,"executionOutcome":"unknown"})
            }
        };
        pty.disconnect().await;
        state.lock().unwrap().finish(result.clone());
        exited(&result);
        finished.send_replace(true);
    };
    (entry, actor)
}

async fn drive(
    pty: &mut Pty,
    mut stopping: watch::Receiver<bool>,
    mut input: mpsc::Receiver<Vec<u8>>,
    mut sizes: mpsc::Receiver<Resize>,
    state: &Mutex<Display>,
) -> Result<Value> {
    let mut cursor = None;
    let mut text = Utf8::default();
    let mut termination = None;
    loop {
        // Complete each request before reading the next frame on this carrier.
        // Guest reads use a short wait so typing, resize and Stop can proceed.
        let page = tokio::select! {
            _ = stopping.changed(), if termination.is_none() => {
                pty.terminate().await?;
                termination = Some(Instant::now() + Duration::from_secs(10));
                continue;
            }
            Some(bytes) = input.recv(), if termination.is_none() => {
                pty.write(&bytes).await?;
                continue;
            }
            Some(request) = sizes.recv(), if termination.is_none() => {
                let result = pty.resize(request.size).await;
                if result.is_ok() {
                    state.lock().unwrap().replay.resize(request.size);
                }
                let _ = request.complete.send(result);
                continue;
            }
            _ = std::future::ready(()) => pty.read(cursor, 200).await?,
        };
        let evicted = page["outputEvictedThroughSeq"].as_u64();
        if let Some(end) = evicted.filter(|&end| end > cursor.unwrap_or(0)) {
            let mut display = state.lock().unwrap();
            display.write(&text.finish());
            display.write(&format!(
                "\r\n[Earlier Linux command output through native sequence {end} was evicted; the command was not repeated.]\r\n"
            ));
        } else if cursor.is_none() && pty.recovering && evicted.is_none() {
            state.lock().unwrap().write("\r\n[This executor does not report output retention coverage; earlier command history may be unavailable.]\r\n");
        }
        let next = page["nextSeq"]
            .as_u64()
            .context("Invalid Linux terminal output cursor.")?
            .saturating_sub(1);
        ensure!(
            next >= cursor.unwrap_or(0),
            "The Linux terminal output cursor moved backwards."
        );
        cursor = Some(next);
        let chunks = page["chunks"]
            .as_array()
            .context("Invalid Linux terminal output.")?;
        for chunk in chunks {
            let encoded = chunk["chunk"]
                .as_str()
                .context("Invalid Linux terminal output bytes.")?;
            let bytes = STANDARD.decode(encoded)?;
            state.lock().unwrap().write(&text.push(&bytes));
        }
        if page["exited"] == true && page["closed"] == true && chunks.is_empty() {
            state.lock().unwrap().write(&text.finish());
            return pty.finish(&page["exitCode"], termination.is_some());
        }
        ensure!(
            page["failure"].is_null() && (page["closed"] != true || page["exited"] == true),
            "The Linux terminal closed without a confirmed exit."
        );
        ensure!(
            termination.is_none_or(|deadline| Instant::now() < deadline),
            "Linux terminal termination outcome is unknown."
        );
    }
}
