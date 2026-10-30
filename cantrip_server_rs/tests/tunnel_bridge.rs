use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{
    operations::logging::Policy,
    tunnels::frame,
    wire::Value,
    workers::bridge::{
        Continuity, Outgoing, Peer, TunnelFrameHandler, TunnelFrameSubscription, WorkerBridge,
    },
};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
fn value(v: impl serde::Serialize) -> Value {
    Value::from_serialize(&v)
}
fn identity() -> Continuity {
    Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "generation".into(),
    }
}
#[tokio::test]
async fn ordered_tunnel_delivery_buffering_and_logging_match_actual_bridge() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/tunnel-bridge-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Tunnel bridge oracle: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout)?;
    let logs = Arc::new(Mutex::new(Vec::new()));
    let bridge = WorkerBridge::with_usage_and_logger(Duration::ZERO, None, {
        let logs = logs.clone();
        Arc::new(move |call| {
            let Policy::Repeated { key, options } = call.policy else {
                panic!("Expected bounded repeated log");
            };
            logs.lock().unwrap().push(Value::object([
                ("key", value(key)),
                ("level", value(call.level)),
                ("message", value(call.message)),
                ("context", call.context),
                ("options", options.unwrap_or(Value::Null)),
            ]));
        })
    });
    assert_eq!(
        value(bridge.send_tunnel_frame("missing", Value::Null, &[1, 2, 3])),
        expected["offline"]
    );
    let (peer, mut output) = Peer::new(identity());
    assert!(bridge.attach(
        "worker",
        peer.clone(),
        Some("x".repeat(8 * 1024 * 1024 - 10))
    ));
    let header = expected["header"].clone();
    let mut curve = vec![
        value(peer.buffered_amount()),
        value(bridge.send_tunnel_frame("worker", header.clone(), &[1, 2, 3])),
        value(peer.buffered_amount()),
        value(bridge.send_tunnel_frame("worker", header.clone(), &[1, 2, 3])),
    ];
    drop(output.recv().await.unwrap());
    curve.extend([
        value(peer.buffered_amount()),
        value(bridge.send_tunnel_frame("worker", header.clone(), &[1, 2, 3])),
        value(peer.buffered_amount()),
    ]);
    let Some(Outgoing::Tunnel(mut first)) = output.recv().await else {
        panic!("Expected CTTN frame");
    };
    let forwarded = first.take();
    let during_write = peer.buffered_amount();
    tokio::task::yield_now().await;
    assert_eq!(peer.buffered_amount(), during_write);
    assert_eq!(
        value(STANDARD.encode(forwarded.bytes())),
        expected["forwarded"]
    );
    drop(first);
    drop(output.recv().await.unwrap());
    curve.push(value(peer.buffered_amount()));
    assert_eq!(Value::Array(curve), expected["bufferCurve"]);
    assert_eq!(
        value(bridge.send_tunnel_frame("worker", header.clone(), &[])),
        expected["invalidSend"]
    );
    let frame = frame::create(header, &[1, 2, 3])?;
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let b = Arc::new(Mutex::new(None::<TunnelFrameSubscription>));
    let c = Arc::new(Mutex::new(None::<TunnelFrameSubscription>));
    let c_handler: TunnelFrameHandler = {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("C".into());
            Ok(())
        })
    };
    let a: TunnelFrameHandler = {
        let (trace, b, c, weak, c_handler) = (
            trace.clone(),
            b.clone(),
            c.clone(),
            Arc::downgrade(&bridge),
            c_handler.clone(),
        );
        Arc::new(move |_| {
            trace.lock().unwrap().push("A".into());
            b.lock().unwrap().take();
            let mut current = c.lock().unwrap();
            if current.is_none() {
                *current = Some(
                    weak.upgrade()
                        .unwrap()
                        .subscribe_tunnel_frames("worker", c_handler.clone()),
                );
            }
            Ok(())
        })
    };
    let cancel_a = bridge.subscribe_tunnel_frames("worker", a.clone());
    *b.lock().unwrap() = Some(bridge.subscribe_tunnel_frames("worker", {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("B".into());
            Ok(())
        })
    }));
    let duplicate = bridge.subscribe_tunnel_frames("worker", a);
    let link_calls = Arc::new(Mutex::new(0));
    let link = bridge.subscribe_worker_link_frames("worker", {
        let calls = link_calls.clone();
        Arc::new(move |_| {
            *calls.lock().unwrap() += 1;
            Ok(())
        })
    });
    assert!(bridge.receive_tunnel_frame("worker", &peer, frame.bytes().to_vec().into()));
    drop(duplicate);
    assert!(bridge.receive_tunnel_frame("worker", &peer, frame.bytes().to_vec().into()));
    assert!(!bridge.receive_tunnel_frame("worker", &peer, b"CTTN".to_vec().into()));
    assert_eq!(value(peer.is_open()), expected["malformedKeepsConnection"]);
    let (replacement, _replacement_output) = Peer::new(identity());
    assert!(bridge.attach("worker", replacement.clone(), None));
    assert!(!bridge.receive_tunnel_frame("worker", &peer, frame.bytes().to_vec().into()));
    assert!(bridge.receive_tunnel_frame("worker", &replacement, frame.bytes().to_vec().into()));
    drop(cancel_a);
    c.lock().unwrap().take();
    let throwing = bridge.subscribe_tunnel_frames("worker", {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("throw".into());
            anyhow::bail!("controlled callback failure")
        })
    });
    let after = bridge.subscribe_tunnel_frames("worker", {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("after".into());
            Ok(())
        })
    });
    assert!(!bridge.receive_tunnel_frame("worker", &replacement, frame.bytes().to_vec().into()));
    drop(throwing);
    assert!(bridge.receive_tunnel_frame("worker", &replacement, frame.bytes().to_vec().into()));
    drop(after);
    drop(link);
    let rebind = Arc::new(Mutex::new(None::<TunnelFrameSubscription>));
    let (nested, _nested_output) = Peer::new(identity());
    *rebind.lock().unwrap() = Some(bridge.subscribe_tunnel_frames("worker", {
        let (weak, nested, trace, rebind) = (
            Arc::downgrade(&bridge),
            nested.clone(),
            trace.clone(),
            rebind.clone(),
        );
        Arc::new(move |_| {
            trace.lock().unwrap().push("rebind".into());
            assert!(
                weak.upgrade()
                    .unwrap()
                    .attach("worker", nested.clone(), None)
            );
            trace.lock().unwrap().push("rebound".into());
            rebind.lock().unwrap().take();
            Ok(())
        })
    }));
    assert!(bridge.receive_tunnel_frame("worker", &replacement, frame.bytes().to_vec().into()));
    assert!(bridge.receive_tunnel_frame("worker", &nested, frame.bytes().to_vec().into()));
    bridge.close();
    assert_eq!(value(trace.lock().unwrap().clone()), expected["trace"]);
    assert_eq!(
        value(*link_calls.lock().unwrap()),
        expected["workerLinkCallbacks"]
    );
    assert_eq!(Value::Array(logs.lock().unwrap().clone()), expected["logs"]);
    Ok(())
}
