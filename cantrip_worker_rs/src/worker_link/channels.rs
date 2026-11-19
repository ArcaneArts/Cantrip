//! Ordered WorkerLink channels and shared carrier credit.
use super::{
    Coordinator, Session,
    carrier::{Carrier, Local, Output},
    id,
    observation::Observation,
    terminal::Terminal,
    tunnel::{Inbound, Tunnel},
};
use crate::connection::Outbound;
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
const IDLE: Duration = Duration::from_secs(5 * 60);
const LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Default)]
pub(super) struct Channels {
    active: HashMap<JsString, Channel>,
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

enum Resource {
    Observation {
        installation: Value,
        continuity: u64,
    },
    Terminal(Terminal),
    Tunnel(Box<Tunnel>),
}

impl Resource {
    fn payload_format(&self) -> &'static str {
        match self {
            Self::Tunnel(_) => "tunnel-data-plane-v1",
            Self::Observation { .. } | Self::Terminal(_) => "raw",
        }
    }
}

impl Channel {
    fn frame(&self, kind: &str, sequence: u64, fields: &[(&str, Value)], payload: &[u8]) -> Frame {
        frame(&self.routing, kind, sequence, fields, payload)
    }

    fn flush(&mut self, output: &Outbound) -> bool {
        if !self.ready {
            return true;
        }
        if self.send == 0 {
            let accept = self.frame(
                "accept",
                0,
                &[("initialCreditBytes", json!(self.initial_credit))],
                &[],
            );
            if !matches!(self.carrier.offer(output, &accept), Output::Queued) {
                return false;
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
            if !matches!(self.carrier.offer(output, &credit), Output::Queued) {
                return false;
            }
            self.send += 1;
            self.inbound_credit += self.credit_pending;
            self.credit_pending = 0;
            self.activity = Instant::now();
        }
        while let Some(bytes) = self.pending.front() {
            if bytes.len() > self.credit {
                break;
            }
            let frame = self.frame(
                "data",
                self.send,
                &[
                    ("direction", json!("worker-to-client")),
                    ("payloadFormat", json!(self.resource.payload_format())),
                ],
                bytes,
            );
            if !matches!(self.carrier.offer(output, &frame), Output::Queued) {
                return false;
            }
            self.credit -= bytes.len();
            self.pending_bytes -= bytes.len();
            self.pending.pop_front();
            if let Resource::Tunnel(tunnel) = &self.resource {
                tunnel.writable();
            }
            self.send += 1;
            self.activity = Instant::now();
        }
        true
    }

    fn enqueue(&mut self, bytes: Vec<u8>, max_frames: usize) -> bool {
        if bytes.len() > wire::MAX_PAYLOAD_BYTES
            || self.pending.len() >= max_frames
            || self.pending_bytes + bytes.len() > MAX_OBSERVATION_BYTES
        {
            return false;
        }
        self.pending_bytes += bytes.len();
        self.pending.push_back(bytes);
        true
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
        let installed = &grant["binding"];
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
        let expected = grant["tokenHash"]
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

        let installation = &grant["observation"];
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
                let tunnel = Tunnel::open(gateway, header, installed)?;
                if self.active.values().any(|channel| {
                    matches!(&channel.resource, Resource::Tunnel(active) if active.attachment == tunnel.attachment)
                }) {
                    return Err("resource-unavailable");
                }
                (Resource::Tunnel(tunnel), true)
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
            return false;
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

    pub fn terminal_output(&mut self, id: &JsString, token: Uuid, bytes: Vec<u8>, last: bool) {
        if let Some(channel) = self.terminal_mut(id, token) {
            if channel.enqueue(bytes, 128) {
                channel.close_after_drain = last;
            } else {
                self.terminal_error(id, token, "credit-exceeded", "congested");
            }
        }
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
            let carrier = channel.carrier.key();
            if blocked.contains(&carrier) {
                continue;
            }
            if !channel.flush(output) {
                blocked.insert(carrier);
                continue;
            }
            if channel.close_after_drain && channel.pending.is_empty() && channel.send > 0 {
                finished.push(id.clone());
            }
        }
        if !finished.is_empty() {
            for id in finished {
                self.close(&id, "normal");
            }
            self.flush_controls(output);
        }
    }

    fn flush_controls(&mut self, output: &Outbound) -> HashSet<Option<*const Local>> {
        let mut blocked = HashSet::new();
        for _ in 0..self.controls.len() {
            let (carrier, frame) = self
                .controls
                .pop_front()
                .expect("queued WorkerLink control");
            let key = carrier.key();
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
        self.controls.clear();
        self.nonces.clear();
        self.invalid.clear();
    }

    fn close(&mut self, id: &JsString, code: &str) {
        let Some(channel) = self.active.remove(id) else {
            return;
        };
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
        self.push_control(channel.carrier, frame);
    }

    fn push_control(&mut self, carrier: Carrier, frame: Frame) {
        if self.controls.len() < MAX_CHANNELS * 2 {
            self.controls.push_back((carrier, frame));
        }
    }
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
