use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_server::{
    wire::Value,
    worker_links::frame,
    workers::bridge::{Continuity, FrameHandler, FrameSubscription, Outgoing, Peer, WorkerBridge},
};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
fn identity() -> Continuity {
    Continuity {
        owner: "owner".into(),
        credential: "credential".into(),
        process_generation: "generation".into(),
    }
}
fn json(value: impl serde::Serialize) -> Value {
    Value::from_serialize(&value)
}
fn source() -> Result<Value> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/worker-link-bridge-oracle.mjs",
        ])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Reference bridge failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
#[tokio::test]
async fn binary_buffering_and_ordered_listeners_match_actual_bridge() -> Result<()> {
    let expected = source()?;
    let bridge = WorkerBridge::new(Duration::ZERO);
    let (peer, mut output) = Peer::new(identity());
    assert!(bridge.attach(
        "worker",
        peer.clone(),
        Some("x".repeat(8 * 1024 * 1024 - 10))
    ));
    let frame = frame::create(expected["header"].clone(), &[1, 2, 3])?;
    let mut curve = vec![
        json(peer.buffered_amount()),
        json(bridge.send_worker_link_frame("worker", frame.clone())),
        json(peer.buffered_amount()),
        json(bridge.send_worker_link_frame("worker", frame.clone())),
    ];
    let ready = output.recv().await.unwrap();
    assert!(matches!(&ready, Outgoing::Text(_)));
    drop(ready);
    curve.extend([
        json(peer.buffered_amount()),
        json(bridge.send_worker_link_frame("worker", frame.clone())),
        json(peer.buffered_amount()),
    ]);
    let Some(Outgoing::Binary(mut first)) = output.recv().await else {
        panic!("Expected binary frame")
    };
    let forwarded = first.take();
    // Taking the payload for a writer must not release its in-flight budget.
    let during_write = peer.buffered_amount();
    tokio::task::yield_now().await;
    assert_eq!(peer.buffered_amount(), during_write);
    assert_eq!(
        json(STANDARD.encode(forwarded.bytes())),
        expected["forwarded"]
    );
    drop(first);
    drop(output.recv().await.unwrap());
    curve.push(json(peer.buffered_amount()));
    assert_eq!(Value::Array(curve), expected["bufferCurve"]);
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let b = Arc::new(Mutex::new(None::<FrameSubscription>));
    let c = Arc::new(Mutex::new(None::<FrameSubscription>));
    let c_handler: FrameHandler = {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("C".into());
            Ok(())
        })
    };
    let a: FrameHandler = {
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
                        .subscribe_worker_link_frames("worker", c_handler.clone()),
                );
            }
            Ok(())
        })
    };
    let a_subscription = bridge.subscribe_worker_link_frames("worker", a.clone());
    *b.lock().unwrap() = Some(bridge.subscribe_worker_link_frames("worker", {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("B".into());
            Ok(())
        })
    }));
    let duplicate = bridge.subscribe_worker_link_frames("worker", a);
    assert!(bridge.receive_worker_link_frame("worker", &peer, frame.bytes().to_vec().into()));
    drop(duplicate);
    assert!(bridge.receive_worker_link_frame("worker", &peer, frame.bytes().to_vec().into()));
    assert!(!bridge.receive_worker_link_frame("worker", &peer, b"CWLK".to_vec().into()));
    assert_eq!(json(peer.is_open()), expected["malformedKeepsConnection"]);
    let (replacement, _replacement_output) = Peer::new(identity());
    assert!(bridge.attach("worker", replacement.clone(), None));
    assert!(!bridge.receive_worker_link_frame("worker", &peer, frame.bytes().to_vec().into()));
    assert!(bridge.receive_worker_link_frame(
        "worker",
        &replacement,
        frame.bytes().to_vec().into()
    ));
    drop(a_subscription);
    c.lock().unwrap().take();
    let throwing = bridge.subscribe_worker_link_frames("worker", {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("throw".into());
            anyhow::bail!("controlled callback failure")
        })
    });
    let after = bridge.subscribe_worker_link_frames("worker", {
        let trace = trace.clone();
        Arc::new(move |_| {
            trace.lock().unwrap().push("after".into());
            Ok(())
        })
    });
    assert!(!bridge.receive_worker_link_frame(
        "worker",
        &replacement,
        frame.bytes().to_vec().into()
    ));
    drop(throwing);
    assert!(bridge.receive_worker_link_frame(
        "worker",
        &replacement,
        frame.bytes().to_vec().into()
    ));
    drop(after);
    assert_eq!(json(trace.lock().unwrap().clone()), expected["trace"]);
    bridge.close();
    Ok(())
}
#[tokio::test]
async fn abandoned_socket_writer_releases_all_reserved_bytes() -> Result<()> {
    let expected = source()?;
    let bridge = WorkerBridge::new(Duration::ZERO);
    let (peer, output) = Peer::new(identity());
    assert!(bridge.attach("worker", peer.clone(), Some("ready".into())));
    let frame = frame::create(expected["header"].clone(), &[1, 2, 3])?;
    assert!(bridge.send_worker_link_frame("worker", frame.clone()));
    assert!(peer.buffered_amount() > 5);
    drop(output);
    assert_eq!(peer.buffered_amount(), 0);
    assert!(!bridge.send_worker_link_frame("worker", frame));
    assert_eq!(peer.buffered_amount(), 0);
    bridge.close();
    Ok(())
}
