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
use anyhow::{Context, Result, anyhow, bail, ensure};
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
    let codex_compatibility =
        crate::codex::startup::prepare(&config, cwd, environment, logs).await?;
    let encryption_identity = crate::encryption::Identity::open(
        &config.data_directory,
        &config.server_url,
        &config.worker_id,
        config.token_source == "development",
    )?;
    let client = http::client()?;
    let started = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let encryption = Service::new(encryption_identity, &config.server_url, client.clone())?;
    let routing = Arc::new(crate::routing::Registry::new(&config.data_directory));
    let cantrip_os = Arc::new(crate::cantrip_os::Controller::new(
        &config.data_directory,
        worker.clone(),
    ));
    let chat_scratch = Arc::new(crate::filesystem::chat_scratch::Manager::new(
        &config.data_directory,
    ));
    let folders = Arc::new(crate::filesystem::folders::Manager::new(
        &config.data_directory,
    ));
    let project_exports = Arc::new(crate::project_exports::Manager::new(
        &config.codex_installation.binary,
        &config.data_directory,
        cwd,
        environment,
    ));
    let external_history = Arc::new(crate::external_history::Manager::new(
        &config.codex_installation.binary,
        &config.data_directory,
        cwd,
        environment,
        &codex_compatibility["version"]["raw"],
    ));
    let attachment_commands = Arc::new(crate::attachments::commands::Commands::new(
        &config.data_directory,
        logs.clone(),
    )?);
    let repository_operations = Arc::new(crate::repository_operations::RepositoryOperations::new(
        &config.data_directory,
        &worker,
    ));
    let worktrees = repository_operations.worktrees()?;
    let github = repository_operations.github()?;
    let folder_conversion = Arc::new(crate::github::conversion::Converter::new(
        &config.data_directory,
        folders.clone(),
    ));
    let replicas = Arc::new(crate::replicas::Manager::new(
        &config.data_directory,
        &worker,
    ));
    let surface_replay = Arc::new(Mutex::new(
        crate::protected_content::SurfaceStreamReplayGuard::default(),
    ));
    let guest_files = Arc::new(crate::cantrip_os::product_files::ProductFiles::new(
        &config.data_directory,
    ));
    let explorer_operations =
        Arc::new(crate::explorer_operations::ExplorerOperations::with_replay(
            surface_replay.clone(),
            &config.data_directory,
            guest_files.clone(),
            chat_scratch.clone(),
        ));
    let (direct, direct_listener) =
        crate::worker_link::DirectBroker::bind(worker.clone(), logs.clone()).await?;
    let mut heartbeat = http::heartbeat(&config, host.platform, host.architecture, &started)?;
    heartbeat["codexVersion"] = codex_compatibility["version"]["raw"].clone();
    heartbeat["codexRuntime"] = codex_compatibility.clone();
    heartbeat["chatRelocation"] = json!(true);
    heartbeat["externalCodexHistory"] = json!(crate::codex::external_home::supported());
    let managed_web = Arc::new(crate::managed_web::Runtimes::configure(
        &config.data_directory,
        environment,
        logs.clone(),
    )?);
    heartbeat["webRuntimes"] = managed_web.capabilities();
    heartbeat["directBroker"] = direct.advertisement().clone();
    heartbeat["remoteSurfaces"] = crate::browser_surface::capabilities(environment);
    heartbeat["projectReplicas"] = json!({
        "provision":true,"synchronize":true,"remove":true,"exactRevision":true,
        "directPlacement":true,"managedLinkPlacement":crate::replicas::placement::probe_managed_link(&config.data_directory).await,
        "attachExisting":true,"recursiveParentCreation":true,"workspaceScopedRoots":true,
    });
    heartbeat["encryption"] = encryption.status();
    http::enroll(&client, &mut config, &heartbeat, logs).await?;
    let catalog_version = codex_compatibility["version"]["raw"].clone();
    let data_directory = config.data_directory.clone();
    let codex_binary = config.codex_installation.binary.clone();
    let configuration = Arc::new(Mutex::new(config));
    let cli = crate::cli::Broker::start(
        configuration.clone(),
        environment,
        cwd,
        worker_root,
        encryption.clone(),
    )
    .await?;
    let host_environment = cli.child_environment(environment);
    let codex_host = crate::codex::managed::Host {
        binary: codex_binary.clone(),
        cwd: cwd.into(),
        environment: host_environment
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        compatibility: codex_compatibility.clone(),
        logs: Some(logs.clone()),
    };
    let codex = crate::codex::managed::Worker::bound_to_encryption(
        codex_host.clone(),
        data_directory.clone(),
        worker.clone(),
        generation.clone().into(),
        encryption.clone(),
    );
    let terminals = Arc::new(crate::terminal_services::Manager::new(
        host_environment.clone(),
        logs.clone(),
    ));
    let shells = Arc::new(crate::terminal_services::interactive::Shells::new(
        host_environment.clone(),
        logs.clone(),
        terminals.clone(),
        surface_replay,
        generation.clone(),
        &data_directory,
    ));

    let (stop, stop_rx) = watch::channel(false);
    let outgoing = Arc::new(Outbound::default());
    let desktop_inventory = crate::desktop_inventory::DesktopInventory::start(
        worker_root,
        &data_directory,
        environment,
        encryption.clone(),
        outgoing.clone(),
        stop_rx.clone(),
    );
    let browser_surfaces = Arc::new(
        crate::browser_surface::Manager::new(
            &data_directory,
            environment,
            encryption.clone(),
            outgoing.clone(),
            logs.clone(),
        )
        .with_capture(&desktop_inventory),
    );
    let shares = Arc::new(crate::project_shares::Manager::new(
        encryption.clone(),
        chat_scratch.clone(),
        logs.clone(),
    ));
    let worker_link = Arc::new(crate::worker_link::Coordinator::new(
        worker.clone(),
        generation.clone(),
        encryption.clone(),
        outgoing.clone(),
        logs.clone(),
        shares.clone(),
        direct.clone(),
    ));
    worker_link.configure_surfaces(browser_surfaces.clone());
    outgoing.observe_with(&worker_link);
    let direct_task = tokio::spawn(direct.clone().run(
        direct_listener,
        Arc::downgrade(&worker_link),
        stop_rx.clone(),
    ));
    let worker_link_task = {
        let gateway = worker_link.clone();
        let stop = stop_rx.clone();
        tokio::spawn(async move { gateway.run(stop).await })
    };
    let (command_shutdown, command_signal) = crate::metadata::Abort::new();
    let task_inputs = crate::codex::task_inputs::Client::new(
        configuration.clone(),
        encryption.clone(),
        generation.clone(),
    )?;
    codex.configure_task_inputs(task_inputs.clone())?;
    let task_delivery = Arc::new(crate::outcomes::TaskDelivery::new(
        configuration.clone(),
        encryption.clone(),
        stop_rx.clone(),
        logs.clone(),
    )?);
    let project_goals = Arc::new(crate::codex::goals::delivery::Delivery::new(
        configuration.clone(),
        encryption.clone(),
        generation.clone(),
        logs.clone(),
    )?);
    codex.configure_project_goals(project_goals.clone())?;
    let run_environment = Arc::new(host_environment);
    let run_definitions = Arc::new(crate::run_definitions::Definitions::new(
        run_environment.clone(),
    ));
    let runs = Arc::new(crate::run_runtime::Manager::new(
        worker.clone(),
        run_environment,
        encryption.clone(),
        outgoing.clone(),
        worktrees.clone(),
        routing.clone(),
        logs.clone(),
        &configuration.lock().unwrap().data_directory,
    ));
    worker_link.configure_terminals(shells.clone(), runs.clone());
    codex.configure_inference_status({
        let outgoing = outgoing.clone();
        Arc::new(move |status| {
            outgoing.notification(json!({"type":"inference.status","status":status}))?;
            Ok(())
        })
    })?;
    let auth_observations = crate::provider_auth_observer::Observer::new({
        let outgoing = outgoing.clone();
        Arc::new(move |notification| {
            let _ = outgoing.notification(notification);
        })
    });
    let account_auth = crate::codex::account_auth::Commands::new(
        codex_host,
        data_directory.clone(),
        codex.clone(),
        auth_observations.clone(),
    );
    let grok_auth = crate::grok::Commands::new(
        data_directory.clone(),
        codex.clone(),
        auth_observations.clone(),
        environment,
    )?;
    let provider_access = crate::provider_access::Access::new(
        configuration.clone(),
        encryption.clone(),
        client.clone(),
    );
    grok_auth.install_proxy(provider_access.clone(), encryption.clone())?;
    let grok_catalog = crate::grok::catalog::Catalog::new(
        grok_auth.clone(),
        provider_access.clone(),
        encryption.clone(),
        logs.clone(),
    );
    let provider_credentials = crate::provider_credentials::Commands::new(
        codex.clone(),
        account_auth.clone(),
        grok_auth.clone(),
        provider_access.clone(),
        encryption.clone(),
        data_directory.clone(),
        &codex_compatibility,
    );
    let skill_root = crate::codex::catalog::global_skill_root(cwd, environment);
    let chat_observation = crate::codex::observation::Observer::new(
        codex.clone(),
        provider_access.clone(),
        encryption.clone(),
        routing.clone(),
        data_directory.clone(),
        skill_root.clone(),
        worker.clone(),
    );
    let publish_observation = {
        let outgoing = outgoing.clone();
        let routing = routing.clone();
        Arc::new(move |notification| {
            routing
                .protect_notification(&notification)
                .ok()
                .flatten()
                .is_some_and(|notification| outgoing.notification(notification).unwrap_or(false))
        })
    };
    let codegraph = crate::codegraph::Supervisor::new(
        &data_directory,
        stop_rx.clone(),
        worktrees.clone(),
        logs.clone(),
        publish_observation.clone(),
    );
    let thread_preparation = crate::codex::preparation::command::Ensurer::new(
        codex.clone(),
        provider_access.clone(),
        configuration.clone(),
        encryption.clone(),
        routing.clone(),
        skill_root.clone(),
        cli.contexts(),
        managed_web.clone(),
        browser_surfaces.clone(),
        codegraph.clone(),
    );
    let skill_settings = crate::codex::skills::settings::Settings::new(
        thread_preparation.clone(),
        encryption.clone(),
        data_directory.clone(),
        skill_root.clone(),
    );
    let chat_relocation = Arc::new(crate::codex::relocation::Manager::new(&data_directory));
    let history = crate::history::managed::runtime::open(
        configuration.clone(),
        encryption.clone(),
        logs.clone(),
    )?;
    let goals = crate::codex::goals::Goals::new(
        thread_preparation.clone(),
        chat_observation.clone(),
        encryption.clone(),
        project_goals.clone(),
        crate::attachments::Store::new(&data_directory, None)?,
    );
    let turns = crate::codex::turn::Turns::new(
        thread_preparation.clone(),
        encryption.clone(),
        configuration.clone(),
        generation.clone(),
        history.clone(),
        task_inputs.clone(),
        task_delivery.clone(),
        guest_files,
        &desktop_inventory,
        outgoing.clone(),
    )?;
    thread_preparation.configure_autonomous(turns.autonomous(routing.clone()))?;
    turns.configure_queue_imports()?;
    turns.configure_settings_publisher(logs.clone())?;
    replicas.set_removal_lifecycle({
        let codegraph = codegraph.clone();
        Arc::new(move |root, remove| {
            let codegraph = codegraph.clone();
            Box::pin(async move { codegraph.with_retired_index(root, remove).await })
        })
    });
    let model_catalog = crate::codex::catalog::Catalog::new(
        codex.clone(),
        provider_access.clone(),
        encryption.clone(),
        data_directory,
        skill_root,
        catalog_version,
    );
    let model_operations = Arc::new(crate::model_operations::Commands::new(
        encryption.clone(),
        codex.clone(),
    )?);
    let provider_catalog = Arc::new(crate::codex::catalog::provider::Catalog::new(
        encryption.clone(),
        logs.clone(),
    )?);
    let worktree_observations = Arc::new(crate::git::worktrees::observations::Observations::new(
        worktrees.clone(),
        publish_observation,
    ));
    let automation = crate::automations::Scheduler::new(
        configuration.clone(),
        client.clone(),
        outgoing.clone(),
        logs.clone(),
    );
    let automation_task = tokio::spawn(automation.clone().run(stop_rx.clone()));
    let (registered, mut registration) = watch::channel(false);
    let task_outcomes = tokio::spawn(task_delivery.clone().run());
    let goal_delivery = tokio::spawn(project_goals.clone().run(stop_rx.clone()));
    let settings = turns.settings_delivery();
    let settings_delivery = tokio::spawn(settings.clone().run(stop_rx.clone(), logs.clone()));
    let deferred_delivery =
        tokio::spawn(turns.deferred_settlement_pump(stop_rx.clone(), logs.clone()));
    let (requests, mut received) = mpsc::unbounded_channel();
    let managed_web_task = {
        let manager = managed_web.clone();
        let logs = logs.clone();
        tokio::spawn(async move { manager.run(&logs).await })
    };
    let mut heartbeat_task = tokio::spawn(publish(
        configuration.clone(),
        client,
        heartbeat,
        logs.clone(),
        stop_rx.clone(),
        registered,
        (
            encryption.clone(),
            worker_link.clone(),
            managed_web.clone(),
            codegraph.clone(),
            desktop_inventory.effect_updates(),
        ),
    ));
    let connection = Connection {
        configuration: configuration.clone(),
        logs: logs.clone(),
        outgoing: outgoing.clone(),
        requests,
        stop: stop_rx.clone(),
        generation,
        worker_link: worker_link.clone(),
        browser_surfaces: browser_surfaces.clone(),
        on_ready: {
            let observations = auth_observations.clone();
            let project_goals = project_goals.clone();
            let settings = settings.clone();
            let turns = turns.clone();
            let settings_reconnect = thread_preparation.settings_reconnect();
            Arc::new(move || {
                automation.wake();
                observations.reemit();
                task_delivery.wake();
                project_goals.wake();
                settings.wake();
                turns.wake_deferred_settlements();
                settings_reconnect();
            })
        },
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
    let mut log_streams = crate::log_stream::Streams::default();
    let mut log_records = logs.subscribe();
    let mut log_gap = false;
    let outcome = loop {
        let log_deadline = log_streams.deadline();
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
            record=log_records.recv()=>{
                match record {
                    Ok(record) => log_streams.observe(&record, std::mem::take(&mut log_gap)),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => log_gap = true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => log_records = logs.subscribe(),
                }
            },
            _=async {
                match log_deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            }=>log_streams.flush(logs,&outgoing),
            request=received.recv(),if commands_open=>{
                let Some(request)=request else {commands_open=false;continue;};
                let command=&request["command"];
                let kind=command["type"].as_str().unwrap_or("unknown");
                let began=std::time::Instant::now();
                logs.event("debug","Worker command dispatched",json!({"event":"worker.command.dispatched","operation":kind,"requestId":request["requestId"],"workerId":worker}));
                if crate::log_stream::Streams::supports(kind) {
                    let result=log_streams.execute(kind,command,logs);
                    finish(&request,&worker,logs,&outgoing,began,&result);
                    continue;
                }
                if matches!(kind, crate::chat_content::MESSAGE | crate::chat_content::MESSAGES | crate::chat_content::REPROTECT | crate::chat_content::TURN | crate::chat_content::QUEUE_PREPARE) {
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = request["command"].clone();
                        let result = tokio::task::spawn_blocking(move || {
                            crate::chat_content::execute(encryption, &command)
                        }).await.unwrap_or_else(|error| Err(error.into()));
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::automations::PROTECT {
                    let encryption = encryption.clone();
                    let routing = routing.clone();
                    let github = github.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = crate::automations::protect(
                            encryption, &routing, &github, &scope, &request["command"],
                        ).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == "web-runtime.action" {
                    let manager = managed_web.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = manager.action(&request["command"], &logs).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::worker_link::PREPARE_GUEST_TUNNEL {
                    let gateway = worker_link.clone();
                    let previews = desktop_inventory.previews();
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = async {
                            let epoch = request["socketEpoch"].as_u64().context("Guest tunnel control socket")?;
                            let command = routing.resolve(&request["command"]).await?;
                            gateway.prepare_guest_tunnel(&command, epoch, &previews).await
                        }.await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::worker_link::supports(kind) {
                    let result = worker_link.execute(command);
                    finish(&request, &worker, logs, &outgoing, began, &result);
                    continue;
                }
                if crate::worker_link::supports_peer(kind) {
                    let worker_link = worker_link.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = worker_link.execute_peer(&request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::worker_link::DirectBroker::supports(kind) {
                    let identity = encryption.bound_identity();
                    direct.reconcile(identity.as_ref().ok());
                    let result = direct.execute(command, &worker_link);
                    finish(&request, &worker, logs, &outgoing, began, &result);
                    continue;
                }
                if kind == crate::model_operations::CANCEL {
                    let result = model_operations.cancel(command);
                    finish(&request, &worker, logs, &outgoing, began, &result);
                    continue;
                }
                if kind == crate::codex::turn::provider_test::COMMAND {
                    let preparation = thread_preparation.clone();
                    let encryption = encryption.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = crate::codex::turn::provider_test::execute(
                            &request["command"], &preparation, &encryption, signal,
                        ).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, crate::model_operations::EMBEDDING | crate::model_operations::DECISION) {
                    let operations = model_operations.clone();
                    let signal = command_signal.clone();
                    let outgoing = outgoing.clone();
                    let logs = logs.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let request_id = request["requestId"].as_js_string().expect("Validated request ID").clone();
                        let emit = Arc::new({
                            let outgoing = outgoing.clone();
                            let request_id = request_id.clone();
                            move |event| {
                                outgoing.send(json!({"kind":"event","requestId":request_id,"event":event}))?;
                                Ok(())
                            }
                        });
                        let result = operations.execute(
                            request["command"].clone(), request_id, request["modelOperationUsage"] == true,
                            request["inferenceAdmissionAck"] == true, signal, emit,
                        ).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::codex::turn::task_route::COMMAND {
                    let codex = codex.clone();
                    let turns = turns.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = turns.revoke_task_input(&codex, &request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::codex::revocation::COMMAND {
                    let result = turns.revoke_resource(command);
                    finish(&request, &worker, logs, &outgoing, began, &result);
                    continue;
                }
                if matches!(kind, "inference.configure" | "inference.status") {
                    let result = codex.inference_command(command);
                    finish(&request, &worker, logs, &outgoing, began, &result);
                    continue;
                }
                if kind == crate::codex::turn::label::COMMAND {
                    let preparation = thread_preparation.clone();
                    let encryption = encryption.clone();
                    let task_inputs = task_inputs.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = crate::codex::turn::label::execute(
                            &request["command"], preparation, encryption, task_inputs, signal,
                        ).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::task_content::supports(kind) {
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = request["command"].clone();
                        let result = tokio::task::spawn_blocking(move || {
                            crate::task_content::execute(&encryption, &command)
                        }).await.unwrap_or_else(|error| Err(error.into()));
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, crate::codex::goals::CREATE | crate::codex::goals::GET | crate::codex::goals::UPDATE | crate::codex::goals::CLEAR | crate::codex::goals::QUEUE_EXECUTE) {
                    let goals = goals.clone();
                    let turns = turns.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = &request["command"];
                        let mut acknowledged = false;
                        let result = match command["type"].as_str().unwrap_or_default() {
                            crate::codex::goals::GET => goals.get(command).await,
                            crate::codex::goals::UPDATE => goals.update(command, &turns).await,
                            crate::codex::goals::CLEAR => goals.clear(command, &turns).await,
                            crate::codex::goals::QUEUE_EXECUTE => goals.execute_queued(command, &turns, |reply| {
                                acknowledged = true;
                                finish(&request, &worker, &logs, &outgoing, began, &Ok(reply.clone()));
                            }).await,
                            _ => goals.create(command, &turns).await,
                        };
                        if !acknowledged {
                            finish(&request, &worker, &logs, &outgoing, began, &result);
                        } else if let Err(error) = result {
                            logs.event("warn", "Queued shell terminal result remains unconfirmed", json!({
                                "event":"codex.shell.settlement-failed","workerId":worker,"requestId":request["requestId"],
                                "error":logging::error(&error),
                            }));
                        }
                    });
                    continue;
                }
                if matches!(kind, crate::codex::turn::COMPLETE | crate::codex::turn::CANCEL) {
                    let (reply, followup) = match turns.logical(command) {
                        Ok(followup) => (Ok(json!({})), followup),
                        Err(error) => (Err(error), None),
                    };
                    finish(&request, &worker, logs, &outgoing, began, &reply);
                    if let Some(completion) = followup {
                        let turns = turns.clone();
                        let logs = logs.clone();
                        let worker = worker.clone();
                        commands.spawn(async move {
                            if let Err(error) = completion.compact(&turns).await {
                                logs.event("warn", "Scheduled chat compaction could not settle", json!({
                                    "event":"codex.compact.scheduled-failed","workerId":worker,
                                    "error":logging::error(&error),
                                }));
                            }
                        });
                    }
                    continue;
                }
                if kind == crate::codex::turn::RESUME {
                    let turns = turns.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let mut acknowledged = false;
                        let result = turns.resume_suspension(&request["command"], request["socketEpoch"].as_u64(), |reply| {
                            acknowledged = true;
                            finish(&request, &worker, &logs, &outgoing, began, &reply);
                        }).await;
                        if !acknowledged {
                            finish(&request, &worker, &logs, &outgoing, began, &result);
                        } else if let Err(error) = result {
                            logs.event("warn", "Restored native turn settlement is unconfirmed", json!({
                                "event":"codex.suspension.settlement-failed", "workerId":worker,
                                "requestId":request["requestId"], "error":logging::error(&error),
                            }));
                        }
                    });
                    continue;
                }
                if crate::codex::turn::interactions::handles(command) {
                    let turns = turns.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = turns.interaction(&request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, crate::codex::turn::handoff::COMMAND | crate::codex::turn::handoff::TASK_SOURCE | crate::codex::turn::TASK_GOAL_RECOVERY | crate::codex::turn::goal_recovery::COMMAND | crate::codex::turn::goal_recovery::CLAIM_COMMAND) {
                    let turns = turns.clone();
                    let codex = codex.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = &request["command"];
                        let result = match command["type"].as_str() {
                            Some(crate::codex::turn::goal_recovery::COMMAND) => turns.recover_goal(command, &codex, signal).await,
                            Some(crate::codex::turn::goal_recovery::CLAIM_COMMAND) => turns.recover_goal_claim(command, &codex, signal).await,
                            Some(crate::codex::turn::handoff::TASK_SOURCE) => turns.capture_task_goal(command, signal).await,
                            Some(crate::codex::turn::TASK_GOAL_RECOVERY) => turns.recover_task_goal(command, &codex, signal).await,
                            _ => turns.runtime_handoff(command, signal, codex).await,
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, crate::codex::turn::RUN | crate::codex::turn::INTERRUPT | crate::codex::turn::CONTROL | crate::codex::turn::STEER | crate::codex::turn::STOP_SUSPENSION | crate::codex::turn::PAUSE_SET) {
                    if kind == crate::codex::turn::INTERRUPT {
                        desktop_inventory.previews().cancel_chat(&command["chatId"]);
                    }
                    let observations = worker_link.clone();
                    let turns = turns.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = &request["command"];
                        let (result, note) = match command["type"].as_str() {
                            Some(crate::codex::turn::INTERRUPT) => (turns.interrupt(command).await, None),
                            Some(crate::codex::turn::CONTROL) => (turns.control(command, signal).await, None),
                            Some(crate::codex::turn::STEER) => (turns.steer(command, signal).await, None),
                            Some(crate::codex::turn::STOP_SUSPENSION) => (turns.stop_suspension(command).await, None),
                            Some(crate::codex::turn::PAUSE_SET) => (turns.set_pause(command).await, None),
                            _ => {
                                let request_id = request["requestId"].clone();
                                let epoch = request["socketEpoch"].as_u64();
                                let stream = outgoing.clone();
                                let observation = crate::worker_link::observation_scope(command);
                                turns.run(command, Arc::new(move |event| {
                                    let approval = matches!(event["type"].as_str(), Some("computer-use.approval.request" | "computer-use.approval.terminal"));
                                    let activity = event["type"] == "agent.protected-message" && event["telemetry"]["activityType"] == "computerUse";
                                    if approval || activity {
                                        let epoch = epoch.context("Computer use has no connected command socket.")?;
                                        ensure!(stream.send_for_epoch(epoch, json!({"kind":"event","requestId":request_id,"event":event}))?,
                                            "The computer-use event could not be delivered.");
                                        if activity {
                                            observations.publish_event(&observation, &event);
                                        }
                                        return Ok(());
                                    }
                                    observations.publish_event(&observation, &event);
                                    stream.send(json!({"kind":"event","requestId":request_id,"event":event}))?;
                                    Ok(())
                                }), epoch).await
                            }
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                        if let Some(note) = note
                            && let Err(error) = outgoing.notification(note)
                        {
                            logs.event("warn", "Task notification was rejected",
                                json!({"event":"task.notification-publication-failed","workerId":worker,"error":logging::error(&error)}));
                        }
                    });
                    continue;
                }
                if matches!(kind, crate::codex::turn::queue_wake::CHANGED | crate::codex::turn::queue_wake::RESUME) {
                    let turns = turns.clone();
                    let codex = codex.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = &request["command"];
                        let result = if command["type"] == crate::codex::turn::queue_wake::RESUME {
                            turns.resume_automation(command, signal).await
                        } else {
                            turns.queue_changed(command, &codex).await
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, crate::codex::turn::SETTINGS_UPDATE | crate::codex::turn::ACCOUNT_DEFAULTS | crate::codex::turn::PERMISSION_UPDATE) {
                    let turns = turns.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let command = &request["command"];
                        let result = match command["type"].as_str() {
                            Some(crate::codex::turn::ACCOUNT_DEFAULTS) => turns.account_defaults(command, signal).await,
                            Some(crate::codex::turn::PERMISSION_UPDATE) => turns.update_permissions(command, signal).await,
                            _ => turns.update_settings(command, signal).await,
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::codex::turn::SETTINGS_READ {
                    let preparation = thread_preparation.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = preparation.read_settings(&request["command"]["scope"], signal).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::codex::skills::settings::supports(kind) {
                    let skill_settings = skill_settings.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = skill_settings.execute(&request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::codex::preparation::command::COMMAND {
                    let preparation=thread_preparation.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=preparation.execute(&request["command"]).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if kind == crate::codex::preparation::command::PERMISSION_PROFILES {
                    let preparation = thread_preparation.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = preparation.list_permission_profiles(&request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, crate::codex::preparation::command::PLAN_GET | crate::codex::preparation::command::PLAN_SET) {
                    let preparation = thread_preparation.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = preparation.plan_mode(&request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind=="chat.sync" {
                    let observation=chat_observation.clone();let preparation=thread_preparation.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=observation.sync(&request["command"], &preparation).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if kind == crate::codex::turn::COMPACT {
                    let turns = turns.clone();
                    let observation = chat_observation.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let mut acknowledged = false;
                        let result = turns.compact(&request["command"], &observation, |reply| {
                            acknowledged = true;
                            finish(&request, &worker, &logs, &outgoing, began, &Ok(reply));
                        }).await;
                        if !acknowledged {
                            finish(&request, &worker, &logs, &outgoing, began, &result);
                        } else if let Err(error) = result {
                            logs.event("warn", "Chat compaction terminal result remains unconfirmed", json!({
                                "event":"codex.compact.settlement-failed", "workerId":worker,
                                "requestId":request["requestId"], "error":logging::error(&error),
                            }));
                        }
                    });
                    continue;
                }
                if kind == crate::codex::turn::ROLLBACK {
                    let turns = turns.clone();
                    let observation = chat_observation.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = turns.rollback(&request["command"], &observation).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::codex::relocation::supports(kind) {
                    let relocation = chat_relocation.clone();
                    let preparation = thread_preparation.clone();
                    let routing = routing.clone();
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = relocation.execute(&request["command"], &routing, &encryption, &preparation, &scope).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::codex::catalog::provider::handles(kind) {
                    let catalog = provider_catalog.clone();
                    let signal = command_signal.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = catalog.execute(&request["command"], signal).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::codex::catalog::supports(command) {
                    let catalog=model_catalog.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=catalog.execute(request["command"].clone()).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::grok::catalog::supports(command) {
                    let catalog=grok_catalog.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=catalog.execute(request["command"].clone()).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::provider_credentials::supports(kind) {
                    let credentials=provider_credentials.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=credentials.execute(request["command"].clone()).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::codex::account_auth::supports(command) {
                    let auth=account_auth.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=auth.execute(request["command"].clone()).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::grok::supports(command) {
                    let auth=grok_auth.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=auth.execute(request["command"].clone()).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if kind=="worker.encryption.refresh" {
                    let requested=RequestedGrant{component:command["component"].as_str().unwrap().to_owned(),key_revision:command["keyRevision"].as_u64().unwrap()};
                    let credential=configuration.lock().unwrap().token.clone();
                    let refresh=encryption.refresh(credential,Some(requested));
                    let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let worker_link=worker_link.clone();
                    commands.spawn(async move {
                        let refreshed=refresh.await;
                        worker_link.reconcile();
                        let result=match refreshed {
                            Ok(status)=>http::checked("workerEncryptionRefreshResultSchema",&json!({"component":request["command"]["component"],"keyRevision":request["command"]["keyRevision"],"status":status})),
                            Err(error)=>Err(error.into()),
                        };
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::filesystem::chat_scratch::Manager::supports(kind) {
                    let chat_scratch=chat_scratch.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    commands.spawn(async move {
                        let result=chat_scratch.execute_routed(&request["command"],&routing).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::project_shares::Manager::supports(kind) {
                    let shares = shares.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = shares.execute(&request["command"]).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::mcp::discovery::COMMAND {
                    let routing = routing.clone();
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = async {
                            let command = routing.resolve(&request["command"]).await?;
                            crate::mcp::discovery::discover(&encryption, command["projectRoot"].as_js_string(), &scope).await
                        }.await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == "browser.services.discover" {
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = crate::browser_services::discover(&worker, &scope).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::desktop_inventory::preview::supports(kind) {
                    let previews = desktop_inventory.previews();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = async {
                            let epoch = request["socketEpoch"].as_u64()
                                .context("Computer-use preview has no connected socket.")?;
                            previews.execute(&request["command"], epoch, |event| {
                                let approval = event["type"] == "computer-use.approval.request";
                                let frame = json!({"kind":"event","requestId":request["requestId"],"event":event});
                                let queued = if approval { outgoing.send_for_epoch(epoch, frame) } else { outgoing.send(frame) };
                                ensure!(queued?,
                                    "The protected computer-use response could not be delivered.");
                                Ok(())
                            }).await
                        }.await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind, "surface.desktop.targets" | "computer-use.effects.sync" | crate::desktop_inventory::PROBE) {
                    let pending = request["socketEpoch"].as_u64()
                        .ok_or_else(|| anyhow!("The desktop helper command has no connected socket."))
                        .and_then(|epoch| match kind {
                            "computer-use.effects.sync" => desktop_inventory.submit_effects(&command["preferences"], epoch),
                            crate::desktop_inventory::PROBE => desktop_inventory.submit_probe(epoch),
                            _ => desktop_inventory.submit(command.clone(), epoch),
                        });
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = match pending {
                            Ok(receipt) => receipt.await.unwrap_or_else(|_| Err(anyhow!("Desktop helper stopped."))),
                            Err(error) => Err(error),
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::browser_surface::supports(kind) {
                    let pending = crate::browser_surface::epoch(&request)
                        .and_then(|epoch| browser_surfaces.submit(command, epoch));
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = match pending {
                            Ok(receipt) => receipt.await.unwrap_or_else(|_| Err(anyhow!("Browser surface closed."))),
                            Err(error) => Err(error),
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind,"project.folder.materialize"|"project.folder.delete") {
                    let folders = folders.clone();
                    let runs = runs.clone();
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let command = &request["command"];
                        let result = async {
                            if command["type"] == "project.folder.delete" {
                                runs.stop_project(&command["projectId"]).await?;
                            }
                            folders.execute_routed(command, &routing, &scope).await
                        }.await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::external_history::supports(kind) || crate::attachments::commands::Commands::supports(kind) {
                    let external_history = external_history.clone();
                    let attachments = attachment_commands.clone();
                    let routing = routing.clone();
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let command = &request["command"];
                        let result = if crate::external_history::supports(command["type"].as_str().unwrap()) {
                            external_history.execute(command, &routing, encryption, &scope).await
                        } else {
                            attachments.execute(command, &encryption, &scope).await
                        };
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::project_exports::supports(kind) {
                    let project_exports = project_exports.clone();
                    let routing = routing.clone();
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = project_exports.execute(&request["command"], &routing, &encryption, &scope).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::github::conversion::supports(kind) {
                    let folder_conversion = folder_conversion.clone();
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = folder_conversion.execute_routed(&request["command"], &routing, &scope).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == crate::replicas::retained::COMMAND {
                    let replicas = replicas.clone();
                    let routing = routing.clone();
                    let runs = runs.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = async {
                            let command = routing.resolve(&request["command"]).await?;
                            let target = command["path"].as_js_string().context("Managed repository path")?;
                            replicas.remove_retained(target, &scope, |path| async move {
                                runs.stop_canonical_path(&path).await
                            }).await
                        }.await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if matches!(kind,"project.replica.provision"|"project.replica.link.repair"|"project.replica.synchronize"|"project.replica.remove") {
                    let replicas=replicas.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let command=&request["command"];
                        let result=replicas.execute_routed(command,&routing,&scope,&|progress|{
                            let event=json!({"type":"project.replica.progress","jobId":command["jobId"],"attempt":command["attempt"],"progress":progress});
                            if let Err(error)=outgoing.send(json!({"kind":"event","requestId":request["requestId"],"event":event})) {
                                logs.event("error","Worker command event was rejected",json!({"event":"worker.command.invalid-event","workerId":worker,"error":logging::error(&error)}));
                            }
                        }).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if matches!(kind, crate::script_commands::PROJECT | crate::script_commands::TERMINAL) {
                    let routing = routing.clone();
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = async {
                            let command = routing.resolve(&request["command"]).await?;
                            crate::script_commands::execute(&command, &encryption, scope).await
                        }.await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::project_stats::supports(kind) {
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = async {
                            let command = routing.resolve(&request["command"]).await?;
                            crate::project_stats::execute(&command, scope).await
                        }.await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::github::Client::supports(kind) {
                    let github=github.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result=github.execute(&request["command"],&scope).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if crate::cantrip_os::Controller::supports(kind) {
                    let controller = cantrip_os.clone();
                    let routing = routing.clone();
                    let encryption = encryption.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let lifetime = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = controller.execute(&request["command"], &routing, &encryption, &lifetime).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::run_runtime::Manager::supports(kind) {
                    let runs = runs.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = runs.execute(&request["command"], &scope).await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if crate::run_definitions::Definitions::supports(kind) {
                    let definitions = run_definitions.clone();
                    let encryption = encryption.clone();
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result = definitions
                            .execute(&request["command"], &routing, scope, outgoing.clone(), encryption)
                            .await;
                        finish(&request, &worker, &logs, &outgoing, began, &result);
                    });
                    continue;
                }
                if kind == "terminal.input" && runs.owns_terminal(&command["terminalId"]) {
                    let result = Err(anyhow!("Run configuration terminals are read-only."));
                    finish(&request, &worker, logs, &outgoing, began, &result);
                    continue;
                }
                if crate::terminal_services::interactive::Shells::supports(kind) {
                    let shells=shells.clone();let encryption=encryption.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::filesystem::Scope::with_stop(stop_rx.clone());
                    let turns = turns.clone();
                    let binary = codex_binary.clone();
                    commands.spawn(async move {
                        let result=shells.execute(&request["command"], crate::terminal_services::interactive::Ports {
                            encryption:&encryption,routes:&routing,scope:&scope,codex_binary:&binary,turns:&turns,outbound:&outgoing,
                            request_id:&request["requestId"],socket_epoch:request["socketEpoch"].as_u64().unwrap_or_default(),
                        }).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if matches!(kind,"terminal.services.reconcile"|"terminal.service.restart") {
                    let shells=shells.clone();let terminals=terminals.clone();let encryption=encryption.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result=terminals.execute(&request["command"],&encryption,&routing,&scope,&shells).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if matches!(kind,"explorer.operation"|"file-document.operation"|"chat.files.references"|"chat.scratch.files.operation") {
                    let operations=explorer_operations.clone();let encryption=encryption.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result=operations.execute(&request["command"],&encryption,&routing,&scope).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if kind=="repository.operation" {
                    let operations=repository_operations.clone();let encryption=encryption.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::workspace::Scope::with_stop(stop_rx.clone());
                    let turns = turns.clone();
                    let signal = command_signal.clone();
                    commands.spawn(async move {
                        let result=operations.execute_with_drafts(&request["command"],&encryption,&routing,&scope,Some((&turns,signal))).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if kind=="worktree.observation.configure" {
                    let observations=worktree_observations.clone();let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();
                    let codegraph = codegraph.clone();
                    commands.spawn(async move {
                        match observations.execute_routed(&request["command"], &routing).await {
                            Ok((receipt, targets)) => {
                                finish(&request,&worker,&logs,&outgoing,began,&Ok(receipt));
                                codegraph.configure(targets).await;
                            }
                            Err(error) => finish(&request,&worker,&logs,&outgoing,began,&Err(error)),
                        }
                    });
                    continue;
                }
                if crate::codegraph::supports(kind) {
                    let codegraph = codegraph.clone();
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    commands.spawn(async move {
                        let result = codegraph.execute(&request["command"], &routing).await;
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if matches!(kind,"worktree.list"|"worktree.reconcile"|"worktree.create"|"worktree.remove"|"worktree.lock"|"worktree.unlock"|"worktree.prune"|"worktree.status") {
                    let worktrees = worktrees.clone();
                    let codegraph = codegraph.clone();
                    let runs = runs.clone();
                    let routing = routing.clone();
                    let logs = logs.clone();
                    let outgoing = outgoing.clone();
                    let worker = worker.clone();
                    let scope = crate::filesystem::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let before_remove = move |path: std::path::PathBuf| {
                            let runs = runs.clone();
                            let work: futures::future::BoxFuture<'static, Result<()>> =
                                Box::pin(async move { runs.stop_path(&path).await });
                            work
                        };
                        let result = match worktrees
                            .execute_routed(&request["command"], &routing, &scope, Some(&before_remove))
                            .await {
                            Ok((receipt, removed)) => {
                                if let Some(path) = removed { codegraph.detach(&path).await; }
                                Ok(receipt)
                            }
                            Err(error) => Err(error),
                        };
                        finish(&request,&worker,&logs,&outgoing,began,&result);
                    });
                    continue;
                }
                if matches!(kind,"workspace.repositories.discover"|"workspace.repository-import.validate") {
                    let routing=routing.clone();let logs=logs.clone();let outgoing=outgoing.clone();let worker=worker.clone();let scope=crate::workspace::Scope::with_stop(stop_rx.clone());
                    commands.spawn(async move {
                        let result=crate::workspace::execute_routed(&request["command"],&routing,&scope,|event|{
                                if let Err(error)=outgoing.send(json!({"kind":"event","requestId":request["requestId"],"event":event})) {
                                    logs.event("error","Worker command event was rejected",json!({"event":"worker.command.invalid-event","workerId":worker,"error":logging::error(&error)}));
                                }
                            }).await;
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
    let automation_closed = automation_task.await;
    managed_web.stop();
    command_shutdown.abort(anyhow::anyhow!("Worker shutting down."));
    browser_surfaces.close().await;
    desktop_inventory.close().await;
    worktree_observations.close().await;
    codegraph.close().await;
    timers.abort_all();
    while timers.join_next().await.is_some() {}
    let observations = auth_observations.stop();
    let (auth_stopped, grok_stopped, observations_stopped) = tokio::join!(
        account_auth.close(),
        grok_auth.close(),
        futures::future::join_all(observations),
    );
    let codex_stopped = codex.close().await;
    let provider_access_closed = provider_access.close().await;
    let history_stopped = history.stop().await;
    let task_outcomes_closed = task_outcomes.await;
    let worker_link_closed = worker_link_task.await;
    let direct_closed = direct_task.await;
    let managed_web_closed = managed_web_task.await;
    let goal_delivery_closed = goal_delivery.await;
    let settings_delivery_closed = settings_delivery.await;
    let deferred_delivery_closed = deferred_delivery.await;
    let shells_closed = shells.shutdown().await;
    while let Some(result) = commands.join_next().await {
        if let Err(error) = result {
            command_failure.get_or_insert(error);
        }
    }
    explorer_operations.close().await;
    project_exports.close().await;
    chat_relocation.close().await;
    shares.shutdown().await;
    run_definitions.close().await;
    let runs_closed = runs.close().await;
    let cli_closed = cli.close().await;
    if let Err(error) = project_goals.flush().await {
        project_goals.report(&error);
    }
    settings.finish(logs).await;
    let encryption_closed = encryption.close().await;
    drop(turns);
    drop(goals);
    drop(skill_settings);
    let github_closed = github.drain().await;
    let terminals_closed = terminals.close().await;
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
    // The command connection's reconnect callback still owns a Turns clone.
    // Join it before closing the shared managed preparation service.
    let preparation_closed = thread_preparation.close().await;
    outgoing.close();
    terminals_closed?;
    shells_closed?;
    runs_closed?;
    cli_closed?;
    github_closed?;
    automation_closed?;
    task_outcomes_closed?;
    worker_link_closed?;
    direct_closed?;
    managed_web_closed??;
    goal_delivery_closed?;
    settings_delivery_closed?;
    deferred_delivery_closed?;
    encryption_closed?;
    auth_stopped?;
    grok_stopped?;
    observations_stopped
        .into_iter()
        .collect::<std::result::Result<(), _>>()?;
    codex_stopped?;
    preparation_closed?;
    provider_access_closed?;
    for pending in history_stopped? {
        logs.event("warn", "Native history source frames remain unsaved", json!({"event":"codex.history.source-unsaved","subsystem":"codex","operation":"shutdown","chatId":pending["chatId"],"threadId":pending["threadId"],"counts":json!({"pendingRecords":pending["pendingRecords"]})}));
    }
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
            let error = if let Some(error) = error.downcast_ref::<crate::routing::ProtectedError>()
            {
                match error.code {
                    Some(code) => json!({"message":error.to_string(),"code":code}),
                    None => json!({"message":error.to_string()}),
                }
            } else {
                match error.downcast_ref::<ServiceError>() {
                    Some(error) => match error.code {
                        Some(code) => json!({"code":code,"message":error.message}),
                        None => json!({"message":error.message}),
                    },
                    None => json!({"message":error.to_string()}),
                }
            };
            json!({"kind":"response","requestId":request["requestId"],"ok":false,"error":error})
        }
    };
    let outcome = crate::outcomes::chat(&request["command"], &response);
    let sent = if matches!(
        kind,
        "surface.desktop.targets"
            | crate::desktop_inventory::preview::PREPARE_OS_DESKTOP
            | crate::desktop_inventory::PROBE
            | crate::worker_link::PREPARE_GUEST_TUNNEL
    ) {
        if let Some(epoch) = request["socketEpoch"].as_u64() {
            outgoing.send_for_epoch(epoch, response)
        } else {
            Ok(false)
        }
    } else {
        outgoing.send(response)
    };
    if let Err(error) = sent {
        logs.event("error","Worker command response was rejected",json!({"event":"worker.command.invalid-response","workerId":worker,"error":logging::error(&error)}));
    }
    if let Err(error) = outcome.and_then(|note| {
        if let Some(note) = note {
            outgoing.send(json!({"kind":"notification","notification":note}))?;
        }
        Ok(())
    }) {
        logs.event("warn","Chat turn recovery notification was rejected",json!({"event":"codex.turn.outcome-publication-failed","workerId":worker,"requestId":request["requestId"],"error":logging::error(&error)}));
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
    (encryption, worker_link, managed_web, codegraph, effects): (
        Arc<Service>,
        Arc<crate::worker_link::Coordinator>,
        Arc<crate::managed_web::Runtimes>,
        Arc<crate::codegraph::Supervisor>,
        crate::desktop_inventory::EffectUpdates,
    ),
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
        worker_link.reconcile();
        if let Err(error) = refresh {
            let worker = config.lock().unwrap().worker_id.clone();
            logs.repeated(format!("worker-encryption-refresh-failed:{}",worker.lossy()),"warn","Worker protected server connection is not ready",json!({"event":"worker.encryption.refresh-failed","subsystem":"worker-encryption","operation":"refresh-grants","reasonCode":"request-failed","status":"retrying","workerId":worker,"error":logging::error(&anyhow!(error))}));
        }
        heartbeat["encryption"] = encryption.status();
        heartbeat["webRuntimes"] = managed_web.capabilities();
        heartbeat["codegraph"] = codegraph.status();
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
            Ok(preferences) => {
                if let Some(preferences) = preferences {
                    effects.publish(preferences);
                }
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
