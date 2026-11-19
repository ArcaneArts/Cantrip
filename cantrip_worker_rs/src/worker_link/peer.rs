//! Worker-owned WebRTC rounds under Core's installed WorkerLink authority.
mod lane;
mod network;

use super::{
    Coordinator, Session, checked, expiration, id, route_enabled, timestamp, validate_renewal,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use lane::{CONTROL, LANES, MAX_MESSAGE, Queue};
pub(super) use lane::{PeerCarrier, index as lane_index};
use rtc::peer_connection::configuration::setting_engine::{
    SctpMaxMessageSize, SettingEngineBuilder,
};
use rtc::peer_connection::transport::RTCDtlsRole;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::{AbortHandle, JoinSet},
    time::{Instant, timeout},
};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceCandidateInit,
        RTCIceGatheringState, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
        RTCSessionDescription,
    },
};

const MAX_SIGNALS: u64 = 256;
const EVENT_QUEUE: usize = 128;

pub(crate) fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "worker-link.peer.install"
            | "worker-link.peer.renew"
            | "worker-link.peer.revoke"
            | "worker-link.peer.signal"
    )
}

#[derive(Default)]
pub(super) struct Peers {
    active: HashMap<JsString, Round>,
    tasks: JoinSet<()>,
}

struct Round {
    session: Value,
    config: Value,
    carrier: Arc<PeerCarrier>,
    stop: watch::Sender<Option<String>>,
    signals: mpsc::Sender<Command>,
    task: AbortHandle,
}

struct Command {
    envelope: Value,
    done: oneshot::Sender<Result<()>>,
}

pub(super) fn authorized(
    sessions: &HashMap<JsString, Session>,
    peer: &Value,
    now: i64,
) -> Result<()> {
    let session = &sessions
        .get(id(peer, "sessionId"))
        .context("WorkerLink peer session is not authorized.")?
        .value;
    let parent = &session["lease"];
    let lease = &peer["lease"];
    ensure!(
        session["identity"] == peer["identity"]
            && session["routeGeneration"] == peer["routeGeneration"]
            && route_enabled(session, &peer["route"])
            && timestamp(lease, "issuedAt")? >= timestamp(parent, "issuedAt")?
            && expiration(lease)? > now
            && expiration(lease)? <= expiration(parent)?
            && timestamp(lease, "absoluteExpiresAt")? <= timestamp(parent, "absoluteExpiresAt")?,
        "WorkerLink peer session is not authorized."
    );
    Ok(())
}

impl Peers {
    pub fn install(
        &mut self,
        session: &Value,
        config: &Value,
        gateway: &Arc<Coordinator>,
    ) -> Result<()> {
        let route = session["route"].as_str().unwrap();
        ensure!(
            config["relayOnly"] == false && config["directRoutes"][route] == true,
            "The WorkerLink peer route is disabled by policy."
        );
        ensure!(
            route == "lan",
            "WorkerLink WAN peer carriage is unavailable."
        );
        let key = id(session, "peerSessionId");
        if let Some(round) = self.active.get(key) {
            ensure!(
                round.session == *session && round.config == *config,
                "WorkerLink peer installation conflicts with existing state."
            );
            return Ok(());
        }
        ensure!(
            self.active.len() < config["maxPeerSessionsPerWorker"].as_u64().unwrap() as usize,
            "The WorkerLink worker peer-session limit was reached."
        );
        let client = &session["identity"]["clientInstanceId"];
        let client_count = self
            .active
            .values()
            .filter(|round| &round.session["identity"]["clientInstanceId"] == client)
            .count();
        ensure!(
            client_count < config["maxPeerSessionsPerClient"].as_u64().unwrap() as usize,
            "The WorkerLink client peer-session limit was reached."
        );
        ensure!(
            !self.active.values().any(|round| same(
                &round.session,
                session,
                &["sessionId", "routeGeneration", "route"]
            )),
            "The WorkerLink peer round is already installed."
        );
        let (stop, stopped) = watch::channel(None);
        let (signals, input) = mpsc::channel(4);
        let (carrier, queues) = PeerCarrier::new(session.clone(), config);
        let actor = Actor::new(
            session.clone(),
            config.clone(),
            carrier.clone(),
            queues,
            Arc::downgrade(gateway),
        );
        let task = self.tasks.spawn(actor.run(stopped, input));
        self.active.insert(
            key.clone(),
            Round {
                session: session.clone(),
                config: config.clone(),
                carrier,
                stop,
                signals,
                task,
            },
        );
        Ok(())
    }

