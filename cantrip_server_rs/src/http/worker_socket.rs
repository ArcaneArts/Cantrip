use super::{
    account,
    middleware::{self, Context},
    websocket::{self, WebSocket},
};
use crate::{
    auth::service::AuthService,
    wire::Value,
    workers::{
        bridge::{Continuity, Outgoing, Peer},
        credentials,
        service::WorkerService,
    },
};
use axum::{
    Extension, Router,
    extract::{Request, State},
    response::Response,
    routing::get,
};
use futures::{FutureExt, SinkExt, StreamExt};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tungstenite::{Message, protocol::CloseFrame};
use uuid::Uuid;

const V1: &str = "cantrip-worker-auth-ready-v1";
const V2: &str = "cantrip-worker-auth-ready-v2";
struct AuthenticationBuffer {
    service: Arc<WorkerService>,
    bytes: usize,
    messages: Vec<Message>,
}
impl AuthenticationBuffer {
    fn clear(&mut self) {
        self.service
            .buffered_authentication_bytes
            .fetch_sub(self.bytes, Ordering::AcqRel);
        self.bytes = 0;
        self.messages.clear();
    }
    fn push(&mut self, message: Message) -> Result<(), (u16, &'static str)> {
        let bytes = match &message {
            Message::Text(text) => text.len(),
            Message::Binary(bytes) => bytes.len(),
            _ => return Ok(()),
        };
        if self.messages.len() >= 1024 || self.bytes + bytes > 8 * 1024 * 1024 {
            return Err((1009, "Worker authentication buffer exceeded"));
        }
        if self
            .service
            .buffered_authentication_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes)
                    .filter(|total| *total <= 64 * 1024 * 1024)
            })
            .is_err()
        {
            return Err((1013, "Worker authentication capacity is unavailable"));
        }
        self.bytes += bytes;
        self.messages.push(message);
        Ok(())
    }
}
impl Drop for AuthenticationBuffer {
    fn drop(&mut self) {
        self.clear();
    }
}
fn connection(state: &str, generation: &str, protocol: &str, server: &str) -> String {
    let mut value = Value::from_serialize(
        &serde_json::json!({"kind":"connection","state":state,"protocolVersion":if protocol==V2{2}else{1},"connectionGeneration":generation}),
    );
    if protocol == V2 {
        value["serverControlPlaneGeneration"] = Value::String(server.into());
    }
    value.stringify()
}
async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Message::Close(Some(CloseFrame {
            code: code.into(),
            reason: reason.to_owned().into(),
        }))),
    )
    .await;
}
async fn connect(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let query = account::query(request.uri());
    let authorization = middleware::value(request.headers(), "authorization");
    websocket::upgrade(
        request,
        service.config.websocket_max_payload_bytes as usize,
        move |socket, selected| run(socket, service, ctx, query, authorization, selected),
    )
}
async fn run(
    mut socket: WebSocket,
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    query: Value,
    authorization: Option<String>,
    protocol: Option<String>,
) {
    let state = &service.workers;
    let Ok(permit) = state.handshakes.clone().try_acquire_owned() else {
        close(
            &mut socket,
            1013,
            "Worker authentication capacity is unavailable",
        )
        .await;
        return;
    };
    let Some(worker) = query["workerId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
    else {
        close(&mut socket, 1008, "Unauthorized").await;
        return;
    };
    let generation = query.get("connectionGeneration");
    let valid_generation = |value: &Value| {
        value.as_str().is_some_and(|value| {
            static UUID: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            UUID.get_or_init(|| {
                regex::Regex::new(
                    "(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                )
                .unwrap()
            })
            .is_match(value)
        })
    };
    if generation.is_some_and(|value| !valid_generation(value)) {
        close(&mut socket, 1008, "Unauthorized").await;
        return;
    }
    let negotiated = protocol.as_deref().is_some_and(|p| p == V1 || p == V2);
    if negotiated && generation.is_none() {
        close(
            &mut socket,
            1002,
            "Worker connection generation is required",
        )
        .await;
        return;
    }
    let generation = generation
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if negotiated
        && socket
            .send(Message::Text(
                connection(
                    "pending",
                    &generation,
                    protocol.as_deref().unwrap(),
                    &state.control_generation,
                )
                .into(),
            ))
            .await
            .is_err()
    {
        return;
    }
    let mut shutdown = state.shutdown.subscribe();
    if *shutdown.borrow() {
        close(&mut socket, 1001, "Server shutting down").await;
        return;
    }
    let authentication = async {
        let authenticated = credentials::authenticate(
            &state.repository,
            &service.config,
            authorization.as_deref(),
            &worker,
            "worker:connect",
        )
        .await?;
        let Some(authenticated) = authenticated else {
            return Ok::<_, anyhow::Error>(Err("Unauthorized"));
        };
        if !authenticated.development
            && state
                .revoked
                .read()
                .unwrap()
                .contains(&authenticated.credential.id)
        {
            return Ok(Err("Worker credential was revoked"));
        }
        if state.repository.owner(&worker).await?.as_deref()
            != Some(authenticated.credential.owner_id.as_str())
        {
            return Ok(Err("Worker identity mismatch"));
        }
        Ok(Ok(authenticated))
    };
    tokio::pin!(authentication);
    let timeout = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(timeout);
    let mut buffer = AuthenticationBuffer {
        service: state.clone(),
        bytes: 0,
        messages: Vec::new(),
    };
    let mut abandoned = false;
    // Authentication is a database operation that outlives a closed socket in
    // the reference server. Continue its side effects and keep its capacity
    // permit, while independently completing the WebSocket close handshake.
    let mut socket = Some(socket);
    let authenticated = loop {
        tokio::select! {biased;
            input=async{socket.as_mut().unwrap().recv().await},if socket.is_some()=>{match input{
                Some(Ok(Message::Close(_)))=>{abandoned=true;buffer.clear();let _=socket.as_mut().unwrap().flush().await;socket=None;},
                None=>{abandoned=true;buffer.clear();socket=None;},
                Some(Err(error))=>{abandoned=true;buffer.clear();if let Some(code)=protocol_close(&error){close(socket.as_mut().unwrap(),code,"").await;}socket=None;},
                Some(Ok(message))=>{if !abandoned&& let Err((code,reason))=buffer.push(message){abandoned=true;buffer.clear();close(socket.as_mut().unwrap(),code,reason).await;}}
            }},
            _=shutdown.changed()=>{
                buffer.clear();
                if let Some(socket)=socket.as_mut(){close(socket,1001,"Server shutting down").await;}
                drop(socket.take());
                // As with a peer close, shutdown must finish credential usage
                // and the owner lookup. Main drains these handshake permits
                // before closing the database pool.
                let _ = authentication.await;
                return;
            },
            _=&mut timeout,if !abandoned=>{abandoned=true;buffer.clear();close(socket.as_mut().unwrap(),1013,"Worker authentication timed out").await;},
            result=&mut authentication=>{if abandoned{return}match result{Ok(Ok(authenticated))=>break authenticated,Ok(Err(reason))=>{close(socket.as_mut().unwrap(),1008,reason).await;return},Err(_)=>return}}
        }
    };
    let mut socket = socket.expect("authenticated worker transport remains open");
    let owner = authenticated.credential.owner_id;
    let (peer, mut output) = Peer::new(Continuity {
        owner: owner.clone(),
        credential: authenticated.credential.id,
        process_generation: generation.clone(),
    });
    let ready = negotiated.then(|| {
        connection(
            "ready",
            &generation,
            protocol.as_deref().unwrap(),
            &state.control_generation,
        )
    });
    // Register the attachment generation under the final revocation check.
    // Shared attachment begins eagerly, but Redis IO never holds this lock.
    // A revoker either rejects it here or invalidates the in-flight generation.
    service
        .managed_preparation
        .subscribe(&state.bridge, &worker);
    service.worktree_observations.subscribe(&worker);
    service.run_configuration_observations.subscribe(&worker);
    let attaching = {
        let revoked = state.revoked.read().unwrap();
        if !authenticated.development && revoked.contains(&peer.identity.credential) {
            None
        } else {
            Some(state.bridge.attach_worker(
                worker.clone(),
                peer.clone(),
                Some(owner.clone()),
                ready,
            ))
        }
    };
    let Some(mut attaching) = attaching else {
        close(&mut socket, 1008, "Worker credential was revoked").await;
        return;
    };
    let mut attaching_close = peer.closing.subscribe();
    let accepted = if let Some(result) = attaching.as_mut().now_or_never() {
        result
    } else {
        loop {
            let closed = attaching_close.borrow().clone();
            if let Some((code, reason)) = closed {
                buffer.clear();
                close(&mut socket, code, &reason).await;
                return;
            }
            tokio::select! {biased;
                _=attaching_close.changed()=>continue,
                _=shutdown.changed()=>{
                    peer.open.store(false, Ordering::Release);
                    buffer.clear();close(&mut socket,1001,"Server shutting down").await;return;
                },
                input=socket.recv()=>match input {
                    None=>{peer.open.store(false,Ordering::Release);return;},
                    Some(Ok(Message::Close(_)))=>{peer.open.store(false,Ordering::Release);buffer.clear();let _=socket.flush().await;return;},
                    Some(Err(error))=>{peer.open.store(false,Ordering::Release);buffer.clear();if let Some(code)=protocol_close(&error){close(&mut socket,code,"").await;}return;},
                    Some(Ok(message))=>{if let Err((code,reason))=buffer.push(message){peer.open.store(false,Ordering::Release);buffer.clear();close(&mut socket,code,reason).await;return;}},
                },
                result=&mut attaching=>break result,
            }
        }
    };
    let closed = peer.closing.borrow().clone();
    if let Some((code, reason)) = closed {
        close(&mut socket, code, &reason).await;
        return;
    }
    match accepted {
        Ok(true) => {}
        Ok(false) => {
            peer.open.store(false, Ordering::Release);
            close(&mut socket, 1012, "Worker connection was not accepted").await;
            return;
        }
        Err(_) => {
            peer.open.store(false, Ordering::Release);
            eprintln!(
                "{}",
                serde_json::json!({"event":"worker.connection.claim-failed","subsystem":"worker-connection","operation":"connect","reasonCode":"coordination-unavailable","status":"failed","workerId":worker})
            );
            close(
                &mut socket,
                1013,
                "Worker relay coordination is unavailable",
            )
            .await;
            return;
        }
    }
    state.invalidate(&owner, "worker-availability", &worker);
    // Keep the subscription for this socket's lifetime. Notifications only wake
    // durable delivery; its exact worker ACK establishes physical settlement.
    let weak = Arc::downgrade(state);
    let target_worker = worker.clone();
    let _task_settlements = state.bridge.subscribe_owned_notifications(
        &worker,
        Arc::new(move |owner, event| {
            let weak = weak.clone();
            let worker = target_worker.clone();
            async move {
                if event["type"] == "inference.task-settled"
                    && event["ownerId"] == owner
                    && event["workerId"] == worker
                    && let Some(state) = weak.upgrade()
                    && state
                        .bridge
                        .connection_identity(&worker)
                        .is_some_and(|identity| {
                            identity.owner == owner
                                && event["workerGeneration"] == identity.process_generation
                        })
                {
                    crate::workers::resource_revocations::wake(state, &owner, &worker);
                }
                Ok(())
            }
            .boxed()
        }),
    );
    crate::workers::resource_revocations::wake(state.clone(), &owner, &worker);
    drop(
        service
            .provider_accounts
            .synchronize_inference(&owner, &worker),
    );
    service.execution.worker_connected(&worker);
    crate::project_alerts::worker_connected(
        service.clone(),
        owner.clone(),
        worker.clone(),
        peer.identity.process_generation.clone(),
    );
    service
        .run_configuration_observations
        .worker_connected(owner.clone(), worker.clone());
    service
        .worktree_observations
        .schedule_worker(owner.clone(), worker.clone());
    service.managed_preparation.schedule_worker(
        peer.identity.owner.clone(),
        worker.clone(),
        service
            .native_handoffs
            .worker_connected(&peer.identity.owner, &worker),
    );
    service.folder_setup.worker_connected(worker.clone());
    service.project_replicas.worker_connected(worker.clone());
    service.chat_relocations.worker_connected(worker.clone());
    service.github_conversion.worker_connected(worker.clone());
    service.workspace_discovery.worker_connected(worker.clone());
    service.scratch_roots.worker_connected(worker.clone());
    service.worker_maintenance.worker_connected(
        ctx.principal.user.as_ref().map(|user| user.id.clone()),
        worker.clone(),
    );
    drop(permit);
    for message in std::mem::take(&mut buffer.messages) {
        receive(
            state.bridge.local(),
            &service.usage,
            &worker,
            &peer,
            message,
        );
    }
    drop(buffer);
    let (mut sink, mut stream) = socket.split();
    let mut closing = peer.closing.subscribe();
    let writer = async {
        loop {
            let closed = closing.borrow().clone();
            let stopped = *shutdown.borrow();
            if let Some((code, reason)) =
                closed.or_else(|| stopped.then(|| (1001, "Server shutting down".into())))
            {
                peer.open.store(false, Ordering::Release);
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    sink.send(Message::Close(Some(CloseFrame {
                        code: code.into(),
                        reason: reason.into(),
                    }))),
                )
                .await;
                break;
            }
            tokio::select! {biased;_ = closing.changed()=>continue,_ = shutdown.changed()=>continue,message=output.recv()=>{
                let Some(message)=message else{break};match message{
                    Outgoing::Close(code,reason)=>{let _=tokio::time::timeout(Duration::from_secs(1),sink.send(Message::Close(Some(CloseFrame{code:code.into(),reason:reason.into()})))).await;break},
                    Outgoing::Text(mut text)=>{let message=Message::Text(text.take().into());tokio::select!{biased;_=closing.changed()=>continue,_=shutdown.changed()=>continue,result=sink.send(message)=>{if result.is_err(){break}}}},
                    Outgoing::Binary(mut frame)=>{let message=Message::Binary(tungstenite::Bytes::from_owner(frame.take()));tokio::select!{biased;_=closing.changed()=>continue,_=shutdown.changed()=>continue,result=sink.send(message)=>{if result.is_err(){break}}}}
                    Outgoing::Tunnel(mut frame)=>{let message=Message::Binary(tungstenite::Bytes::from_owner(frame.take()));tokio::select!{biased;_=closing.changed()=>continue,_=shutdown.changed()=>continue,result=sink.send(message)=>{if result.is_err(){break}}}}
                    Outgoing::Surface(mut frame)=>{let message=Message::Binary(tungstenite::Bytes::from_owner(frame.take()));tokio::select!{biased;_=closing.changed()=>continue,_=shutdown.changed()=>continue,result=sink.send(message)=>{if result.is_err(){break}}}}
                }
            }}
        }
    };
    tokio::pin!(writer);
    let mut input_closed = false;
    loop {
        tokio::select! {_=&mut writer=>break,message=stream.next(),if !input_closed=>{match message{
            Some(Ok(Message::Close(frame)))=>{input_closed=true;let (code,reason)=frame.map_or((1000,String::new()),|frame|(frame.code.into(),frame.reason.to_string()));peer.close(code,&reason);},
            Some(Err(error))=>{if let Some(code)=protocol_close(&error){input_closed=true;peer.close(code,"");}else{break}},
            None=>break,
            Some(Ok(message))=>receive(state.bridge.local(),&service.usage,&worker,&peer,message)
        }}}
    }
    peer.open.store(false, Ordering::Release);
    state.bridge.clone().local_arc().interrupted(&worker, &peer);
}
fn protocol_close(error: &tungstenite::Error) -> Option<u16> {
    match error {
        tungstenite::Error::Utf8(..) => Some(1007),
        tungstenite::Error::Capacity(..) => Some(1009),
        tungstenite::Error::Protocol(..) => Some(1002),
        _ => None,
    }
}
fn receive(
    bridge: &crate::workers::bridge::WorkerBridge,
    usage: &crate::usage::service::UsageService,
    worker: &str,
    peer: &Peer,
    message: Message,
) {
    if let Message::Binary(bytes) = message {
        if crate::tunnels::frame::is_frame(&bytes) {
            bridge.receive_tunnel_frame(worker, peer, bytes.to_vec().into());
        } else if crate::worker_links::frame::is_frame(&bytes) {
            bridge.receive_worker_link_frame(worker, peer, bytes.to_vec().into());
        } else {
            bridge.receive_surface_frame(worker, peer, bytes.to_vec().into());
        }
    } else if let Message::Text(text) = message {
        usage.record(
            &peer.identity.owner,
            "worker-control-websocket",
            true,
            text.len(),
            1,
            true,
        );
        bridge.receive(worker, peer, &text);
    }
    // Other binary protocols retain their separate tunnel/surface consumers.
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/internal/workers/connect", get(connect))
}
