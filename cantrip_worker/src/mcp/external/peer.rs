//! Headless client for the existing WorkerLink ICE, DTLS, and SCTP routes.
use super::{Host, relay::Carrier};
use crate::worker_link::peer::{
    CONTROL, LANES, MAX_MESSAGE,
    network::{PeerRoute, PeerRuntime},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use bytes::BytesMut;
use cantrip_crypto::{checked, encode, random_bytes};
use cantrip_wire::{Value, parse_json_text, value::json};
use rtc::peer_connection::configuration::setting_engine::{
    SctpMaxMessageSize, SettingEngineBuilder,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent, RTCDataChannelInit},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceCandidateInit,
        RTCIceGatheringState, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
        RTCSessionDescription,
    },
};

const MAX_SIGNALS: u64 = 256;
const STREAM_LABEL: &str = "cantrip-worker-link-v1:lane:stream";

pub(super) struct Peer {
    connection: Arc<dyn PeerConnection>,
    control: Arc<dyn DataChannel>,
    stream: Arc<dyn DataChannel>,
    _lanes: Vec<Arc<dyn DataChannel>>,
    closed: watch::Receiver<bool>,
}

impl Drop for Peer {
    fn drop(&mut self) {
        let connection = self.connection.clone();
        tokio::spawn(async move {
            let _ = connection.close().await;
        });
    }
}

#[async_trait::async_trait]
impl Carrier for Peer {
    async fn send_packet(&mut self, bytes: Vec<u8>) -> Result<()> {
        ensure!(
            bytes.len() <= MAX_MESSAGE && !*self.closed.borrow(),
            "WorkerLink peer is unavailable."
        );
        self.stream.writable().await?;
        self.stream.send(BytesMut::from(bytes.as_slice())).await?;
        Ok(())
    }
    async fn receive_packet(&mut self) -> Result<Vec<u8>> {
        loop {
            tokio::select! {
                biased;
                _ = self.closed.changed() => bail!("WorkerLink peer disconnected."),
                event = self.control.poll() => match event {
                    Some(DataChannelEvent::OnClose | DataChannelEvent::OnClosing) | None =>
                        bail!("WorkerLink peer authorization disconnected."),
                    _ => {}
                },
                event = self.stream.poll() => match event {
                    Some(DataChannelEvent::OnMessage(message)) => {
                        ensure!(!message.is_string && message.data.len() <= MAX_MESSAGE, "Invalid WorkerLink peer frame.");
                        return Ok(message.data.to_vec());
                    }
                    Some(DataChannelEvent::OnClose | DataChannelEvent::OnClosing) | None =>
                        bail!("WorkerLink peer stream disconnected."),
                    _ => {}
                },
            }
        }
    }
}

enum Ice {
    Candidate(RTCIceCandidateInit),
    Complete,
}

