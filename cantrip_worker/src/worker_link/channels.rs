//! Ordered WorkerLink channels and shared carrier credit.
use super::{
    Coordinator, Session,
    carrier::{Carrier, Output, OutputKey},
    id,
    observation::Observation,
    terminal::Terminal,
    tunnel::{Inbound, Tunnel},
};
use crate::{browser_surface, connection::Outbound};
use cantrip_framing::worker_link::{self as wire, Frame};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::time::Instant;
use uuid::Uuid;

const MAX_CHANNELS: usize = 1024;
const MAX_NONCES: usize = 8192;
const MAX_INVALID: u32 = 32;
const MAX_CREDIT: usize = 8 * 1024 * 1024;
const MAX_OBSERVATIONS: usize = 256;
const MAX_OBSERVATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_TUNNEL_QUEUE_BYTES: usize = 512 * 1024;
const MAX_TUNNEL_QUEUE_FRAMES: usize = 32;
const MAX_OPERATIONS: usize = 4096;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const IDLE: Duration = Duration::from_secs(5 * 60);
const LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);
const CLOSED_CREDIT_GRACE: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct Channels {
    active: HashMap<JsString, Channel>,
    retired: IndexMap<JsString, RetiredChannel>,
    nonces: HashMap<JsString, i64>,
    invalid: HashMap<Option<JsString>, u32>,
    operation_sequences: IndexMap<JsString, u64>,
    controls: VecDeque<(Carrier, Frame)>,
}

struct Channel {
    carrier: Carrier,
    routing: Value,
    grant: JsString,
    resource: Resource,
    ready: bool,
    close_after_drain: bool,
    credit: usize,
    inbound_credit: usize,
    credit_pending: usize,
    initial_credit: usize,
    receive: u64,
    send: u64,
    opened: Instant,
    activity: Instant,
    pending: VecDeque<Vec<u8>>,
    pending_bytes: usize,
}

struct RetiredChannel {
    carrier: Carrier,
    routing: Value,
    receive: u64,
    deadline: Instant,
}

impl RetiredChannel {
    fn consume_credit(&mut self, carrier: &Carrier, header: &Value) -> bool {
        if header["kind"] != "credit"
            || header["direction"] != "worker-to-client"
            || self.deadline <= Instant::now()
            || self.carrier.key() != carrier.key()
            || [
                "sessionId",
                "routeGeneration",
                "effectiveRoute",
                "channel",
                "lane",
            ]
            .iter()
            .any(|key| header[*key] != self.routing[*key])
            || header["sequence"].as_u64() != self.receive.checked_add(1)
        {
            return false;
        }
        // A viewer may return credit for data already on the socket while
        // the grant is being revoked. The channel remains retired.
        self.receive += 1;
        true
    }
}

enum Resource {
    Observation {
        installation: Value,
        continuity: u64,
    },
    Terminal(Terminal),
    Tunnel(Box<Tunnel>),
    Surface {
        lane: Box<browser_surface::Lane>,
        payload_limit: usize,
    },
}

impl Resource {
    fn payload_format(&self) -> &'static str {
        match self {
            Self::Tunnel(tunnel) if !tunnel.listening() => "tunnel-data-plane-v1",
            Self::Tunnel(_) => "raw",
            Self::Observation { .. } | Self::Terminal(_) | Self::Surface { .. } => "raw",
        }
    }
}

impl Channel {
    fn frame(&self, kind: &str, sequence: u64, fields: &[(&str, Value)], payload: &[u8]) -> Frame {
        frame(&self.routing, kind, sequence, fields, payload)
    }

