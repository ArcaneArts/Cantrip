//! Track upgrades before their handshake completes, through actual IO cleanup.
//! Process shutdown must drain them before dropping the async runtime/database.
use super::Socket;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
use uuid::Uuid;

#[derive(Default)]
struct State {
    closing: bool,
    peers: HashMap<Uuid, Option<Arc<dyn Socket>>>,
}
#[derive(Default)]
pub struct Transports {
    state: Mutex<State>,
    changed: Notify,
}
pub struct TransportLifetime {
    transports: Arc<Transports>,
    id: Uuid,
}
impl Transports {
    pub fn begin(self: &Arc<Self>) -> TransportLifetime {
        let id = Uuid::new_v4();
        self.state.lock().unwrap().peers.insert(id, None);
        TransportLifetime {
            transports: self.clone(),
            id,
        }
    }
    pub fn pre_close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closing = true;
        let peers = state.peers.values().flatten().cloned().collect::<Vec<_>>();
        drop(state);
        for peer in peers {
            // Fastify's websocket preClose sends an empty close payload before
            // application onClose hooks. 1005 denotes that absence locally;
            // the transport must never encode reserved code 1005 on the wire.
            peer.close(1005, "");
        }
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().unwrap().peers.is_empty() {
                return;
            }
            changed.await;
        }
    }
}
impl TransportLifetime {
    pub fn attach(&self, socket: Arc<dyn Socket>) {
        let mut state = self.transports.state.lock().unwrap();
        state.peers.insert(self.id, Some(socket.clone()));
        let closing = state.closing;
        drop(state);
        if closing {
            socket.close(1005, "");
        }
    }
}
impl Drop for TransportLifetime {
    fn drop(&mut self) {
        self.transports.state.lock().unwrap().peers.remove(&self.id);
        self.transports.changed.notify_waiters();
    }
}