    pub fn signal(&self, envelope: &Value) -> Result<oneshot::Receiver<Result<()>>> {
        let round = self
            .active
            .get(id(envelope, "peerSessionId"))
            .context("WorkerLink peer signal authority is stale.")?;
        ensure!(
            envelope["sender"] == "client"
                && same(
                    envelope,
                    &round.session,
                    &["sessionId", "route", "routeGeneration"]
                ),
            "WorkerLink peer signal authority is stale."
        );
        let (done, receive) = oneshot::channel();
        round
            .signals
            .try_send(Command {
                envelope: envelope.clone(),
                done,
            })
            .map_err(|_| anyhow::anyhow!("WorkerLink peer signaling is unavailable."))?;
        Ok(receive)
    }

    pub fn renew(
        &mut self,
        sessions: &HashMap<JsString, Session>,
        command: &Value,
        now: i64,
    ) -> Result<()> {
        let round = self
            .active
            .get_mut(id(command, "peerSessionId"))
            .filter(|round| round.session["sessionId"] == command["sessionId"])
            .context("WorkerLink peer session is not installed.")?;
        let next = &command["lease"];
        validate_renewal(&round.session["lease"], next, now)?;
        let mut session = round.session.clone();
        session["lease"] = next.clone();
        authorized(sessions, &session, now)?;
        round.session = session;
        Ok(())
    }

    pub fn revoke(&mut self, command: &Value) {
        let key = id(command, "peerSessionId");
        if self
            .active
            .get(key)
            .is_some_and(|round| round.session["sessionId"] == command["sessionId"])
            && let Some(round) = self.active.remove(key)
        {
            round.stop(command["revocation"]["reason"].as_str().unwrap());
        }
    }

    pub fn revoke_session(&mut self, session: &JsString, reason: &str) {
        self.active.retain(|_, round| {
            if round.session["sessionId"].as_js_string() == Some(session) {
                round.stop(reason);
                false
            } else {
                true
            }
        });
    }

    pub fn reconcile(&mut self, sessions: &HashMap<JsString, Session>, now: i64) {
        while self.tasks.try_join_next().is_some() {}
        self.active.retain(|_, round| {
            if round.task.is_finished() {
                return false;
            }
            if authorized(sessions, &round.session, now).is_err() {
                round.stop("lease-expired");
                false
            } else {
                true
            }
        });
    }

    pub fn take_tasks(&mut self) -> JoinSet<()> {
        std::mem::take(&mut self.tasks)
    }
}

impl Round {
    fn stop(&self, reason: &str) {
        self.carrier.close();
        self.stop.send_replace(Some(reason.to_owned()));
    }
}

struct Actor {
    session: Value,
    config: Value,
    carrier: Arc<PeerCarrier>,
    queues: [Option<Queue>; LANES.len()],
    gateway: Weak<Coordinator>,
    connection: Option<Arc<dyn PeerConnection>>,
    application_media: Option<(usize, Option<String>)>,
    channels: JoinSet<Result<()>>,
    control: bool,
    invalid: VecDeque<Instant>,
    signals_sent: u64,
    advertised: u64,
    signals_received: u64,
    connected: bool,
    deadline: Option<Instant>,
}

enum Event {
    Channel(Arc<dyn DataChannel>),
    Candidate(RTCIceCandidateInit),
    Complete,
    Closed,
}

struct EventHandler(mpsc::Sender<Event>, watch::Sender<bool>);