    fn flush(&mut self, output: &Outbound) -> Output {
        if !self.ready {
            return Output::Queued;
        }
        if self.send == 0 {
            let accept = self.frame(
                "accept",
                0,
                &[("initialCreditBytes", json!(self.initial_credit))],
                &[],
            );
            let offered = self.carrier.offer(output, &accept);
            if !matches!(offered, Output::Queued) {
                return offered;
            }
            self.send = 1;
            self.activity = Instant::now();
        }
        if self.credit_pending > 0 {
            let credit = self.frame(
                "credit",
                self.send,
                &[
                    ("direction", json!("client-to-worker")),
                    ("bytes", json!(self.credit_pending)),
                ],
                &[],
            );
            let offered = self.carrier.offer(output, &credit);
            if !matches!(offered, Output::Queued) {
                return offered;
            }
            self.send += 1;
            self.inbound_credit += self.credit_pending;
            self.credit_pending = 0;
            self.activity = Instant::now();
        }
        if let Resource::Surface {
            lane,
            payload_limit,
        } = &self.resource
        {
            loop {
                let mut offered = Output::Queued;
                let mut sent = 0;
                let advanced = lane.offer_chunk(self.credit.min(*payload_limit), |bytes| {
                    let frame = self.frame("data", self.send, &data_fields("raw"), &bytes);
                    offered = self.carrier.offer(output, &frame);
                    sent = bytes.len();
                    matches!(offered, Output::Queued)
                });
                if !advanced {
                    return offered;
                }
                self.credit -= sent;
                self.send += 1;
                self.activity = Instant::now();
            }
        }
        while let Some(bytes) = self.pending.front() {
            if bytes.len() > self.credit {
                break;
            }
            let frame = self.frame(
                "data",
                self.send,
                &data_fields(self.resource.payload_format()),
                bytes,
            );
            let offered = self.carrier.offer(output, &frame);
            if !matches!(offered, Output::Queued) {
                return offered;
            }
            self.credit -= bytes.len();
            self.pending_bytes -= bytes.len();
            self.pending.pop_front();
            match &self.resource {
                Resource::Terminal(terminal) => terminal.writable.notify_one(),
                Resource::Tunnel(tunnel) => tunnel.writable(),
                _ => {}
            }
            self.send += 1;
            self.activity = Instant::now();
        }
        Output::Queued
    }

    fn can_enqueue(&self, bytes: usize, max_frames: usize) -> bool {
        bytes <= wire::MAX_PAYLOAD_BYTES
            && self.pending.len() < max_frames
            && self.pending_bytes + bytes <= MAX_OBSERVATION_BYTES
    }

    fn enqueue(&mut self, bytes: Vec<u8>, max_frames: usize) -> bool {
        if !self.can_enqueue(bytes.len(), max_frames) {
            return false;
        }
        self.push(bytes);
        true
    }

    fn push(&mut self, bytes: Vec<u8>) {
        self.pending_bytes += bytes.len();
        self.pending.push_back(bytes);
    }

    fn queue_tunnel(&mut self, bytes: &[u8]) -> bool {
        if self.pending.len() >= MAX_TUNNEL_QUEUE_FRAMES
            || self.pending_bytes + bytes.len() > MAX_TUNNEL_QUEUE_BYTES
        {
            return false;
        }
        self.pending_bytes += bytes.len();
        self.pending.push_back(bytes.to_vec());
        true
    }
}

impl Channels {
    pub fn open(
        &mut self,
        carrier: &Carrier,
        header: &Value,
        session: Option<&Session>,
        retired: &IndexMap<JsString, u64>,
        now: i64,
        gateway: &Arc<Coordinator>,
    ) -> bool {
        let result = self.try_open(carrier, header, session, retired, now, gateway);
        let session_id = id(header, "sessionId");
        match result {
            Ok(()) => {
                self.invalid.remove(&Some(session_id.clone()));
                false
            }
            Err(code) => {
                let count = self
                    .invalid
                    .entry(session.map(|_| session_id.clone()))
                    .or_default();
                *count = count.saturating_add(1);
                let retire = *count > MAX_INVALID;
                self.push_control(
                    carrier.clone(),
                    frame(
                        header,
                        "reject",
                        0,
                        &[("code", json!(if retire { "limit-exceeded" } else { code }))],
                        &[],
                    ),
                );
                retire
            }
        }
    }

