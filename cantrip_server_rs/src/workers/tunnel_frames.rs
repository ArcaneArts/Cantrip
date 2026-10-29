use super::{Outgoing, Peer, TunnelFrameHandler, TunnelFrameSubscription, WorkerBridge};
use crate::{
    tunnels::frame::{self, Frame},
    wire::{Value, value::json},
};
use std::sync::Arc;

impl WorkerBridge {
    pub fn send_tunnel_frame(&self, worker: &str, header: Value, payload: &[u8]) -> bool {
        // Offline/congestion checks precede encoding, matching the bridge.
        let state = self.state.lock().unwrap();
        let Some(peer) = state
            .peers
            .get(worker)
            .filter(|p| p.is_open() && p.buffered_amount() <= 8 * 1024 * 1024)
        else {
            return false;
        };
        let Ok(frame) = frame::create(header, payload) else {
            return false;
        };
        peer.send_tunnel_frame(frame)
    }
    pub fn subscribe_tunnel_frames(
        &self,
        worker: &str,
        handler: TunnelFrameHandler,
    ) -> TunnelFrameSubscription {
        self.tunnel_frames.subscribe(worker, handler)
    }
    pub fn receive_tunnel_frame(&self, worker: &str, peer: &Peer, bytes: Arc<[u8]>) -> bool {
        // The Source admits and delivers a binary message in one synchronous
        // turn. Replacement cannot overtake decoding; callbacks may reenter.
        let _lifecycle = self.lifecycle.lock();
        if self
            .state
            .lock()
            .unwrap()
            .peers
            .get(worker)
            .is_none_or(|current| current.id != peer.id)
        {
            return false;
        }
        if frame::decode(bytes)
            .and_then(|frame| self.tunnel_frames.deliver(worker, frame))
            .is_err()
        {
            self.invalid_binary_frame(worker);
            return false;
        }
        true
    }
    pub(super) fn invalid_binary_frame(&self, worker: &str) {
        use crate::operations::logging::{LogCall, key};
        (self.logger)(LogCall::repeated(
            key("worker-binary-invalid:", &[&json!(worker)]),
            "warn",
            "Worker sent an invalid binary frame",
            json!({"event":"worker.transport.invalid-binary-frame","subsystem":"worker-transport","reasonCode":"invalid-binary-frame","status":"rejected","workerId":worker}),
            None,
        ));
    }
}
impl Peer {
    fn send_tunnel_frame(&self, frame: Frame) -> bool {
        if !self.is_open() {
            return false;
        }
        let bytes = super::super::output::framed_size(frame.bytes().len());
        let Some(queued) = self.buffered.bounded(frame, bytes, 8 * 1024 * 1024) else {
            return false;
        };
        self.output.send(Outgoing::Tunnel(queued)).is_ok()
    }
}
