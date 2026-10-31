//! Actual repositories, command admission and wire bridge with a controlled peer.
use anyhow::{Context, Result};
use cantrip_server::{
    config::{Environment, ServerConfig},
    database::Database,
    native_commands::{managed_queue::QueueRepository, runtime::delivery::QueueDelivery},
    relay::RelayQuotas,
    wire::Value,
    workers::{
        bridge::{Continuity, Outgoing, Peer, WorkerBridge},
        command_bus::LimitedCommandBus,
    },
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let config = ServerConfig::read(&Environment::new(), &std::env::current_dir()?)?;
    let commands = LimitedCommandBus::new(
        database.clone(),
        bridge.clone(),
        RelayQuotas::new(&config),
        &config,
    );
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let mut peers = Vec::new();
    let mut workers = std::collections::HashSet::new();
    for entry in QueueRepository::new(database.clone())
        .pending_notifications(None)
        .await?
    {
        let worker = entry["workerId"]
            .as_str()
            .context("Queue peer worker")?
            .to_owned();
        if !workers.insert(worker.clone()) {
            continue;
        }
        let (peer, mut output) = Peer::new(Continuity {
            owner: entry["ownerId"]
                .as_str()
                .context("Queue peer owner")?
                .into(),
            credential: "fixture-credential".into(),
            process_generation: "fixture-process".into(),
        });
        anyhow::ensure!(
            bridge.attach(&worker, peer.clone(), None),
            "Queue peer attach"
        );
        let (bridge, trace, response_error) = (
            bridge.clone(),
            trace.clone(),
            input["responseError"] == true,
        );
        peers.push(tokio::spawn(async move {
            while let Some(outgoing)=output.recv().await {
                let Outgoing::Text(text)=outgoing else {continue};
                let frame:Value=serde_json::from_str(&text)?;
                trace.lock().unwrap().push(Value::from_serialize(&json!({"kind":"request","workerId":worker,"command":frame["command"]})));
                let response=if response_error {
                    json!({"kind":"response","requestId":frame["requestId"],"ok":false,"error":json!({"message":"Queue worker failed","code":"queue-fixture-failure"})})
                } else {json!({"kind":"response","requestId":frame["requestId"],"ok":true,"result":Value::Null})};
                bridge.response(&worker,&peer,&Value::from_serialize(&response));
            }
            Ok::<(),anyhow::Error>(())
        }));
    }
    let published = trace.clone();
    let errors = trace.clone();
    let service = QueueDelivery::new(
        database,
        commands.clone(),
        Arc::new(move |owner, chat| {
            published.lock().unwrap().push(Value::from_serialize(
                &json!({"kind":"publish","ownerId":owner,"chatId":chat}),
            ));
            Ok(())
        }),
        None,
        Arc::new(move |error| {
            errors.lock().unwrap().push(Value::from_serialize(
                &json!({"kind":"error","message":error.to_string()}),
            ));
        }),
    );
    service.run_once().await;
    service.stop();
    service.drained().await;
    commands.drained().await;
    bridge.close();
    for peer in peers {
        peer.abort();
        let _ = peer.await;
    }
    let trace = trace.lock().unwrap().clone();
    Ok(Value::Array(trace))
}
