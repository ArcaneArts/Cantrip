use super::{Outgoing, Peer, SurfaceFrameHandler, SurfaceFrameSubscription, WorkerBridge};
use crate::{
    remote_surfaces::frame::{self, Frame},
    wire::Value,
};
use std::sync::Arc;
impl WorkerBridge {
    pub fn send_surface_frame(&self, worker: &str, header: Value, payload: &[u8]) -> bool {
        let state = self.state.lock().unwrap();
        let Some(peer) = state.peers.get(worker).filter(|p| p.is_open()) else {
            return false;
        };
        if peer.buffered_amount() > 8 * 1024 * 1024 {
            if header["channel"] != "frame" && header["channel"] != "cursor" {
                peer.close(1013, "Remote Surface worker channel is congested");
            }
            return false;
        }
        let Ok(frame) = frame::create(header, payload) else {
            return false;
        };
        peer.send_surface_frame(frame)
    }
    pub fn subscribe_surface_frames(
        &self,
        worker: &str,
        handler: SurfaceFrameHandler,
    ) -> SurfaceFrameSubscription {
        self.surface_frames.subscribe(worker, handler)
    }
    pub fn receive_surface_frame(&self, worker: &str, peer: &Peer, bytes: Arc<[u8]>) -> bool {
        let _lifecycle = self.lifecycle.lock();
        if self
            .state
            .lock()
            .unwrap()
            .peers
            .get(worker)
            .is_none_or(|p| p.id != peer.id)
        {
            return false;
        }
        if frame::decode(bytes)
            .and_then(|frame| self.surface_frames.deliver(worker, frame))
            .is_err()
        {
            self.invalid_binary_frame(worker);
            return false;
        }
        true
    }
}
impl Peer {
    fn send_surface_frame(&self, frame: Frame) -> bool {
        if !self.is_open() {
            return false;
        }
        let bytes = super::super::output::framed_size(frame.bytes().len());
        self.output
            .send(Outgoing::Surface(self.buffered.reserve(frame, bytes)))
            .is_ok()
    }
}
