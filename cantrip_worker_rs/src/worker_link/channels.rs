//! Ordered relay channels for the native observation adapter.
use super::{Session, id, observation::Observation};
use crate::connection::Outbound;
use cantrip_framing::worker_link::{self as wire, Frame};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::time::Instant;

const MAX_CHANNELS: usize = 1024;
const MAX_NONCES: usize = 8192;
const MAX_INVALID: u32 = 32;
const MAX_CREDIT: usize = 8 * 1024 * 1024;
const MAX_OBSERVATIONS: usize = 256;
const MAX_OBSERVATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_OPERATIONS: usize = 4096;
const IDLE: Duration = Duration::from_secs(5 * 60);
const LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Default)]
pub(super) struct Channels {
    active: HashMap<JsString, Subscription>,
    nonces: HashMap<JsString, i64>,
    invalid: HashMap<Option<JsString>, u32>,
    operation_sequences: IndexMap<JsString, u64>,
    controls: VecDeque<Frame>,
}

struct Subscription {
    routing: Value,
    grant: JsString,
    installation: Value,
    credit: usize,
    initial_credit: usize,
    receive: u64,
    send: u64,
    continuity: u64,
    opened: Instant,
    activity: Instant,
    pending: VecDeque<Vec<u8>>,
    pending_bytes: usize,
}

impl Subscription {
    fn frame(&self, kind: &str, sequence: u64, fields: &[(&str, Value)], payload: &[u8]) -> Frame {
        frame(&self.routing, kind, sequence, fields, payload)
    }

    fn flush(&mut self, output: &Outbound) -> bool {
        if self.send == 0 {
            let accept = self.frame(
                "accept",
                0,
                &[("initialCreditBytes", json!(self.initial_credit))],
                &[],
            );
            if !output.worker_link(accept) {
                return false;
            }
            self.send = 1;
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
                    ("payloadFormat", json!("raw")),
                ],
                bytes,
            );
            if !output.worker_link(frame) {
                return false;
            }
            self.credit -= bytes.len();
            self.pending_bytes -= bytes.len();
            self.pending.pop_front();
            self.send += 1;
            self.activity = Instant::now();
        }
        true
    }
}

impl Channels {
    pub fn open(
        &mut self,
        header: &Value,
        session: Option<&Session>,
        retired: &IndexMap<JsString, u64>,
        now: i64,
    ) -> bool {
        let result = self.try_open(header, session, retired, now);
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
                self.push_control(frame(
                    header,
                    "reject",
                    0,
                    &[("code", json!(if retire { "limit-exceeded" } else { code }))],
                    &[],
                ));
                retire
            }
        }
    }

    fn try_open(
        &mut self,
        header: &Value,
        session: Option<&Session>,
        retired: &IndexMap<JsString, u64>,
        now: i64,
    ) -> Result<(), &'static str> {
        let session = session.ok_or("unauthorized")?;
        if header["effectiveRoute"] != "relay"
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
        if installed["resource"]["kind"] != "observations"
            || installation.is_null()
            || installation["subscriptionId"] != installed["resource"]["attachmentId"]
            || header["lane"] != "events"
            || header["channelKind"] != "event-subscription"
        {
            return Err("resource-unavailable");
        }
        let expiry = super::timestamp(&installed["lease"], "absoluteExpiresAt")
            .map_err(|_| "grant-expired")?;
        self.nonces.insert(nonce.clone(), expiry);
        let opened = Instant::now();
        let initial = header["initialCreditBytes"].as_u64().unwrap() as usize;
        self.active.insert(
            channel.clone(),
            Subscription {
                routing: routing(header),
                grant: grant_id.clone(),
                installation: installation.clone(),
                credit: initial,
                initial_credit: initial,
                receive: 0,
                send: 0,
                continuity: 0,
                opened,
                activity: opened,
                pending: VecDeque::new(),
                pending_bytes: 0,
            },
        );
        Ok(())
    }

    pub fn receive(&mut self, header: &Value) {
        let key = id(&header["channel"], "channelId");
        let Some(channel) = self.active.get_mut(key) else {
            return;
        };
        if ["sessionId", "effectiveRoute", "channel", "lane"]
            .iter()
            .any(|field| header[*field] != channel.routing[*field])
        {
            return;
        }
        let sequence = header["sequence"].as_u64().unwrap();
        if channel.send == 0
            || sequence != channel.receive + 1
            || header["routeGeneration"] != channel.routing["routeGeneration"]
        {
            self.close(key, "protocol-error");
            return;
        }
        channel.receive = sequence;
        channel.activity = Instant::now();
        match header["kind"].as_str() {
            Some("credit") if header["direction"] == "worker-to-client" => {
                channel.credit =
                    (channel.credit + header["bytes"].as_u64().unwrap() as usize).min(MAX_CREDIT);
            }
            Some("close") => self.close(key, header["code"].as_str().unwrap()),
            _ => self.close(key, "protocol-error"),
        }
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
            if !channel.installation["topics"]
                .as_array()
                .unwrap()
                .contains(&json!(candidate.topic))
            {
                continue;
            }
            let Some(bytes) = candidate.envelope(
                &channel.installation["subscriptionId"],
                channel.continuity,
                sequence,
            ) else {
                continue;
            };
            if bytes.len() > wire::MAX_PAYLOAD_BYTES
                || channel.pending.len() >= MAX_OBSERVATIONS
                || channel.pending_bytes + bytes.len() > MAX_OBSERVATION_BYTES
            {
                congested.push(id.clone());
                continue;
            }
            channel.continuity += 1;
            channel.pending_bytes += bytes.len();
            channel.pending.push_back(bytes);
        }
        for id in congested {
            self.close(&id, "congested");
        }
    }

    pub fn flush(&mut self, output: &Outbound) {
        while let Some(control) = self.controls.front() {
            if !output.worker_link(control.clone()) {
                return;
            }
            self.controls.pop_front();
        }
        for channel in self.active.values_mut() {
            if !channel.flush(output) {
                break;
            }
        }
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
        self.push_control(channel.frame(kind, channel.send, &[("code", json!(code))], &[]));
    }

    fn push_control(&mut self, frame: Frame) {
        if self.controls.len() < MAX_CHANNELS * 2 {
            self.controls.push_back(frame);
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