struct Events {
    ice: mpsc::Sender<Ice>,
    closed: watch::Sender<bool>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Events {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(candidate) = event.candidate.to_json()
            && self.ice.try_send(Ice::Candidate(candidate)).is_err()
        {
            self.closed.send_replace(true);
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete && self.ice.try_send(Ice::Complete).is_err() {
            self.closed.send_replace(true);
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if matches!(
            state,
            RTCPeerConnectionState::Disconnected
                | RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Closed
        ) {
            self.closed.send_replace(true);
        }
    }
}

struct Round<'a> {
    host: &'a Host,
    path: &'a str,
    identity: Value,
    route: PeerRoute,
    sent: u64,
    signals: Option<u64>,
    advertisements: Option<u64>,
    ready: bool,
}

pub(super) async fn connect(
    host: &Host,
    path: &str,
    session: &Value,
    route: PeerRoute,
) -> Result<Peer> {
    let opened = host
        .carrier(
            path,
            "peer-open",
            json!({
                "route":route.name(),"routeGeneration":session["routeGeneration"],
            }),
        )
        .await?;
    let peer = checked("workerLinkPeerSessionSchema", &opened["peerSession"])?;
    let config = &opened["configuration"];
    ensure!(
        peer["identity"] == session["identity"]
            && peer["sessionId"] == session["sessionId"]
            && peer["routeGeneration"] == session["routeGeneration"]
            && peer["route"] == route.name(),
        "WorkerLink returned another peer authority."
    );
    let identity = Value::object(
        ["peerSessionId", "sessionId", "routeGeneration", "route"]
            .map(|name| (name, peer[name].clone())),
    );
    let mut round = Round {
        host,
        path,
        identity: identity.clone(),
        route,
        sent: 0,
        signals: None,
        advertisements: None,
        ready: false,
    };
    let (ice, mut candidates) = mpsc::channel(128);
    let (close, closed) = watch::channel(false);
    let handler = Arc::new(Events { ice, closed: close });
    let (network, addresses) = PeerRuntime::bind(route, config)?;
    let duration = Duration::from_millis(
        config["negotiationTimeoutMs"]
            .as_u64()
            .unwrap_or(4500)
            .min(7000),
    );
    let settings = SettingEngineBuilder::new()
        .with_ice_connection_attempts(
            Some(Duration::from_millis(200)),
            Some((duration.as_millis() / 200) as u16),
        )
        .with_sctp_max_message_size(SctpMaxMessageSize::Bounded(MAX_MESSAGE as u32))
        .build();
    let connection: Arc<dyn PeerConnection> = Arc::new(
        PeerConnectionBuilder::new()
            .with_runtime(Arc::new(network))
            .with_udp_addrs(addresses)
            .with_configuration(route.configuration(config))
            .with_setting_engine(settings)
            .with_handler(handler)
            .build()
            .await?,
    );
    let control = connection.create_data_channel(CONTROL, None).await?;
    let stream = connection.create_data_channel(STREAM_LABEL, None).await?;
    let mut lanes = Vec::new();
    for lane in LANES.into_iter().filter(|lane| *lane != "stream") {
        let options = (lane == "realtime").then_some(RTCDataChannelInit {
            ordered: false,
            max_retransmits: Some(0),
            ..Default::default()
        });
        lanes.push(
            connection
                .create_data_channel(&format!("cantrip-worker-link-v1:lane:{lane}"), options)
                .await?,
        );
    }
    let mut peer = Peer {
        connection,
        control,
        stream,
        _lanes: lanes,
        closed,
    };
    let offer = peer.connection.create_offer(None).await?;
    ensure!(
        route.offer_allowed(&offer.sdp),
        "WorkerLink offer contains a disallowed candidate."
    );
    let offer_media = offer.unmarshal()?;
    let (index, mid) = offer_media
        .media_descriptions
        .iter()
        .enumerate()
        .find(|(_, entry)| entry.media_name.media == "application")
        .map(|(index, entry)| (index, entry.attribute("mid").flatten().map(str::to_owned)))
        .context("WorkerLink peer offer has no data channel.")?;
    peer.connection.set_local_description(offer.clone()).await?;
    round.send(json!({"type":"offer","sdp":offer.sdp})).await?;
    let mut handshake = identity;
    handshake["type"] = json!("worker-link-peer-handshake");
    handshake["protocolVersion"] = json!(1);
    handshake["role"] = json!("client");
    handshake["identity"] = session["identity"].clone();
    handshake["challenge"] = json!(encode(&random_bytes(32)?));
    let mut acknowledged = false;
    let mut mailbox = tokio::time::interval(Duration::from_millis(120));
    mailbox.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = peer.closed.changed() => bail!("WorkerLink peer disconnected during negotiation."),
            event = candidates.recv() => match event {
                Some(Ice::Candidate(candidate)) if route.remote_candidate_allowed(&candidate.candidate, true) => {
                    round.send(json!({"type":"candidate","candidate":json!({
                        "candidate":candidate.candidate,"sdpMid":mid,"sdpMLineIndex":index,
                        "usernameFragment":candidate.username_fragment,
                    })})).await?;
                }
                Some(Ice::Complete) => round.send(json!({"type":"end-of-candidates"})).await?,
                Some(Ice::Candidate(_)) => {}
                None => bail!("WorkerLink ICE gathering disconnected."),
            },
            event = peer.control.poll(), if !acknowledged => match event {
                Some(DataChannelEvent::OnOpen) => peer.control.send_text(&handshake.stringify()).await.map(|_| ())?,
                Some(DataChannelEvent::OnMessage(message)) => {
                    ensure!(message.is_string && message.data.len() <= MAX_MESSAGE, "Invalid WorkerLink peer proof.");
                    let reply = parse_json_text(std::str::from_utf8(&message.data)?)
                        .map_err(|_| anyhow!("Invalid WorkerLink peer proof."))?;
                    handshake["role"] = json!("worker");
                    ensure!(reply == handshake, "WorkerLink peer did not prove the authorized identity.");
                    acknowledged = true;
                }
                Some(DataChannelEvent::OnClose | DataChannelEvent::OnClosing) | None =>
                    bail!("WorkerLink control channel disconnected."),
                _ => {}
            },
            _ = mailbox.tick() => round.read(&*peer.connection).await?,
        }
        if acknowledged && round.ready {
            return Ok(peer);
        }
    }
}

