//! Native serving lifetime. Remaining command domains are tracked explicitly in
//! the implementation ledger; only real native handlers are installed here.
use crate::{
    config::{self, Config, Host},
    connection::{Connection, Outbound},
    credentials::{self, Credential},
    encryption::{RequestedGrant, Service, ServiceError},
    http,
    logging::{self, Logs},
    platform, version,
};
use anyhow::{Result, anyhow, bail};
use cantrip_config::Environment;
use cantrip_wire::{Value, value::json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Copy)]
pub struct Outcome {
    pub restart: bool,
    pub trigger: &'static str,
}
pub struct Signals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    stdin: Option<tokio::sync::oneshot::Receiver<()>>,
}
impl Signals {
    pub fn new(stdin: bool) -> Result<Self> {
        Ok(Self {
            #[cfg(unix)]
            interrupt: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
            #[cfg(unix)]
            terminate: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
            stdin: if stdin {
                Some(cantrip_host::process::pipe_closed(
                    std::io::stdin(),
                    "cantrip-worker-stdin",
                )?)
            } else {
                None
            },
        })
    }
    pub async fn receive(&mut self) -> &'static str {
        #[cfg(unix)]
        {
            tokio::select! {
                _=self.interrupt.recv()=>"SIGINT",
                _=self.terminate.recv()=>"SIGTERM",
                _=async {if let Some(stdin)=&mut self.stdin {let _=stdin.await;}else{std::future::pending::<()>().await;}}=>"stdin-close",
            }
        }
        #[cfg(windows)]
        {
            tokio::select! {
                _=tokio::signal::ctrl_c()=>"SIGINT",
                _=async {if let Some(stdin)=&mut self.stdin {let _=stdin.await;}else{std::future::pending::<()>().await;}}=>"stdin-close",
            }
        }
    }
}
pub async fn serve(
    environment: Environment,
    cwd: &Path,
    worker_root: &Path,
    stdin: bool,
) -> Result<()> {
    let mut signals = Signals::new(stdin)?;
    let data = config::data_directory(&environment, cwd);
    let logs = Arc::new(Logs::initialize(&data, &environment, cwd).await);
    loop {
        let result = cycle(&environment, cwd, worker_root, &logs, &mut signals).await;
        if let Err(error) = &result {
            logs.event("fatal","Cantrip Worker failed to start",json!({"event":"worker.startup.failed","subsystem":"worker-startup","operation":"start","reasonCode":"startup-failed","status":"failed","error":logging::error(error)}));
        }
        logs.close().await;
        if !result?.restart {
            return Ok(());
        }
        // The Node process retains its log buffer and emitter across restart.
        // Only the archive and runtime service producers acquire a new lifetime.
        logs.reopen(&data, &environment, cwd).await;
    }
}
async fn cycle(
    environment: &Environment,
    cwd: &Path,
    worker_root: &Path,
    logs: &Arc<Logs>,
    signals: &mut Signals,
) -> Result<Outcome> {
    let host = Host {
        cwd,
        worker_root,
        platform: platform::platform(),
        architecture: platform::architecture(),
        hostname: "",
    };
    let mut config = config::read_with_hostname(environment, &host, || Ok(platform::hostname()?))?;
    let worker = config.worker_id.clone();
    let generation = uuid::Uuid::new_v4().to_string();
    logs.event("info","Cantrip Worker startup began",json!({"event":"worker.startup.started","subsystem":"worker-startup","operation":"start","status":"started","version":version::value()["version"],"workerGeneration":generation}));
    logs.event("info","Worker configuration loaded",json!({"event":"worker.configuration.loaded","workerId":worker,"credentialState":config.token_source}));
    let encryption_identity = crate::encryption::Identity::open(
        &config.data_directory,
        &config.server_url,
        &config.worker_id,
        config.token_source == "development",
    )?;
    let client = http::client()?;
    let started = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let encryption = Service::new(encryption_identity, &config.server_url, client.clone())?;
    let mut heartbeat = http::heartbeat(&config, host.platform, host.architecture, &started)?;
    heartbeat["encryption"] = encryption.status();
    http::enroll(&client, &mut config, &heartbeat, logs).await?;
    let configuration = Arc::new(Mutex::new(config));
    let outgoing = Arc::new(Outbound::default());
    let (stop, stop_rx) = watch::channel(false);
    let (registered, mut registration) = watch::channel(false);
    let (requests, mut received) = mpsc::unbounded_channel();
    let mut heartbeat_task = tokio::spawn(publish(
        configuration.clone(),
        client,
        heartbeat,
        logs.clone(),
        stop_rx.clone(),
        registered,
        encryption.clone(),
    ));
    let connection = Connection {
        configuration: configuration.clone(),
        logs: logs.clone(),
        outgoing: outgoing.clone(),
        requests,
        stop: stop_rx.clone(),
        generation,
    };
    let mut connection_stop = stop_rx.clone();
    let mut connection_task = tokio::spawn(async move {
        if !*registration.borrow() {
            tokio::select! {_=connection_stop.changed()=>return Ok(()),_=registration.changed()=>{}}
        }
        if *connection_stop.borrow() || !*registration.borrow() {
            return Ok(());
        }
        connection.run().await
    });
    let (restart, mut restart_requested) = mpsc::unbounded_channel::<()>();
    let mut timers = tokio::task::JoinSet::new();
    let mut commands = tokio::task::JoinSet::new();
    let mut command_failure = None;
    let mut commands_open = true;
    let mut heartbeat_result = None;
    let mut connection_result = None;
    let outcome = loop {
        tokio::select! {
            result=&mut heartbeat_task,if heartbeat_result.is_none()=>{
                heartbeat_result=Some(result);break Outcome{restart:false,trigger:"heartbeat-stopped"};
            },
            result=&mut connection_task,if connection_result.is_none()=>{
                let failed=!matches!(&result,Ok(Ok(())));connection_result=Some(result);
                if failed {break Outcome{restart:false,trigger:"connection-failed"};}
            },
            result=commands.join_next(),if !commands.is_empty()=>{
                if let Some(Err(error))=result {command_failure=Some(error);break Outcome{restart:false,trigger:"command-failed"};}
            },
            trigger=signals.receive()=>break Outcome{restart:false,trigger},
            _=restart_requested.recv()=>break Outcome{restart:true,trigger:"restart-request"},
            request=received.recv(),if commands_open=>{
                let Some(request)=request else {commands_open=false;continue;};
                let command=&request["command"];
                let kind=command["type"].as_str().unwrap_or("unknown");
                let began=std::time::Instant::now();
                logs.event("debug","Worker command dispatched",json!({"event":"worker.command.dispatched","operation":kind,"requestId":request["requestId"],"workerId":worker}));
                if kind=="worker.encryption.refresh" {
                    let requested=RequestedGrant{component:command["component"].as_str().unwrap().to_owned(),key_revision:command["keyRevision"].as_u64().unwrap()};
                    let credential=configuration.lock().unwrap().token.clone();
                    let refresh=encryption.refresh(credential,Some(requested));
                    let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=match refresh.await {
                            Ok(status)=>http::checked("workerEncryptionRefreshResultSchema",&json!({"component":request["command"]["component"],"keyRevision":request["command"]["keyRevision"],"status":status})),
                            Err(error)=>Err(error.into()),
                        };
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                let result=dispatch(command,&configuration,logs);
                finish(&request,&worker,logs,&outgoing,began,&result);
                if result.is_ok() && kind=="worker.restart" {
                    let restart=restart.clone();timers.spawn(async move {tokio::time::sleep(Duration::from_millis(250)).await;let _=restart.send(());});
                }
            },
        }
    };
    let began = std::time::Instant::now();
    stop.send_replace(true);
    timers.abort_all();
    while timers.join_next().await.is_some() {}
    let encryption_closed = encryption.close().await;
    while let Some(result) = commands.join_next().await {
        if let Err(error) = result {
            command_failure.get_or_insert(error);
        }
    }
    let (heartbeat_done, connection_done) = tokio::join!(
        async {
            match heartbeat_result {
                Some(result) => result,
                None => heartbeat_task.await,
            }
        },
        async {
            match connection_result {
                Some(result) => result,
                None => connection_task.await,
            }
        }
    );
    outgoing.close();
    encryption_closed?;
    if let Some(error) = command_failure {
        return Err(anyhow!("Worker command task failed: {error}"));
    }
    heartbeat_done.map_err(|error| anyhow!("Heartbeat task failed: {error}"))?;
    connection_done.map_err(|error| anyhow!("Worker connection task failed: {error}"))??;
    if outcome.trigger == "heartbeat-stopped" {
        bail!("Worker heartbeat publisher stopped unexpectedly.");
    }

    logs.event("info","Cantrip Worker stopped",json!({"event":"worker.shutdown.completed","subsystem":"worker-startup","operation":"shutdown","status":"completed","reasonCode":if outcome.restart{"restart-requested"}else{"signal"},"trigger":outcome.trigger,"workerId":worker,"durationMs":began.elapsed().as_millis() as u64}));
    Ok(outcome)
}
fn finish(
    request: &Value,
    worker: &cantrip_wire::JsString,
    logs: &Logs,
    outgoing: &Outbound,
    began: std::time::Instant,
    result: &Result<Value>,
) {
    let kind = request["command"]["type"].as_str().unwrap_or("unknown");
    match result {
        Ok(_)=>logs.event("debug","Worker command completed",json!({"event":"worker.command.completed","operation":kind,"requestId":request["requestId"],"workerId":worker,"durationMs":began.elapsed().as_millis() as u64})),
        Err(error)=>logs.event("error","Worker command failed",json!({"event":"worker.command.failed","operation":kind,"requestId":request["requestId"],"workerId":worker,"error":logging::error(error)})),
    }
    let response = match result {
        Ok(result) => {
            json!({"kind":"response","requestId":request["requestId"],"ok":true,"result":result})
        }
        Err(error) => {
            let error = match error.downcast_ref::<ServiceError>() {
                Some(error) => match error.code {
                    Some(code) => json!({"code":code,"message":error.message}),
                    None => json!({"message":error.message}),
                },
                None => json!({"message":error.to_string()}),
            };
            json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":error})
        }
    };
    if let Err(error) = outgoing.send(response) {
        logs.event("error","Worker command response was rejected",json!({"event":"worker.command.invalid-response","workerId":worker,"error":logging::error(&error)}));
    }
}
fn dispatch(command: &Value, configuration: &Arc<Mutex<Config>>, logs: &Logs) -> Result<Value> {
    match command["type"].as_str().unwrap_or("") {
        "worker.version" => Ok(version::value().clone()),
        "worker.restart" => Ok(json!({"restarting":true})),
        "worker.credential.rotate" => {
            let mut config = configuration.lock().unwrap();
            let credential = command["credential"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing worker credential"))?
                .to_owned();
            credentials::save(
                &config.data_directory,
                &Credential {
                    credential: credential.clone(),
                    server_url: config.server_url.clone(),
                    worker_id: config.worker_id.clone(),
                },
            )?;
            config.token = credential;
            config.token_source = "persisted";
            Ok(json!({"accepted":true}))
        }
        "diagnostics.logs.read" => logs.read(command),
        _ => bail!(
            "Worker command {} is not implemented by the native worker yet.",
            command["type"].as_str().unwrap_or("unknown")
        ),
    }
}
async fn publish(
    config: Arc<Mutex<Config>>,
    client: reqwest::Client,
    mut heartbeat: Value,
    logs: Arc<Logs>,
    mut stop: watch::Receiver<bool>,
    registered: watch::Sender<bool>,
    encryption: Arc<Service>,
) {
    let mut connected = false;
    let mut next = tokio::time::Instant::now();
    let mut first = true;
    let mut failure_started: Option<std::time::Instant> = None;
    let mut failures = 0_u64;
    let mut last_error = None;
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {_=stop.changed()=>break,_=tokio::time::sleep_until(next)=>{}}
        let token = config.lock().unwrap().token.clone();
        let refresh =
            tokio::select! {_=stop.changed()=>break,result=encryption.refresh(token,None)=>result};
        if let Err(error) = refresh {
            let worker = config.lock().unwrap().worker_id.clone();
            logs.repeated(format!("worker-encryption-refresh-failed:{}",worker.lossy()),"warn","Worker protected server connection is not ready",json!({"event":"worker.encryption.refresh-failed","subsystem":"worker-encryption","operation":"refresh-grants","reasonCode":"request-failed","status":"retrying","workerId":worker,"error":logging::error(&anyhow!(error))}));
        }
        heartbeat["encryption"] = encryption.status();
        let (url, token, worker) = {
            let config = config.lock().unwrap();
            (
                config.server_url.clone(),
                config.token.clone(),
                config.worker_id.clone(),
            )
        };
        let began = std::time::Instant::now();
        let result = tokio::select! {_=stop.changed()=>break,result=http::send_heartbeat(&client,&url,&token,&heartbeat)=>result};
        if *stop.borrow() {
            break;
        }
        match result {
            Ok(_preferences) => {
                if !connected {
                    logs.event("info","Worker heartbeat connected to server",json!({"event":if failure_started.is_some(){"worker.heartbeat.recovered"}else{"worker.heartbeat.connected"},"subsystem":"worker-connection","operation":"heartbeat","status":"connected","workerId":worker,"attempt":failures.max(1),"durationMs":failure_started.unwrap_or(began).elapsed().as_millis() as u64}));
                }
                connected = true;
                registered.send_replace(true);
                failure_started = None;
                failures = 0;
                last_error = None;
            }
            Err(error) => {
                failure_started.get_or_insert_with(std::time::Instant::now);
                failures = failures.saturating_add(1);
                let message = error.to_string();
                if connected || last_error.as_ref() != Some(&message) {
                    logs.repeated(format!("worker-heartbeat-failed:{}",worker.lossy()),"warn","Worker heartbeat unavailable; retrying",json!({"event":"worker.heartbeat.failed","subsystem":"worker-connection","operation":"heartbeat","status":"retrying","reasonCode":if message.contains("HTTP 401")||message.contains("HTTP 403"){"authentication-rejected"}else{"request-failed"},"attempt":failures,"durationMs":began.elapsed().as_millis() as u64,"workerId":worker,"error":logging::error(&error)}));
                }
                connected = false;
                last_error = Some(message);
            }
        }
        if first {
            next = tokio::time::Instant::now() + Duration::from_secs(5);
            first = false;
        } else {
            while next <= tokio::time::Instant::now() {
                next += Duration::from_secs(5);
            }
        }
    }
}
