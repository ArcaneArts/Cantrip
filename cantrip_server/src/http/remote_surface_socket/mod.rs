//! Authenticated legacy surface attachment, including late ACK and OS fencing.
mod relay;
mod transport;
use super::{
    account,
    middleware::{self, Context},
    websocket,
};
use crate::{
    auth::service::AuthService,
    live::{Socket as _, TransportLifetime},
    relay::SurfacePermit,
    remote_surfaces::Repository,
    settings::repository::SettingsRepository,
    wire::{self, Value, coercion, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension,
    extract::{Path, Request, State},
    response::Response,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use transport::Peer;

#[derive(Default)]
struct StateData {
    closed: bool,
    attached: bool,
    worker: Option<String>,
    quota: Option<SurfacePermit>,
    relay: Option<Arc<relay::Relay>>,
}
struct Connection {
    service: Arc<AuthService>,
    peer: Arc<Peer>,
    owner: String,
    surface: String,
    attachment: String,
    viewport: Value,
    state: Mutex<StateData>,
}
impl Connection {
    fn send(&self, message: Value) -> Result<()> {
        if self.peer.is_open() {
            let encoded = crate::settings::parse_response(
                "remoteSurfaceConnectionMessageSchema",
                Some(&message),
            )?
            .stringify();
            self.peer.send(Arc::from(encoded.as_str()))?;
            self.service.usage.record(
                &self.owner,
                "remote-surface-relay",
                false,
                encoded.len(),
                1,
                true,
            );
        }
        Ok(())
    }
    fn detach(&self, worker: String) {
        let (commands, surface, attachment) = (
            self.service.workers.commands.clone(),
            self.surface.clone(),
            self.attachment.clone(),
        );
        self.service.worker_maintenance.spawn_child(async move {
            let _ = commands
                .request(
                    &worker,
                    json!({"type":"surface.detach","surfaceId":surface,"attachmentId":attachment}),
                    None,
                    None,
                )
                .await;
            Ok(())
        });
    }
    fn cleanup(&self) {
        let (relay, quota, worker, remaining) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            let (worker, remaining) = if state.attached {
                state.attached = false;
                (
                    state.worker.clone(),
                    Some(
                        self.service
                            .surface_attachment_counts
                            .detached(&self.surface),
                    ),
                )
            } else {
                (None, None)
            };
            (state.relay.take(), state.quota.take(), worker, remaining)
        };
        drop(quota);
        // Source installs its attachment close listener before the relay listener.
        if let Some(worker) = worker {
            if self.service.workers.commands.is_connected(&worker) {
                self.detach(worker.clone());
            }
            if remaining == Some(0) {
                let (service, owner, surface) = (
                    self.service.clone(),
                    self.owner.clone(),
                    self.surface.clone(),
                );
                let connected = service.workers.commands.is_connected(&worker);
                self.service.worker_maintenance.spawn_child(async move {
                    Repository::new(service.repository.database.clone())
                        .record_status(
                            &service.live,
                            &owner,
                            &surface,
                            if connected { "idle" } else { "offline" },
                            if connected {
                                None
                            } else {
                                Some("Worker is offline.")
                            },
                        )
                        .await
                });
            }
        }
        if let Some(relay) = relay {
            relay.cleanup();
        }
    }
    fn message(&self, bytes: &[u8], binary: bool) -> Result<()> {
        let relay = self.state.lock().unwrap().relay.clone();
        if let Some(relay) = relay {
            relay.message(bytes, binary)?;
        }
        Ok(())
    }
    async fn start(self: Arc<Self>) -> Result<()> {
        let repository = Repository::new(self.service.repository.database.clone());
        let Some(context) = repository.context(&self.owner, &self.surface).await? else {
            self.send(
                json!({"type":"error","message":"Remote Surface not found.","recoverable":false}),
            )?;
            self.peer.close(1008, "Remote Surface not found");
            return Ok(());
        };
        let worker = context["workerId"]
            .as_str()
            .context("Surface worker")?
            .to_owned();
        self.state.lock().unwrap().worker = Some(worker.clone());
        let quota = match self
            .service
            .workers
            .relay_quotas
            .acquire_surface(&self.owner, &worker)
        {
            Ok(quota) => quota,
            Err(cause) => {
                self.send(json!({"type":"error","message":cause.message,"recoverable":true}))?;
                self.peer.close(1013, "Remote Surface quota reached");
                return Ok(());
            }
        };
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                drop(quota);
                return Ok(());
            }
            state.quota = Some(quota);
        }
        let surface = &context["surface"];
        let desktop_stream = if surface["kind"] == "desktop" {
            let preferences = SettingsRepository::new(self.service.repository.database.clone())
                .get_user_settings(&self.owner)
                .await?;
            json!({"targetFps":preferences["desktopFrameRate"],"quality":preferences["desktopStreamQuality"]})
        } else {
            Value::Null
        };
        if !self.service.workers.commands.is_connected(&worker) {
            repository
                .record_status(
                    &self.service.live,
                    &self.owner,
                    &self.surface,
                    "offline",
                    Some("Worker is offline."),
                )
                .await?;
            self.send(json!({"type":"error","message":"Worker is offline.","recoverable":true}))?;
            self.peer.close(1013, "Worker offline");
            return Ok(());
        }
        repository
            .record_status(
                &self.service.live,
                &self.owner,
                &self.surface,
                "connecting",
                None,
            )
            .await?;
        let capabilities = &context["remoteSurfaceCapabilities"];
        let contains = |field: &str, value: &str| {
            capabilities[field]
                .as_array()
                .is_some_and(|items| items.iter().any(|v| v == value))
        };
        let webrtc = if surface["preferredTransport"] == "webrtc"
            && contains("transports", "webrtc")
            && contains(
                "iceTransportPolicies",
                &self
                    .service
                    .config
                    .remote_surface_web_rtc
                    .ice_transport_policy,
            ) {
            crate::remote_surfaces::webrtc::configuration(
                &self.service.config.remote_surface_web_rtc,
                &self.owner,
                crate::auth::now().timestamp_millis(),
            )?
        } else {
            Value::Null
        };
        let relay = relay::Relay::bind(
            self.service.clone(),
            self.peer.clone(),
            self.owner.clone(),
            worker.clone(),
            self.surface.clone(),
            self.attachment.clone(),
        );
        self.state.lock().unwrap().relay = Some(relay.clone());
        let result:Result<()>=async {
            let os=if surface["configuration"]["kind"]=="desktop"&&coercion::truthy(surface["configuration"].get("osSource")) {
                repository.desktop_execution(&self.owner,&context).await?
            }else{None};
            let state_resource=if surface["kind"]=="browser" {
                let classification=wire::property(surface.get("titleProtection"),"classification")?;
                if wire::property(classification,"recordKind")?==Some(&json!("browser")){"browser-row"}else{"browser-remote-surface"}
            }else{"remote-desktop-row"};
            let mut command=json!({"type":"surface.attach","surfaceId":self.surface,"attachmentId":self.attachment,"projectId":surface["projectId"],"serverId":self.service.server_id,"configuration":surface["configuration"],"stateResource":state_resource,"stateRevision":surface["stateRevision"],"stateProtection":surface["stateProtection"],"preferredTransport":surface["preferredTransport"],"webrtc":webrtc,"viewport":self.viewport,"desktopStream":desktop_stream});
            if let Some(os)=&os{command["osExecution"]=os.clone();}
            let response=self.service.workers.commands.request(&worker,command,Some(Duration::from_secs(30)),None).await?;
            let response=crate::settings::parse_response("remoteSurfaceAttachResultSchema",response.as_ref())?;
            {
                let mut state=self.state.lock().unwrap();
                if state.closed{drop(state);relay.cleanup();self.detach(worker.clone());return Ok(())}
                state.attached=true;self.service.surface_attachment_counts.attached(&self.surface);
            }
            if os.is_some() {
                let current=repository.context(&self.owner,&self.surface).await?;
                let current=current.filter(|current|current["workerId"]==context["workerId"]&&["projectId","kind","stateRevision","configuration"].iter().all(|key|current["surface"][key]==surface[key])).context("Linux desktop placement or state changed while opening.")?;
                repository.desktop_execution(&self.owner,&current).await?;
            }
            repository.record_status(&self.service.live,&self.owner,&self.surface,"active",None).await?;
            self.send(json!({"type":"ready","surfaceId":self.surface,"attachmentId":self.attachment,"transport":response["transport"],"webrtc":if response["transport"]=="webrtc"{webrtc}else{Value::Null}}))?;
            Ok(())
        }.await;
        if let Err(cause) = result {
            relay.cleanup();
            let unavailable = matches!(cause.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable);
            let message = if unavailable {
                "Worker is offline."
            } else {
                "Remote Surface could not be opened."
            };
            repository
                .record_status(
                    &self.service.live,
                    &self.owner,
                    &self.surface,
                    if unavailable { "offline" } else { "error" },
                    Some(message),
                )
                .await?;
            self.send(json!({"type":"error","message":message,"recoverable":true}))?;
            self.peer.close(1013, "Remote Surface unavailable");
        }
        Ok(())
    }
}
pub(super) async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(surface): Path<String>,
    request: Request,
) -> Response {
    let origin = middleware::value(request.headers(), "origin");
    let query = account::query(request.uri());
    let lifetime = service.live.transports.begin();
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, _| run(socket, service, ctx, origin, query, surface, lifetime),
    )
}
pub(super) async fn head(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    _request: Request,
) -> Response {
    // Observed automatic HEAD behavior of Fastify's websocket-only handler.
    middleware::failure(
        &service,
        &ctx.id,
        &anyhow::anyhow!("socket.close is not a function"),
    )
}
async fn run(
    mut socket: websocket::WebSocket,
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    origin: Option<String>,
    query: Value,
    surface: String,
    lifetime: TransportLifetime,
) {
    let (send, outgoing) = mpsc::unbounded_channel();
    let peer = Arc::new(Peer {
        open: AtomicBool::new(true),
        buffered: Default::default(),
        queue: Mutex::new(send),
        deadline: socket.close_deadline_signal(),
        forced: socket.force_close_signal(),
    });
    lifetime.attach(peer.clone());
    let mut registration = None;
    let mut connection = None;
    if !origin.is_some_and(|origin| service.config.app_origins.contains(&origin)) {
        peer.close(1008, "Origin not allowed");
    } else if let Some(user) = ctx.principal.user.as_ref() {
        registration = service.live.sessions.register(
            peer.clone(),
            &user.id,
            ctx.principal.session_id.as_deref(),
        );
        if registration.is_some() {
            let viewport = Value::object(
                [
                    ("width", 1280.0),
                    ("height", 720.0),
                    ("devicePixelRatio", 1.0),
                ]
                .into_iter()
                .map(|(key, default)| {
                    let number = match query.get(key).filter(|v| !v.is_null()) {
                        Some(value) => coercion::number(Some(value)).unwrap_or(f64::NAN),
                        None => default,
                    };
                    (key, Value::Number(number))
                }),
            );
            match wire::parse("remoteSurfaceViewportSchema", Some(&viewport)) {
                Ok(viewport) => {
                    connection = Some(Arc::new(Connection {
                        service: service.clone(),
                        peer: peer.clone(),
                        owner: user.id.clone(),
                        surface,
                        attachment: uuid::Uuid::new_v4().to_string(),
                        viewport,
                        state: Mutex::new(StateData::default()),
                    }))
                }
                Err(_) => peer.close(1008, "Invalid viewport"),
            }
        }
    } else {
        peer.close(1008, "Authentication is required");
    }
    let retained = connection.clone();
    let retained_peer = peer.clone();
    socket.on_closed(move || {
        retained_peer.open.store(false, Ordering::Release);
        if let Some(connection) = retained {
            connection.cleanup();
        }
        drop(registration);
        drop(lifetime);
    });
    if let Some(connection) = &connection {
        let connection = connection.clone();
        service.worker_maintenance.spawn_child(async move {
            if let Err(cause) = connection.clone().start().await {
                crate::operations::logging::server_logger()(
                    crate::operations::logging::LogCall::event(
                        "error", "Remote Surface connection failed",
                        json!({"err":crate::operations::logging::error_details(&cause),"surfaceId":connection.surface}),
                    ),
                );
                let sent = connection.send(json!({"type":"error","message":"Remote Surface could not be opened.","recoverable":true}));
                connection.peer.close(1013, "Remote Surface unavailable");
                sent?;
            }
            Ok(())
        });
    }
    transport::pump(socket, peer, connection, outgoing).await;
}