    fn try_open(
        &mut self,
        carrier: &Carrier,
        header: &Value,
        session: Option<&Session>,
        retired: &IndexMap<JsString, u64>,
        now: i64,
        gateway: &Arc<Coordinator>,
    ) -> Result<(), &'static str> {
        let session = session.ok_or("unauthorized")?;
        if header["effectiveRoute"] != carrier.route()
            || header["routeGeneration"] != session.value["routeGeneration"]
            || !super::route_enabled(&session.value, &header["effectiveRoute"])
        {
            return Err("route-generation-stale");
        }
        if header["sequence"] != 0
            || !matches!(
                header["channelKind"].as_str(),
                Some("event-subscription" | "reliable-stream")
            )
        {
            return Err("unsupported-channel");
        }
        let channel = id(&header["channel"], "channelId");
        if self.active.contains_key(channel) || self.active.len() >= MAX_CHANNELS {
            return Err("limit-exceeded");
        }
        let binding = &header["grant"]["binding"];
        let grant_id = id(binding, "grantId");
        let grant = session.grants.get(grant_id).ok_or_else(|| {
            if retired
                .get(grant_id)
                .is_some_and(|seen| binding["grantGeneration"].as_u64().unwrap() <= *seen)
            {
                "grant-revoked"
            } else {
                "unauthorized"
            }
        })?;
        let installed = &grant.value["binding"];
        if installed != binding {
            let got = &binding["identity"];
            let wanted = &installed["identity"];
            return Err(if got["accountSessionId"] != wanted["accountSessionId"] {
                "wrong-account-session"
            } else if got["workerProcessGeneration"] != wanted["workerProcessGeneration"] {
                "wrong-worker-generation"
            } else if got["serverGeneration"] != wanted["serverGeneration"] {
                "wrong-server-generation"
            } else {
                "unauthorized"
            });
        }
        let token = header["grant"]["token"]
            .as_str()
            .expect("validated WorkerLink token");
        let expected = grant.value["tokenHash"]
            .as_str()
            .expect("validated WorkerLink token hash");
        if !bool::from(
            super::hex_digest(&Sha256::digest(token))
                .as_bytes()
                .ct_eq(expected.as_bytes()),
        ) {
            return Err("unauthorized");
        }
        let operation = if header["channelKind"] == "event-subscription" {
            "events:subscribe"
        } else {
            "stream:open"
        };
        if !installed["lanes"]
            .as_array()
            .unwrap()
            .contains(&header["lane"])
            || !installed["operations"]
                .as_array()
                .unwrap()
                .contains(&json!(operation))
        {
            return Err("unauthorized");
        }
        let concurrent = self
            .active
            .values()
            .filter(|channel| &channel.grant == grant_id)
            .count();
        if concurrent >= installed["maxChannels"].as_u64().unwrap() as usize {
            return Err("limit-exceeded");
        }
        let nonce = id(header, "openNonce");
        self.nonces.retain(|_, expiry| *expiry > now);
        if self.nonces.contains_key(nonce) {
            return Err("grant-replayed");
        }
        if self.nonces.len() >= MAX_NONCES {
            return Err("limit-exceeded");
        }