impl Round<'_> {
    async fn send(&mut self, signal: Value) -> Result<()> {
        ensure!(
            self.sent < MAX_SIGNALS,
            "WorkerLink peer signal limit exceeded."
        );
        let mut envelope = self.identity.clone();
        envelope["sender"] = json!("client");
        envelope["signalSequence"] = json!(self.sent);
        envelope["signal"] = signal;
        self.host
            .carrier(self.path, "peer-signal", json!({"signals":vec![envelope]}))
            .await?;
        self.sent += 1;
        Ok(())
    }

    async fn read(&mut self, peer: &dyn PeerConnection) -> Result<()> {
        let mailbox = self.host.carrier(self.path, "peer-mailbox", json!({
            "peerSessionId":self.identity["peerSessionId"],
            "afterSignalSequence":self.signals,"afterAdvertisementSequence":self.advertisements,
        })).await?;
        let mailbox = checked("workerLinkPeerMailboxSchema", &mailbox)?;
        for envelope in mailbox["signals"]
            .as_array()
            .context("WorkerLink peer signals")?
        {
            self.validate(envelope)?;
            ensure!(
                envelope["sender"] == "worker",
                "WorkerLink mailbox returned a client signal."
            );
            self.signals = envelope["signalSequence"].as_u64();
            let signal = &envelope["signal"];
            match signal["type"].as_str() {
                Some("answer") => {
                    let sdp = signal["sdp"].as_str().context("Peer answer SDP")?;
                    ensure!(
                        self.route.offer_allowed(sdp),
                        "WorkerLink answer contains a disallowed candidate."
                    );
                    peer.set_remote_description(RTCSessionDescription::answer(sdp.to_owned())?)
                        .await?;
                }
                Some("transport-state") if signal["state"] == "connected" => self.ready = true,
                Some("transport-state") => bail!("The worker's direct peer disconnected."),
                _ => {}
            }
        }
        for advert in mailbox["candidateAdvertisements"]
            .as_array()
            .context("WorkerLink peer candidates")?
        {
            self.validate(advert)?;
            self.advertisements = advert["advertisementSequence"].as_u64();
            for candidate in advert["candidates"]
                .as_array()
                .context("WorkerLink candidates")?
            {
                let text = candidate["candidate"]
                    .as_str()
                    .context("WorkerLink candidate address")?;
                ensure!(
                    self.route.remote_candidate_allowed(text, true),
                    "WorkerLink advertised a disallowed peer candidate."
                );
                peer.add_ice_candidate(RTCIceCandidateInit {
                    candidate: text.to_owned(),
                    sdp_mid: candidate["sdpMid"].as_str().map(str::to_owned),
                    sdp_mline_index: candidate["sdpMLineIndex"]
                        .as_u64()
                        .and_then(|value| u16::try_from(value).ok()),
                    username_fragment: candidate["usernameFragment"].as_str().map(str::to_owned),
                    ..Default::default()
                })
                .await?;
            }
            if advert["complete"] == true {
                peer.add_ice_candidate(RTCIceCandidateInit::default())
                    .await?;
            }
        }
        Ok(())
    }

    fn validate(&self, envelope: &Value) -> Result<()> {
        ensure!(
            ["peerSessionId", "sessionId", "routeGeneration", "route"]
                .iter()
                .all(|field| envelope[*field] == self.identity[*field]),
            "WorkerLink peer authority changed."
        );
        Ok(())
    }
}