impl EventHandler {
    fn send(&self, event: Event) {
        if matches!(
            self.0.try_send(event),
            Err(mpsc::error::TrySendError::Full(_))
        ) {
            self.1.send_replace(true);
        }
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for EventHandler {
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        self.send(Event::Channel(channel));
    }
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(candidate) = event.candidate.to_json() {
            self.send(Event::Candidate(candidate));
        }
    }
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.send(Event::Complete);
        }
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if matches!(
            state,
            RTCPeerConnectionState::Disconnected
                | RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Closed
        ) {
            self.send(Event::Closed);
        }
    }
}

impl Actor {
    fn new(
        session: Value,
        config: Value,
        carrier: Arc<PeerCarrier>,
        queues: [Option<Queue>; LANES.len()],
        gateway: Weak<Coordinator>,
    ) -> Self {
        Self {
            session,
            config,
            carrier,
            queues,
            gateway,
            connection: None,
            application_media: None,
            channels: JoinSet::new(),
            control: false,
            invalid: VecDeque::new(),
            signals_sent: 0,
            advertised: 0,
            signals_received: 0,
            connected: false,
            deadline: None,
        }
    }

    async fn run(
        mut self,
        mut stop: watch::Receiver<Option<String>>,
        input: mpsc::Receiver<Command>,
    ) {
        let reason = tokio::select! {
            biased;
            _ = stop.changed() => stop.borrow().clone().unwrap_or_else(|| "peer-session-replaced".into()),
            reason = self.serve(input) => reason.unwrap_or_else(|_| "peer-transport-failed".into()),
        };
        self.carrier.close();
        if let Some(gateway) = self.gateway.upgrade() {
            gateway.disconnect_peer(&self.carrier);
        }
        self.channels.abort_all();
        while self.channels.join_next().await.is_some() {}
        if let Some(connection) = self.connection.take() {
            let _ = timeout(Duration::from_secs(2), connection.close()).await;
        }
        let _ = self.signal(json!({"type":"transport-state","state":"closed","message":reason}));
    }

