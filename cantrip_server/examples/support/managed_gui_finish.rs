use anyhow::{Context, Result};
use cantrip_server::{
    config::{Environment, ServerConfig},
    database::Database,
    native_commands::{Repository, runtime::finish_gui::finish_managed_gui},
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
    let owner = input["owner"]
        .as_str()
        .context("GUI finish owner")?
        .to_owned();
    let worker = input["worker"]
        .as_str()
        .context("GUI finish worker")?
        .to_owned();
    let bridge = WorkerBridge::new(Duration::from_secs(15));
    let config = ServerConfig::read(&Environment::new(), &std::env::current_dir()?)?;
    let commands = LimitedCommandBus::new(
        database.clone(),
        bridge.clone(),
        RelayQuotas::new(&config),
        &config,
    );
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let (peer, mut output) = Peer::new(Continuity {
        owner: owner.clone(),
        credential: "fixture".into(),
        process_generation: "fixture".into(),
    });
    anyhow::ensure!(
        bridge.attach(&worker, peer.clone(), None),
        "GUI finish peer attach"
    );
    let reply_bridge = bridge.clone();
    let reply_trace = trace.clone();
    let reply_worker = worker.clone();
    let reply_owner = owner.clone();
    let reply_repository = Repository::new(database.clone());
    let response_error = input["responseError"] == true;
    let task = tokio::spawn(async move {
        while let Some(outgoing) = output.recv().await {
            let Outgoing::Text(text) = outgoing else {
                break;
            };
            let frame: Value = serde_json::from_str(&text)?;
            let c = &frame["command"];
            let committed = reply_repository
                .get_logical_completion(
                    &reply_owner,
                    &reply_worker,
                    c["chatId"].as_str().context("Release chat")?,
                    c["rootOperationId"].as_str().context("Release root")?,
                    c["rootOperationGeneration"]
                        .as_str()
                        .context("Release generation")?,
                )
                .await?
                .is_some();
            reply_trace.lock().unwrap().push(Value::from_serialize(&json!({"kind":"request","workerId":reply_worker,"command":c,"committed":committed})));
            let response = if response_error {
                json!({"kind":"response","requestId":frame["requestId"],"ok":false,"error":{"message":"Managed GUI acknowledgment failed","code":"gui-finish-fixture"}})
            } else {
                json!({"kind":"response","requestId":frame["requestId"],"ok":true,"result":null})
            };
            reply_bridge.response(&reply_worker, &peer, &Value::from_serialize(&response));
        }
        Ok::<(), anyhow::Error>(())
    });
    let errors = trace.clone();
    let result = finish_managed_gui(
        &Repository::new(database),
        &commands,
        &owner,
        &worker,
        &input["receipt"],
        input["status"].as_str().context("GUI finish status")?,
        &move |_error| {
            errors
                .lock()
                .unwrap()
                .push(Value::from_serialize(&json!({"kind":"ack-error"})));
        },
    )
    .await;
    commands.drained().await;
    bridge.close();
    task.abort();
    let _ = task.await;
    let finished = result?;
    let trace = trace.lock().unwrap().clone();
    Ok(Value::from_serialize(
        &json!({"finished":finished,"trace":trace}),
    ))
}