        let installation = &grant.value["observation"];
        let (resource, ready) = match installed["resource"]["kind"].as_str() {
            Some("observations")
                if !installation.is_null()
                    && installation["subscriptionId"] == installed["resource"]["attachmentId"]
                    && header["lane"] == "events"
                    && header["channelKind"] == "event-subscription" =>
            {
                (
                    Resource::Observation {
                        installation: installation.clone(),
                        continuity: 0,
                    },
                    true,
                )
            }
            Some("terminal")
                if header["lane"] == "interactive"
                    && header["channelKind"] == "reliable-stream"
                    && installed["operations"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("stream:read")) =>
            {
                let adapter = gateway.terminals.get().ok_or("resource-unavailable")?;
                let terminal = adapter
                    .open(gateway, header, installed)
                    .map_err(|_| "resource-unavailable")?;
                (Resource::Terminal(terminal), false)
            }
            Some("tunnel")
                if header["lane"] == "stream" && header["channelKind"] == "reliable-stream" =>
            {
                if self.active.values().any(|channel| {
                    matches!(&channel.resource, Resource::Tunnel(active)
                        if installed["resource"]["attachmentId"].as_js_string() == Some(&active.attachment))
                }) {
                    return Err("resource-unavailable");
                }
                let frame_limit = payload_limit(carrier, header, "tunnel-data-plane-v1");
                let tunnel = Tunnel::open(gateway, header, installed, frame_limit, &grant.guest)?;
                let ready = !tunnel.listening();
                (Resource::Tunnel(tunnel), ready)
            }
            Some("browser" | "remote-desktop") if header["channelKind"] == "reliable-stream" => {
                let operations = installed["operations"].as_array().unwrap();
                if !operations.contains(&json!("stream:read")) {
                    return Err("resource-unavailable");
                }
                let kind = match header["lane"].as_str() {
                    Some("interactive") if operations.contains(&json!("stream:write")) => {
                        browser_surface::LinkLane::Interactive
                    }
                    Some("interactive") => return Err("unauthorized"),
                    Some("realtime") => browser_surface::LinkLane::Realtime,
                    _ => return Err("resource-unavailable"),
                };
                let surface = grant.surface.as_ref().ok_or("resource-unavailable")?;
                let payload_limit =
                    payload_limit(carrier, header, "raw").unwrap_or(wire::MAX_PAYLOAD_BYTES);
                if payload_limit <= wire::REMOTE_CHUNK_HEADER_BYTES {
                    return Err("resource-unavailable");
                }
                let lane = Box::new(surface.open(kind)?);
                (
                    Resource::Surface {
                        lane,
                        payload_limit,
                    },
                    true,
                )
            }
            _ => return Err("resource-unavailable"),
        };
        let expiry = super::timestamp(&installed["lease"], "absoluteExpiresAt")
            .map_err(|_| "grant-expired")?;
        self.nonces.insert(nonce.clone(), expiry);
        let opened = Instant::now();
        let initial = header["initialCreditBytes"].as_u64().unwrap() as usize;
        self.active.insert(
            channel.clone(),
            Channel {
                carrier: carrier.clone(),
                routing: routing(header),
                grant: grant_id.clone(),
                resource,
                ready,
                close_after_drain: false,
                credit: initial,
                inbound_credit: initial,
                credit_pending: 0,
                initial_credit: initial,
                receive: 0,
                send: 0,
                opened,
                activity: opened,
                pending: VecDeque::new(),
                pending_bytes: 0,
            },
        );
        Ok(())
    }

    pub fn receive(&mut self, carrier: &Carrier, frame: &Frame, allow_write: bool) -> bool {
        let header = frame.header();
        let key = id(&header["channel"], "channelId");
        let Some(channel) = self.active.get_mut(key) else {
            return self
                .retired
                .get_mut(key)
                .is_some_and(|retired| retired.consume_credit(carrier, header));
        };
        if channel.carrier.key() != carrier.key()
            || ["sessionId", "effectiveRoute", "channel", "lane"]
                .iter()
                .any(|field| header[*field] != channel.routing[*field])
        {
            return false;
        }
        let sequence = header["sequence"].as_u64().unwrap();
        if channel.send == 0
            || sequence != channel.receive + 1
            || header["routeGeneration"] != channel.routing["routeGeneration"]
        {
            self.close(key, "protocol-error");
            return false;
        }
        channel.receive = sequence;
        channel.activity = Instant::now();
        match header["kind"].as_str() {
            Some("credit") if header["direction"] == "worker-to-client" => {
                channel.credit =
                    (channel.credit + header["bytes"].as_u64().unwrap() as usize).min(MAX_CREDIT);
            }
            Some("data")
                if allow_write
                    && header["direction"] == "client-to-worker"
                    && header["payloadFormat"] == channel.resource.payload_format()
                    && !channel.close_after_drain
                    && frame.payload().len() <= channel.inbound_credit =>
            {
                let bytes = frame.payload();
                let result = match &mut channel.resource {
                    Resource::Terminal(terminal) => terminal
                        .input
                        .try_send(bytes.to_vec())
                        .map(|()| Inbound::Retained)
                        .map_err(|_| "congested"),
                    Resource::Tunnel(tunnel) => tunnel.receive(bytes),
                    Resource::Surface { lane, .. } => {
                        lane.receive(bytes).map(|()| Inbound::Consumed)
                    }
                    Resource::Observation { .. } => Err("protocol-error"),
                };
                channel.inbound_credit -= bytes.len();
                match result {
                    Ok(Inbound::Retained) => {}
                    Ok(Inbound::Consumed) => channel.credit_pending += bytes.len(),
                    Ok(Inbound::Reply(reply)) if channel.queue_tunnel(reply.bytes()) => {
                        channel.credit_pending += bytes.len();
                    }
                    Ok(Inbound::Reply(_)) => self.close(key, "congested"),
                    Err(code) => {
                        self.close(key, code);
                        return code != "protocol-error";
                    }
                }
            }
            Some("close") => self.close(key, header["code"].as_str().unwrap()),
            _ => {
                self.close(key, "protocol-error");
                return false;
            }
        }
        true
    }

    pub fn publish(&mut self, candidate: Observation) {
        let sequence = candidate.sequence.unwrap_or_else(|| {
            let next = self
                .operation_sequences
                .shift_remove(&candidate.operation)
                .unwrap_or(0);
            self.operation_sequences
                .insert(candidate.operation.clone(), next + 1);
            if self.operation_sequences.len() > MAX_OPERATIONS {
                self.operation_sequences.shift_remove_index(0);
            }
            next
        });
        let mut congested = Vec::new();
        for (id, channel) in &mut self.active {
            let Resource::Observation {
                installation,
                continuity,
            } = &channel.resource
            else {
                continue;
            };
            if !installation["topics"]
                .as_array()
                .unwrap()
                .contains(&json!(candidate.topic))
            {
                continue;
            }
            let Some(bytes) =
                candidate.envelope(&installation["subscriptionId"], *continuity, sequence)
            else {
                continue;
            };
            if channel.enqueue(bytes, MAX_OBSERVATIONS) {
                let Resource::Observation { continuity, .. } = &mut channel.resource else {
                    unreachable!()
                };
                *continuity += 1;
            } else {
                congested.push(id.clone());
            }
        }
        for id in congested {
            self.close(&id, "congested");
        }
    }

    fn terminal_mut(&mut self, id: &JsString, token: Uuid) -> Option<&mut Channel> {
        self.active.get_mut(id).filter(|channel| {
            matches!(&channel.resource, Resource::Terminal(terminal) if terminal.token == token)
        })
    }

    pub fn terminal_ready(&mut self, id: &JsString, token: Uuid) {
        if let Some(channel) = self.terminal_mut(id, token) {
            channel.ready = true;
        }
    }

    pub fn terminal_output(
        &mut self,
        id: &JsString,
        token: Uuid,
        bytes: &[u8],
        last: bool,
    ) -> Output {
        let Some(channel) = self.terminal_mut(id, token) else {
            return Output::Closed;
        };
        if bytes.len() > wire::MAX_PAYLOAD_BYTES {
            self.terminal_error(id, token, "io-error", "protocol-error");
            return Output::Closed;
        }
        if !channel.can_enqueue(bytes.len(), 128) {
            return Output::Pending;
        }
        channel.push(bytes.to_vec());
        channel.close_after_drain = last;
        Output::Queued
    }

    pub fn terminal_credit(&mut self, id: &JsString, token: Uuid, bytes: usize) {
        if let Some(channel) = self.terminal_mut(id, token) {
            channel.credit_pending += bytes;
        }
    }

    pub fn terminal_error(&mut self, id: &JsString, token: Uuid, error: &str, close: &str) {
        let Some(channel) = self.terminal_mut(id, token) else {
            return;
        };
        if channel.send > 0 {
            let frame = channel.frame("error", channel.send, &[("code", json!(error))], &[]);
            channel.send += 1;
            let carrier = channel.carrier.clone();
            self.push_control(carrier, frame);
        }
        self.close(id, close);
    }

    fn tunnel_mut(&mut self, id: &JsString, token: Uuid) -> Option<&mut Channel> {
        self.active.get_mut(id).filter(|channel| {
            matches!(&channel.resource, Resource::Tunnel(tunnel) if tunnel.token() == token)
        })
    }

    pub fn tunnel_active(&mut self, id: &JsString, token: Uuid) -> bool {
        self.tunnel_mut(id, token).is_some()
    }

    pub fn listener_ready(&mut self, id: &JsString, token: Uuid) -> bool {
        if let Some(channel) = self.tunnel_mut(id, token) {
            channel.ready = true;
            true
        } else {
            false
        }
    }

    pub fn listener_closed(&mut self, id: &JsString, token: Uuid) {
        if self.tunnel_mut(id, token).is_some() {
            self.close(id, "endpoint-disconnected");
        }
    }

    pub fn tunnel_output(&mut self, id: &JsString, token: Uuid, bytes: &[u8]) -> Output {
        match self.tunnel_mut(id, token) {
            Some(channel) => {
                if channel.queue_tunnel(bytes) {
                    Output::Queued
                } else {
                    Output::Pending
                }
            }
            None => Output::Closed,
        }
    }

    pub fn tunnel_credit(&mut self, id: &JsString, token: Uuid, bytes: usize) {
        if let Some(channel) = self.tunnel_mut(id, token) {
            channel.credit_pending += bytes;
        }
    }

    pub fn grant_for(&self, header: &Value) -> Option<&JsString> {
        self.active
            .get(id(&header["channel"], "channelId"))
            .map(|channel| &channel.grant)
    }

    pub fn flush(&mut self, output: &Outbound) {
        let mut blocked = self.flush_controls(output);
        let mut finished = Vec::new();
        for (id, channel) in &mut self.active {
            if let Resource::Surface { lane, .. } = &channel.resource
                && let Some(code) = lane.failure()
            {
                finished.push((id.clone(), code));
                continue;
            }
            let carrier = channel
                .carrier
                .output_key(channel.routing["lane"].as_str().unwrap());
            if blocked.contains(&carrier) {
                continue;
            }
            match channel.flush(output) {
                Output::Pending => {
                    blocked.insert(carrier);
                    continue;
                }
                Output::Closed => {
                    finished.push((id.clone(), "endpoint-disconnected"));
                    continue;
                }
                Output::Queued => {}
            }
            if channel.close_after_drain && channel.pending.is_empty() && channel.send > 0 {
                finished.push((id.clone(), "normal"));
            }
        }
        if !finished.is_empty() {
            for (id, code) in finished {
                self.close(&id, code);
            }
            self.flush_controls(output);
        }
    }

    fn flush_controls(&mut self, output: &Outbound) -> HashSet<OutputKey> {
        let mut blocked = HashSet::new();
        for _ in 0..self.controls.len() {
            let (carrier, frame) = self
                .controls
                .pop_front()
                .expect("queued WorkerLink control");
            let key = carrier.output_key(frame.header()["lane"].as_str().unwrap());
            if blocked.contains(&key) || matches!(carrier.offer(output, &frame), Output::Pending) {
                blocked.insert(key);
                self.controls.push_back((carrier, frame));
            }
        }
        blocked
    }

    pub fn disconnect(&mut self, carrier: &Carrier) {
        let key = carrier.key();
        self.active
            .retain(|_, channel| channel.carrier.key() != key);
        self.controls.retain(|(carrier, _)| carrier.key() != key);
        self.retired
            .retain(|_, retired| retired.carrier.key() != key);
    }

    pub fn disconnect_surface_relay(&mut self) {
        let mut removed = HashSet::new();
        self.active.retain(|id, channel| {
            let drop = matches!(channel.carrier, Carrier::Relay)
                && matches!(channel.resource, Resource::Surface { .. });
            if drop {
                removed.insert(id.clone());
            }
            !drop
        });
        self.controls.retain(|(carrier, frame)| {
            !matches!(carrier, Carrier::Relay)
                || !removed.contains(id(&frame.header()["channel"], "channelId"))
        });
    }

    pub fn close_session(&mut self, session: &JsString, code: &str) {
        let channels: Vec<_> = self
            .active
            .iter()
            .filter_map(|(id, channel)| {
                (channel.routing["sessionId"].as_js_string() == Some(session)).then_some(id.clone())
            })
            .collect();
        for id in channels {
            self.close(&id, code);
        }
        self.invalid.remove(&Some(session.clone()));
    }

    pub fn close_grant(&mut self, session: &JsString, grant: &JsString, code: &str) {
        let channels: Vec<_> = self
            .active
            .iter()
            .filter_map(|(id, channel)| {
                (&channel.grant == grant
                    && channel.routing["sessionId"].as_js_string() == Some(session))
                .then_some(id.clone())
            })
            .collect();
        for id in channels {
            self.close(&id, code);
        }
    }

    pub fn sweep(&mut self, now: i64) {
        self.nonces.retain(|_, expiry| *expiry > now);
        let time = Instant::now();
        self.retired.retain(|_, retired| retired.deadline > time);
        let expired: Vec<_> = self
            .active
            .iter()
            .filter_map(|(id, channel)| {
                if time.duration_since(channel.opened) >= LIFETIME {
                    Some((id.clone(), "lifetime-expired"))
                } else if time.duration_since(channel.activity) >= IDLE {
                    Some((id.clone(), "idle-timeout"))
                } else {
                    None
                }
            })
            .collect();
        for (id, code) in expired {
            self.close(&id, code);
        }
    }

    pub fn clear(&mut self) {
        self.active.clear();
        self.retired.clear();
        self.controls.clear();
        self.nonces.clear();
        self.invalid.clear();
    }

    fn close(&mut self, id: &JsString, code: &str) {
        let Some(mut channel) = self.active.remove(id) else {
            return;
        };
        if channel.send > 0
            && code == "congested"
            && channel.routing["lane"] == "interactive"
            && matches!(&channel.resource, Resource::Surface { lane, .. } if lane.failure() == Some("congested"))
        {
            let error = channel.frame(
                "error",
                channel.send,
                &[("code", json!("credit-exceeded"))],
                &[],
            );
            self.push_control(channel.carrier.clone(), error);
            channel.send += 1;
        }
        let (kind, code) = if channel.send > 0 {
            ("close", code)
        } else {
            (
                "reject",
                match code {
                    "revoked" => "grant-revoked",
                    "route-replaced" => "route-generation-stale",
                    "lifetime-expired" => "grant-expired",
                    "congested" => "limit-exceeded",
                    "protocol-error" => "protocol-error",
                    _ => "resource-unavailable",
                },
            )
        };
        let frame = channel.frame(kind, channel.send, &[("code", json!(code))], &[]);
        if channel.send > 0 && matches!(channel.carrier, Carrier::Local(_)) {
            if self.retired.len() >= MAX_CHANNELS {
                self.retired.shift_remove_index(0);
            }
            self.retired.insert(
                id.clone(),
                RetiredChannel {
                    carrier: channel.carrier.clone(),
                    routing: channel.routing,
                    receive: channel.receive,
                    deadline: Instant::now() + CLOSED_CREDIT_GRACE,
                },
            );
        }
        self.push_control(channel.carrier, frame);
    }

    fn push_control(&mut self, carrier: Carrier, frame: Frame) {
        if self.controls.len() < MAX_CHANNELS * 2 {
            self.controls.push_back((carrier, frame));
        }
    }
}