    async fn serve(&mut self, mut input: mpsc::Receiver<Command>) -> Result<String> {
        let (events, mut incoming) = mpsc::channel(EVENT_QUEUE);
        let (overflow, mut overflowed) = watch::channel(false);
        let handler = Arc::new(EventHandler(events, overflow));
        loop {
            let deadline = self.deadline;
            let carrier = self.carrier.clone();
            tokio::select! {
                _ = overflowed.changed() => return Ok("peer-event-overflow".into()),
                _ = async {
                    if let Some(deadline) = deadline {
                        tokio::time::sleep_until(deadline).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                }, if !self.connected => return Ok("peer-negotiation-timeout".into()),
                next = input.recv() => {
                    let Some(command) = next else { return Ok("peer-session-replaced".into()) };
                    let sequence = command.envelope["signalSequence"].as_u64().unwrap();
                    if sequence != self.signals_received || sequence >= MAX_SIGNALS {
                        let _ = command.done.send(Err(anyhow::anyhow!("WorkerLink peer signal sequence is invalid.")));
                        if sequence >= MAX_SIGNALS { return Ok("peer-signal-limit".into()); }
                        continue;
                    }
                    match self.apply(&command.envelope["signal"], handler.clone()).await {
                        Ok(reason) => {
                            self.signals_received += 1;
                            let _ = command.done.send(Ok(()));
                            if let Some(reason) = reason { return Ok(reason); }
                        }
                        Err(error) => {
                            let _ = command.done.send(Err(error));
                            return Ok("invalid-peer-signal".into());
                        }
                    }
                }
                event = incoming.recv() => match event {
                    Some(Event::Channel(channel)) => self.attach(channel).await?,
                    Some(Event::Candidate(candidate)) => {
                        if network::candidate_allowed(&candidate.candidate, true) {
                            // The library's generic candidate constructor uses
                            // MID "0". Answer using the offer's negotiated MID.
                            let (index, mid) = self.application_media.as_ref().context("Missing WorkerLink peer media section.")?;
                            let candidate = json!({
                                "candidate":candidate.candidate,
                                "sdpMid":mid,
                                "sdpMLineIndex":index,
                                "usernameFragment":candidate.username_fragment,
                            });
                            self.advertise(Value::Array(vec![candidate]), false)?;
                        }
                    }
                    Some(Event::Complete) => self.advertise(Value::Array(Vec::new()), true)?,
                    Some(Event::Closed) | None => return Ok("peer-disconnected".into()),
                },
                _ = self.channels.join_next(), if !self.channels.is_empty() => {
                    return Ok("peer-channel-closed".into());
                }
                _ = carrier.changed.notified() => {}
            }
            if !self.connected && self.carrier.ready() {
                self.signal(
                    json!({"type":"transport-state","state":"connected","message":Value::Null}),
                )?;
                self.connected = true;
            }
        }
    }

    async fn apply(
        &mut self,
        signal: &Value,
        handler: Arc<EventHandler>,
    ) -> Result<Option<String>> {
        match signal["type"].as_str().unwrap() {
            "offer" => {
                ensure!(self.connection.is_none(), "Peer offer was replayed.");
                let sdp = signal["sdp"]
                    .as_str()
                    .context("Peer offer has invalid text.")?;
                ensure!(
                    !network::has_forbidden_candidate(sdp),
                    "Peer offer contained a disallowed ICE candidate."
                );
                let duration =
                    Duration::from_millis(self.config["negotiationTimeoutMs"].as_u64().unwrap());
                self.deadline = Some(Instant::now() + duration);
                let settings = SettingEngineBuilder::new()
                    .with_answering_dtls_role(RTCDtlsRole::Server)
                    .with_ice_connection_attempts(
                        Some(Duration::from_millis(200)),
                        Some((duration.as_millis() / 200) as u16),
                    )
                    .with_sctp_max_message_size(SctpMaxMessageSize::Bounded(MAX_MESSAGE as u32))
                    .build();
                let connection = timeout(
                    duration,
                    PeerConnectionBuilder::new()
                        .with_runtime(Arc::new(network::LanRuntime))
                        .with_udp_addrs(network::interfaces(&self.config)?)
                        .with_setting_engine(settings)
                        .with_handler(handler)
                        .build(),
                )
                .await??;
                let connection: Arc<dyn PeerConnection> = Arc::new(connection);
                self.connection = Some(connection.clone());
                let answer = timeout(duration, async {
                    connection
                        .set_remote_description(RTCSessionDescription::offer(sdp.to_owned())?)
                        .await?;
                    let answer = connection.create_answer(None).await?;
                    connection.set_local_description(answer.clone()).await?;
                    Ok::<_, anyhow::Error>(answer)
                })
                .await??;
                let local = answer.unmarshal()?;
                self.application_media = local
                    .media_descriptions
                    .iter()
                    .enumerate()
                    .find(|(_, media)| media.media_name.media == "application")
                    .map(|(index, media)| {
                        (index, media.attribute("mid").flatten().map(str::to_owned))
                    });
                ensure!(
                    self.application_media.is_some(),
                    "WorkerLink peer offer has no data-channel media section."
                );
                self.signal(json!({"type":"answer","sdp":answer.sdp}))?;
            }
            "candidate" => {
                let connection = self
                    .connection
                    .as_ref()
                    .context("Peer candidate preceded its offer.")?;
                let value = &signal["candidate"];
                let candidate = value["candidate"]
                    .as_str()
                    .context("Peer candidate has invalid text.")?;
                ensure!(
                    network::candidate_allowed(candidate, false),
                    "Peer signal contained a disallowed ICE candidate."
                );
                connection
                    .add_ice_candidate(RTCIceCandidateInit {
                        candidate: candidate.to_owned(),
                        sdp_mid: value["sdpMid"].as_str().map(str::to_owned),
                        sdp_mline_index: value["sdpMLineIndex"]
                            .as_u64()
                            .and_then(|n| u16::try_from(n).ok()),
                        username_fragment: value["usernameFragment"].as_str().map(str::to_owned),
                        ..Default::default()
                    })
                    .await?;
            }
            "end-of-candidates" => {
                self.connection
                    .as_ref()
                    .context("Peer candidate completion preceded its offer.")?
                    .add_ice_candidate(RTCIceCandidateInit::default())
                    .await?
            }
            "transport-state" => {
                ensure!(
                    signal["state"] != "connected",
                    "A WorkerLink client cannot assert transport readiness."
                );
                return Ok(Some(format!(
                    "client-{}",
                    signal["state"].as_str().unwrap()
                )));
            }
            _ => bail!("A WorkerLink client cannot send an answer."),
        }
        Ok(None)
    }

    async fn attach(&mut self, channel: Arc<dyn DataChannel>) -> Result<()> {
        let label = channel.label().await?;
        let carrier = self.carrier.clone();
        if label == CONTROL && !self.control {
            self.control = true;
            self.channels
                .spawn(control(channel, carrier, self.session.clone()));
        } else if let Some(index) = lane::from_label(&label)
            && let Some(queue) = self.queues[index].take()
        {
            self.channels
                .spawn(carrier.run_lane(index, channel, queue, self.gateway.clone()));
        } else {
            let _ = channel.close().await;
            self.invalid
                .retain(|at| at.elapsed() < Duration::from_secs(60));
            self.invalid.push_back(Instant::now());
            ensure!(
                self.invalid.len()
                    <= self.config["invalidHandshakeRatePerMinute"]
                        .as_u64()
                        .unwrap() as usize,
                "WorkerLink peer handshake limit exceeded."
            );
        }
        Ok(())
    }

    fn advertise(&mut self, candidates: Value, complete: bool) -> Result<()> {
        let mut advertisement = self.identity();
        advertisement["advertisementSequence"] = json!(self.advertised);
        advertisement["candidates"] = candidates;
        advertisement["complete"] = json!(complete);
        self.notify(json!({"type":"worker-link.peer.candidates","advertisement":advertisement}))?;
        self.advertised += 1;
        Ok(())
    }

    fn signal(&mut self, signal: Value) -> Result<()> {
        let mut envelope = self.identity();
        envelope["sender"] = json!("worker");
        envelope["signalSequence"] = json!(self.signals_sent);
        envelope["signal"] = signal;
        self.notify(json!({"type":"worker-link.peer.signal","envelope":envelope}))?;
        self.signals_sent += 1;
        Ok(())
    }

    fn identity(&self) -> Value {
        Value::object(
            ["peerSessionId", "sessionId", "route", "routeGeneration"]
                .map(|key| (key, self.session[key].clone())),
        )
    }

    fn notify(&self, notification: Value) -> Result<()> {
        let gateway = self
            .gateway
            .upgrade()
            .context("WorkerLink gateway stopped.")?;
        ensure!(
            gateway.outgoing.notification(notification)?,
            "WorkerLink signaling is disconnected."
        );
        Ok(())
    }
}

async fn control(
    channel: Arc<dyn DataChannel>,
    carrier: Arc<PeerCarrier>,
    session: Value,
) -> Result<()> {
    while let Some(event) = channel.poll().await {
        match event {
            DataChannelEvent::OnMessage(message) => {
                ensure!(
                    message.is_string
                        && message.data.len() <= MAX_MESSAGE
                        && !carrier.authenticated(),
                    "Invalid WorkerLink peer handshake."
                );
                let mut handshake = checked(
                    "workerLinkPeerHandshakeSchema",
                    &parse_json_text(std::str::from_utf8(&message.data)?)
                        .map_err(|_| anyhow::anyhow!("Invalid WorkerLink peer handshake JSON."))?,
                )?;
                ensure!(
                    handshake["role"] == "client"
                        && same(
                            &handshake,
                            &session,
                            &[
                                "sessionId",
                                "peerSessionId",
                                "identity",
                                "route",
                                "routeGeneration"
                            ]
                        ),
                    "WorkerLink peer handshake authority is stale."
                );
                carrier.authenticate();
                handshake["role"] = json!("worker");
                channel.send_text(&handshake.stringify()).await?;
                carrier.changed.notify_one();
            }
            DataChannelEvent::OnClose | DataChannelEvent::OnClosing => break,
            _ => {}
        }
    }
    Ok(())
}

fn same(left: &Value, right: &Value, fields: &[&str]) -> bool {
    fields.iter().all(|&field| left[field] == right[field])
}
