//! Route an authenticated direct capability into the shared TCP stream engine.
use super::{
    Carrier, Coordinator, Frame, Inbound, Link, MAX_STREAMS, Output, Streams, id, is_source_frame,
};
use anyhow::{Result, ensure};
use cantrip_transport::output::{Buffered, Queued, framed_size};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

const MAX_BUFFER: usize = 8 * 1024 * 1024;
const LOW_WATER: usize = 256 * 1024;

pub(in crate::worker_link) struct DirectTunnel {
    route: Value,
    trace: Option<Value>,
    state: Mutex<Option<State>>,
    buffer: Buffered,
    outgoing: mpsc::UnboundedSender<Queued<Frame>>,
}

#[derive(Default)]
struct State {
    streams: Streams,
    // Desktop acknowledges destination close with a final source frame.
    // Its sequence stays valid independently of the lifetime of the TCP socket.
    sources: HashMap<JsString, u64>,
}

impl DirectTunnel {
    pub fn new(
        route: Value,
        trace: Option<Value>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Queued<Frame>>) {
        let (outgoing, incoming) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                route,
                trace,
                state: Mutex::new(Some(State::default())),
                buffer: Buffered::default(),
                outgoing,
            }),
            incoming,
        )
    }

    pub fn active(&self) -> bool {
        self.state.lock().unwrap().is_some()
    }

    pub fn close(&self) {
        self.state.lock().unwrap().take();
    }

    pub fn writable(&self) {
        if self.buffer.bytes() <= LOW_WATER
            && let Some(state) = self.state.lock().unwrap().as_ref()
        {
            state.streams.capacity.send_replace(());
        }
    }

    pub fn receive(self: &Arc<Self>, gateway: &Arc<Coordinator>, frame: Frame) -> Result<()> {
        let mut slot = self.state.lock().unwrap();
        let Some(state) = slot.as_mut() else {
            return Ok(());
        };
        let header = frame.header();
        ensure!(
            [
                "tunnelId",
                "attachmentId",
                "sourceEndpointId",
                "destinationEndpointId"
            ]
            .iter()
            .all(|field| header[*field] == self.route[*field]),
            "Direct tunnel frame escaped its capability binding."
        );
        let connection = id(header, "connectionId");
        let link = Link {
            gateway: Arc::downgrade(gateway),
            logs: gateway.logs.clone(),
            carrier: Carrier::Direct(Arc::downgrade(self)),
        };
        let routed = if header["kind"] == "open" {
            ensure!(
                header["sequence"] == 0 && !state.sources.contains_key(connection),
                "Direct tunnel connection identity is invalid."
            );
            ensure!(
                state.sources.len() < MAX_STREAMS,
                "Direct connection capacity exceeded."
            );
            let mut connect = header.clone();
            connect["kind"] = json!("connect");
            connect["target"] = self.route["target"].clone();
            if let Some(trace) = &self.trace {
                connect["diagnosticTraceId"] = trace.clone();
            }
            state.sources.insert(connection.clone(), 1);
            Ok(state
                .streams
                .connect(connect, &link, &gateway.tunnel_streams))
        } else {
            ensure!(
                header["kind"] != "connect" && is_source_frame(header),
                "Direct tunnel frame kind is invalid."
            );
            let expected = state.sources.get_mut(connection);
            let Some(expected) = expected else {
                anyhow::bail!("Unknown direct tunnel connection")
            };
            ensure!(
                header["sequence"].as_u64() == Some(*expected),
                "Invalid direct tunnel sequence."
            );
            *expected += 1;
            if matches!(header["kind"].as_str(), Some("close" | "error")) {
                state.sources.remove(connection);
            }
            state.streams.receive(frame, &link, &gateway.tunnel_streams)
        };
        match routed {
            Ok(Inbound::Reply(frame)) => {
                ensure!(
                    matches!(self.enqueue(&frame), Output::Queued),
                    "Direct tunnel socket is congested."
                );
            }
            Ok(Inbound::Retained | Inbound::Consumed) | Err("congested") => {}
            Err(code) => anyhow::bail!("Invalid direct stream: {code}"),
        }
        Ok(())
    }

    pub fn send(&self, frame: &Frame, remote_closed: impl FnOnce() -> bool) -> Output {
        let state = self.state.lock().unwrap();
        let Some(state) = state.as_ref() else {
            return Output::Closed;
        };
        if remote_closed()
            || !state
                .sources
                .contains_key(id(frame.header(), "connectionId"))
        {
            return Output::Closed;
        }
        self.enqueue(frame)
    }

    fn enqueue(&self, frame: &Frame) -> Output {
        match self
            .buffer
            .bounded(frame.clone(), framed_size(frame.bytes().len()), MAX_BUFFER)
        {
            Some(frame) => {
                if self.outgoing.send(frame).is_ok() {
                    Output::Queued
                } else {
                    Output::Closed
                }
            }
            None => Output::Pending,
        }
    }
}