fn payload_limit(carrier: &Carrier, header: &Value, format: &str) -> Option<usize> {
    carrier
        .message_limit(header["lane"].as_str().unwrap())
        .map(|limit| {
            // Reserve space for the widest possible sequence.
            let overhead = frame(header, "data", MAX_SEQUENCE, &data_fields(format), &[0])
                .bytes()
                .len()
                - 1;
            limit.saturating_sub(overhead)
        })
}

fn data_fields(format: &str) -> [(&'static str, Value); 2] {
    [
        ("direction", json!("worker-to-client")),
        ("payloadFormat", json!(format)),
    ]
}

fn routing(source: &Value) -> Value {
    Value::object(
        [
            "protocolVersion",
            "sessionId",
            "routeGeneration",
            "effectiveRoute",
            "channel",
            "lane",
        ]
        .into_iter()
        .map(|field| (field, source[field].clone())),
    )
}

fn frame(
    base: &Value,
    kind: &str,
    sequence: u64,
    fields: &[(&str, Value)],
    payload: &[u8],
) -> Frame {
    let mut value = routing(base);
    value["sequence"] = json!(sequence);
    value["kind"] = json!(kind);
    for (name, field) in fields {
        value[*name] = field.clone();
    }
    wire::create(value, payload).expect("validated WorkerLink frame")
}

#[cfg(test)]
mod tests {
    use super::super::carrier::{Local, SocketOutput};
    use super::*;

    #[test]
    fn retired_direct_channel_consumes_only_its_in_flight_credit() {
        let (output, _written) = SocketOutput::channel();
        let socket = Local::new("session".into(), output);
        let carrier = Carrier::Local(Arc::downgrade(&socket));
        let header = json!({
            "kind":"credit","direction":"worker-to-client","bytes":2048,
            "sessionId":"session","routeGeneration":1,"effectiveRoute":"local",
            "lane":"realtime","channel":json!({"channelId":"channel","connectionId":"connection"}),
            "sequence":3
        });
        let mut retired = RetiredChannel {
            carrier: carrier.clone(),
            routing: routing(&header),
            receive: 2,
            deadline: Instant::now() + CLOSED_CREDIT_GRACE,
        };
        assert!(!retired.consume_credit(&Carrier::Relay, &header));
        let mut wrong = header.clone();
        wrong["channel"]["connectionId"] = json!("other");
        assert!(!retired.consume_credit(&carrier, &wrong));
        let mut payload = header.clone();
        payload["kind"] = json!("data");
        assert!(!retired.consume_credit(&carrier, &payload));
        assert!(retired.consume_credit(&carrier, &header));
        assert!(!retired.consume_credit(&carrier, &header));
        let mut late = header;
        late["sequence"] = json!(4);
        retired.deadline = Instant::now();
        assert!(!retired.consume_credit(&carrier, &late));
    }
}
