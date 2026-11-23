//! Development JSON driver for the actual authenticated native history client.
//! All credentials/profiles supplied by its tests are disposable fixture data.
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::BatchRejected;
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    history::client::{Client, Options, ServerRequestError},
    metadata::{Abort, DelayAborted, Signal},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
fn signal(input: &Value, prefix: &str) -> Option<Signal> {
    let delay = input[format!("{prefix}AbortAfterMs").as_str()].as_u64();
    let immediate = input[format!("{prefix}Aborted").as_str()] == true;
    if delay.is_none() && !immediate {
        return None;
    }
    let (abort, signal) = Abort::new();
    let reason = input[format!("{prefix}Reason").as_str()]
        .as_str()
        .unwrap_or("fixture cancelled")
        .to_owned();
    if immediate {
        abort.abort(anyhow!(reason));
    } else {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay.unwrap())).await;
            abort.abort(anyhow!(reason));
        });
    }
    Some(signal)
}
async fn run(input: &Value) -> Result<Value> {
    let caller = signal(input, "caller");
    let transport = signal(input, "transport");
    let tokens = input["tokens"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![input["token"].clone()]);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let client = Client::new(Options {
        server_url: input["serverUrl"].as_str().unwrap().to_owned(),
        worker_id: input["workerId"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| "worker".into()),
        token: Arc::new(move || {
            let index = count.fetch_add(1, Ordering::SeqCst);
            Ok(tokens
                .get(index)
                .or_else(|| tokens.last())
                .and_then(Value::as_str)
                .unwrap_or("synthetic-token")
                .to_owned())
        }),
        metadata_signal: Some(Arc::new(move || transport.clone())),
    })?;
    if input["action"] == "liveOutput" {
        use cantrip_worker::history::live::{identity, mode};
        let scope = input["input"]["scope"].clone();
        let snapshot = input["input"]["snapshot"].clone();
        let mode = mode::Resolver::new(
            Arc::new(move |thread| {
                let snapshot = snapshot.clone();
                Box::pin(async move { cantrip_history::native::snapshot(&snapshot, &thread) })
            }),
            None,
        );
        let resolver = identity::Managed::new(identity::Options {
            client: Arc::new(client),
            scope: Arc::new(move |_, _| {
                let scope = scope.clone();
                Box::pin(async { Ok(Some(scope)) })
            }),
            mode: identity::with_mode(mode),
            signal: caller,
        });
        let first = resolver.resolve(input["input"]["output"].clone());
        let second = resolver.resolve(input["input"]["output"].clone());
        let (first, second) = futures::try_join!(first, second)?;
        return Ok(json!({"outputs":vec![first,second],"requests":calls.load(Ordering::SeqCst)}));
    }
    let body = &input["input"];
    let pending = match input["action"].as_str().unwrap() {
        "open" => client.open(body, caller),
        "resolve" => client.resolve(body, caller),
        "ingest" => client.ingest(body, caller),
        "archive" => client.archive(body, caller),
        "archiveTurns" => client.archive_turns(body, caller),
        "archiveBatches" => client.archive_batches(body, caller),
        "deliver" => client.deliver(
            &input["scope"],
            &input["record"],
            input["body"].as_js_string().unwrap(),
            caller,
        ),
        _ => bail!("Unknown history client fixture action"),
    };
    if input["abandon"] == true {
        drop(pending);
        return Ok(Value::Null);
    }
    pending.await
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let input = parse_json_text(&line).map_err(|error| anyhow!("{}", error.lossy()))?;
        let result = match run(&input).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => {
                let rejected = error.downcast_ref::<BatchRejected>();
                let http = error.downcast_ref::<ServerRequestError>();
                json!({"ok":false,"error":cantrip_worker::error::message(&error),"status":rejected.map(|_|409).or_else(||http.map(|v|v.status)),"code":rejected.map(|v|v.rejection()["code"].clone()).or_else(||http.and_then(|v|v.code.clone().map(Value::String))).or_else(||error.is::<DelayAborted>().then(||json!("ABORT_ERR"))).unwrap_or(Value::Null),"rejected":rejected.is_some()})
            }
        };
        output
            .write_all((result.stringify() + "\n").as_bytes())
            .await?;
        output.flush().await?;
    }
    Ok(())
}
