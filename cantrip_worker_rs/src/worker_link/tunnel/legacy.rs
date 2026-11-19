//! CTTN transport from Core's secret-authenticated tunnel broker.
use super::{Carrier, Coordinator, Frame, Inbound, Link, Output, Streams, is_source_frame};
use crate::connection::Outbound;
use cantrip_wire::{JsString, Value};
use chrono::Utc;
use std::{collections::VecDeque, sync::Arc};
use uuid::Uuid;

pub(in crate::worker_link) struct Legacy {
    token: Uuid,
    identity: Option<(JsString, Value)>,
    streams: Streams,
    rejected: VecDeque<Frame>,
}

impl Default for Legacy {
    fn default() -> Self {
        Self {
            token: Uuid::new_v4(),
            identity: None,
            streams: Streams::default(),
            rejected: VecDeque::new(),
        }
    }
}

impl Legacy {
    pub fn rebind(&mut self, identity: Option<&(JsString, Value)>) {
        if self.identity.as_ref() != identity {
            *self = Self {
                identity: identity.cloned(),
                ..Self::default()
            };
        }
    }

    pub fn receive(&mut self, gateway: &Arc<Coordinator>, frame: Frame) {
        let header = frame.header();
        if header["destinationEndpointId"] != format!("worker:{}", gateway.worker).as_str()
            || !is_source_frame(header)
        {
            return;
        }
        // Core replaced the source's open frame with a connect carrying its
        // admitted record. The worker still authenticates the encrypted record
        // before touching the local endpoint.
        let link = Link {
            gateway: Arc::downgrade(gateway),
            logs: gateway.logs.clone(),
            frame_limit: None,
            carrier: Carrier::Legacy { token: self.token },
        };
        if let Ok(Inbound::Reply(rejection)) =
            self.streams.receive(frame, &link, &gateway.tunnel_streams)
            && self.rejected.len() < super::MAX_STREAMS
        {
            self.rejected.push_back(rejection);
            self.flush(&gateway.outgoing);
        }
    }

    pub fn flush(&mut self, outbound: &Outbound) {
        while let Some(frame) = self.rejected.front() {
            if !outbound.binary(frame.bytes()) {
                break;
            }
            self.rejected.pop_front();
        }
    }

    pub fn writable(&self) {
        self.streams.capacity.send_replace(());
    }

    pub fn disconnected(&mut self) {
        self.rejected.clear();
        self.writable();
    }
}

pub(super) fn active(gateway: &Coordinator, token: Uuid) -> bool {
    use_carrier(gateway, token, |_| true).unwrap_or(false)
}

pub(super) fn send(
    gateway: &Coordinator,
    token: Uuid,
    frame: &Frame,
    remote_closed: impl FnOnce() -> bool,
) -> Output {
    use_carrier(gateway, token, |legacy| {
        if remote_closed() {
            return Output::Closed;
        }
        legacy.flush(&gateway.outgoing);
        if legacy.rejected.is_empty() && gateway.outgoing.binary(frame.bytes()) {
            Output::Queued
        } else {
            Output::Pending
        }
    })
    .unwrap_or(Output::Closed)
}

fn use_carrier<T>(
    gateway: &Coordinator,
    token: Uuid,
    use_legacy: impl FnOnce(&mut Legacy) -> T,
) -> Option<T> {
    let mut state = gateway.state.lock().unwrap();
    let identity = gateway.encryption.bound_identity();
    state.sweep(Utc::now().timestamp_millis(), identity.as_ref().ok());
    if state.transport_ready && state.legacy_tunnels.token == token {
        Some(use_legacy(&mut state.legacy_tunnels))
    } else {
        None
    }
}
