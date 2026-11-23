//! A standalone consumer of the extracted libraries, with no server or worker.
use anyhow::{Result, anyhow, ensure};
use cantrip_config::{Environment, Reader, env_file};
use cantrip_framing::remote_surface;
use cantrip_host::{files, publish};
use cantrip_logging::{log_archive, logging::Emitter, runtime::Runtime};
use cantrip_transport::{
    correlation::{Correlation, Delivery},
    output::Buffered,
};
use cantrip_wire::{Value, payload_digest, value::json};
use std::sync::Arc;

fn validated(schema: &str, input: &Value) -> Result<Value> {
    cantrip_protocol::parse(schema, Some(input)).map_err(|error| anyhow!("{error:?}"))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let environment: Environment = env_file::parse("EXAMPLE_NAME=consumer\n")
        .into_iter()
        .collect();
    let system = Reader(&environment).text("EXAMPLE_NAME", "consumer");
    let schedule = validated(
        "projectAutomationIntervalScheduleSchema",
        &json!({
            "kind":"interval", "every":1, "unit":"minute", "startsAt":"2026-01-01T00:00:00.000Z"
        }),
    )?;
    let start = cantrip_wire::date::parse(&"2026-01-01T00:00:00.000Z".into()).unwrap();
    let occurrence = cantrip_scheduling::next(&schedule, start)?.unwrap();
    ensure!(occurrence == start + 60_000);

    let header = validated(
        "remoteSurfaceFrameHeaderSchema",
        &json!({
            "protocolVersion":1, "surfaceId":"example", "attachmentId":"example",
            "sequence":0, "channel":"control"
        }),
    )?;
    let frame = remote_surface::create(header, b"opaque example payload")?;
    let buffered = Buffered::default();
    let mut queued = buffered
        .bounded(frame.clone(), frame.bytes().len(), 1024)
        .unwrap();
    let forwarded = queued.take();
    let decoded = remote_surface::decode(Arc::from(forwarded.bytes()))?;
    ensure!(decoded.payload() == b"opaque example payload");
    drop(queued);
    ensure!(buffered.bytes() == 0);
    let digest = payload_digest(&json!({"header":decoded.header(), "nextAt":occurrence}));

    let scratch = tempfile::tempdir()?;
    let staging = scratch.path().join("staging");
    files::private_directory(&staging)?;
    files::write_private(&staging.join("digest.txt"), digest.as_bytes())?;
    publish::directory(&staging, &scratch.path().join("published"))?;

    let runtime = Arc::new(Runtime::new(Arc::new(|| "info".into())));
    runtime
        .initialize(
            log_archive::Options::new(system.clone(), scratch.path().join("logs"), vec![]),
            false,
        )
        .await;
    let output = runtime.clone();
    let emitter = Emitter::with_console_context(
        system.into(),
        Arc::new(move || start as f64),
        Arc::new(move |record, fields| output.capture_with_undefined(record, fields)),
    );
    emitter.event(
        "info",
        &"Shared library consumer completed".into(),
        Some(&json!({"event":"consumer.completed"})),
    )?;
    runtime.close().await;

    let (correlation, result, mut delivery) = Correlation::<Value, Value>::channel();
    correlation.event(json!({"digest":digest}));
    correlation.response(json!({"nextAt":occurrence}));
    while let Some(message) = delivery.recv().await {
        match message {
            Delivery::Event(event) => ensure!(event["digest"] == digest),
            Delivery::Response(response) => correlation.finish(response, |_| {}),
            Delivery::Finished => break,
        }
    }
    ensure!(result.await?["nextAt"].as_i64() == Some(occurrence));
    println!(
        "{}",
        json!({"sharedConsumer":"passed", "cratesUsed":8, "digest":digest}).stringify()
    );
    Ok(())
}
