use super::{FrameHandler, FrameSubscription, Peer, WorkerBridge};
use crate::worker_links::frame::{self, Frame};
use std::sync::Arc;

impl WorkerBridge {
    pub fn send_worker_link_frame(&self, worker: &str, frame: Frame) -> bool {
        let state = self.state.lock().unwrap();
        state
            .peers
            .get(worker)
            .is_some_and(|peer| peer.send_frame(frame))
    }
    pub fn subscribe_worker_link_frames(
        &self,
        worker: &str,
        handler: FrameHandler,
    ) -> FrameSubscription {
        self.frames.subscribe(worker, handler)
    }
    pub fn receive_worker_link_frame(&self, worker: &str, peer: &Peer, bytes: Arc<[u8]>) -> bool {
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
        let decoded = frame::decode(bytes);
        if decoded
            .map_err(anyhow::Error::from)
            .and_then(|frame| self.frames.deliver(worker, frame))
            .is_err()
        {
            self.invalid_binary_frame(worker);
            return false;
        }
        true
    }
}
