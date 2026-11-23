use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{
    tunnels::broker::{Broker, Handle, Options, Registration, SendFrame, Side},
    wire::Value,
};
use indexmap::IndexMap;
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
fn value(v: impl serde::Serialize) -> Value {
    Value::from_serialize(&v)
}
#[derive(Default)]
struct Flags {
    now: Mutex<f64>,
    active: AtomicBool,
    consume: AtomicBool,
    activity_revoke: AtomicBool,
    send_revoke: AtomicBool,
    source_send: AtomicBool,
    destination_send: AtomicBool,
}
fn execute(input: &Value, base: &Value, target: &Value) -> Result<Value> {
    let flags = Arc::new(Flags::default());
    for flag in [
        &flags.active,
        &flags.consume,
        &flags.source_send,
        &flags.destination_send,
    ] {
        flag.store(true, Ordering::SeqCst);
    }
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let holder = Arc::new(Mutex::new(None::<Weak<Broker>>));
    let mut options = Options::default();
    for (name, field) in [
        ("idleTimeoutMs", &mut options.idle_ms),
        ("maxLifetimeMs", &mut options.lifetime_ms),
        ("maxBytesPerSecond", &mut options.bytes_per_second),
        ("maxConnections", &mut options.max_connections),
        (
            "maxConnectionsPerTunnel",
            &mut options.max_connections_per_tunnel,
        ),
        ("maxRoutes", &mut options.max_routes),
    ] {
        if let Some(value) = input["options"][name].as_f64() {
            *field = value;
        }
    }
    options.clock = {
        let flags = flags.clone();
        Arc::new(move || *flags.now.lock().unwrap())
    };
    options.activity = {
        let (flags, trace, holder) = (flags.clone(), trace.clone(), holder.clone());
        Arc::new(move |tunnel, attachment| {
            trace.lock().unwrap().push(Value::object([
                ("event", value("activity")),
                ("tunnelId", tunnel.clone()),
                ("attachmentId", attachment.clone()),
            ]));
            if flags.activity_revoke.swap(false, Ordering::SeqCst) {
                let broker = holder.lock().unwrap().as_ref().and_then(Weak::upgrade);
                if let Some(broker) = broker {
                    broker.revoke_attachment(attachment);
                }
            }
            flags.active.load(Ordering::SeqCst)
        })
    };
    options.consume = {
        let (flags, trace) = (flags.clone(), trace.clone());
        Arc::new(move |owner, worker, bytes| {
            trace.lock().unwrap().push(Value::object([
                ("event", value("consume")),
                ("ownerId", owner.clone()),
                ("workerId", worker.clone()),
                ("bytes", value(bytes)),
            ]));
            flags.consume.load(Ordering::SeqCst)
        })
    };
    let broker = Broker::new(options);
    *holder.lock().unwrap() = Some(Arc::downgrade(&broker));
    let sender = |side: Side| -> SendFrame {
        let (trace, flags, holder) = (trace.clone(), flags.clone(), holder.clone());
        Arc::new(move |header, payload| {
            trace.lock().unwrap().push(Value::object([
                ("event", value("send")),
                (
                    "side",
                    value(if side == Side::Source {
                        "source"
                    } else {
                        "destination"
                    }),
                ),
                ("header", header.clone()),
                ("payload", value(STANDARD.encode(payload))),
            ]));
            if flags.send_revoke.swap(false, Ordering::SeqCst) {
                let broker = holder.lock().unwrap().as_ref().and_then(Weak::upgrade);
                if let Some(broker) = broker {
                    broker.revoke_attachment(&header["attachmentId"]);
                }
            }
            if side == Side::Source {
                flags.source_send.load(Ordering::SeqCst)
            } else {
                flags.destination_send.load(Ordering::SeqCst)
            }
        })
    };
    let mut handles = IndexMap::<String, Handle>::new();
    let mut observations = Vec::new();
    for action in input["actions"].as_array().context("Broker actions")? {
        let mut result = Value::Null;
        let name = action["name"].as_str().unwrap_or("main");
        match action["op"].as_str().context("Broker operation")? {
            "register" => {
                let registration = Registration {
                    tunnel: action
                        .get("tunnelId")
                        .cloned()
                        .unwrap_or_else(|| value("tunnel")),
                    attachment: action
                        .get("attachmentId")
                        .cloned()
                        .unwrap_or_else(|| value("attachment")),
                    source: value("desktop"),
                    destination: value(if action["equal"] == true {
                        "desktop"
                    } else {
                        "worker"
                    }),
                    target: target.clone(),
                    owner: Some(value("owner")),
                    worker: Some(value("worker")),
                    diagnostic: action.get("diagnosticTraceId").cloned(),
                    send_source: sender(Side::Source),
                    send_destination: sender(Side::Destination),
                };
                match broker.register(registration) {
                    Ok(handle) => {
                        handles.insert(name.into(), handle);
                    }
                    Err(error) => result = Value::object([("error", value(error.to_string()))]),
                }
            }
            "frame" => {
                let mut header = base.clone();
                if let Value::Object(fields) = &mut header {
                    for (key, item) in action["header"].as_object().context("Frame header")? {
                        fields.insert(key.clone(), item.clone());
                    }
                }
                let payload = if let Some(items) = action["payload"].as_array() {
                    items
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect::<Vec<_>>()
                } else {
                    vec![91; action["payloadLength"].as_u64().unwrap_or(0) as usize]
                };
                let side = if action["side"] == "destination" {
                    Side::Destination
                } else {
                    Side::Source
                };
                for handle in handles.values().cloned().collect::<Vec<_>>() {
                    if handle.is_active() {
                        handle.receive(side, &header, &payload);
                    }
                }
            }
            "close-handle" => {
                if let Some(handle) = handles.get(name) {
                    handle.close();
                }
            }
            "disconnect" => {
                for handle in handles.values().cloned().collect::<Vec<_>>() {
                    if handle.is_active() {
                        handle.disconnect();
                    }
                }
            }
            "revoke" => {
                result =
                    value(broker.revoke_attachment(
                        action.get("attachmentId").unwrap_or(&value("attachment")),
                    ))
            }
            "activity" => {
                result = value(broker.record_activity(
                    action.get("tunnelId").unwrap_or(&value("tunnel")),
                    action.get("attachmentId").unwrap_or(&value("attachment")),
                ))
            }
            "flags" => {
                if let Some(now) = action["now"].as_f64() {
                    *flags.now.lock().unwrap() = now;
                }
                for (key, flag) in [
                    ("active", &flags.active),
                    ("consume", &flags.consume),
                    ("activityRevoke", &flags.activity_revoke),
                    ("sendRevoke", &flags.send_revoke),
                    ("sourceSend", &flags.source_send),
                    ("destinationSend", &flags.destination_send),
                ] {
                    if let Some(v) = action[key].as_bool() {
                        flag.store(v, Ordering::SeqCst);
                    }
                }
            }
            "sweep" => broker.sweep(action["now"].as_f64()),
            "close" => broker.close(),
            other => anyhow::bail!("Unknown broker action {other}"),
        }
        observations.push(Value::object([
            ("result", result),
            ("trace", Value::Array(trace.lock().unwrap().clone())),
            ("stats", broker.stats()),
        ]));
    }
    broker.close();
    Ok(Value::Array(observations))
}
#[test]
fn stream_state_and_reentrant_callbacks_match_actual_broker() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/tunnel-broker-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Broker oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let vectors: Value = serde_json::from_slice(&output.stdout)?;
    let mut steps = 0;
    for scenario in vectors["scenarios"]
        .as_array()
        .context("Broker scenarios")?
    {
        let actual = execute(&scenario["input"], &vectors["base"], &vectors["target"])?;
        let expected = scenario["outcome"]
            .as_array()
            .context("Broker observations")?;
        assert_eq!(
            actual.as_array().unwrap().len(),
            expected.len(),
            "{} step count",
            scenario["name"]
        );
        for (index, (actual, expected)) in
            actual.as_array().unwrap().iter().zip(expected).enumerate()
        {
            assert_eq!(actual, expected, "{} step {index}", scenario["name"]);
            steps += 1;
        }
    }
    println!("{steps} actual broker transitions and callback/byte/stat snapshots matched");
    Ok(())
}
