//! Single-shot completion and ordered event/response admission from the bridge.
//! The caller owns request IDs, its correlation map, peer fencing, and handlers.
use std::sync::Mutex;
use tokio::sync::{mpsc, oneshot};

pub enum Delivery<E, R> {
    Event(E),
    Response(R),
    Finished,
}
pub struct Correlation<E, R> {
    delivery: mpsc::UnboundedSender<Delivery<E, R>>,
    completion: Mutex<Option<oneshot::Sender<R>>>,
}
pub type Channels<E, R> = (
    Correlation<E, R>,
    oneshot::Receiver<R>,
    mpsc::UnboundedReceiver<Delivery<E, R>>,
);
impl<E, R> Correlation<E, R> {
    pub fn channel() -> Channels<E, R> {
        let (tx, rx) = oneshot::channel();
        let (delivery, events) = mpsc::unbounded_channel();
        (
            Self {
                delivery,
                completion: Mutex::new(Some(tx)),
            },
            rx,
            events,
        )
    }
    pub fn event(&self, event: E) {
        let _ = self.delivery.send(Delivery::Event(event));
    }
    pub fn response(&self, response: R) {
        let _ = self.delivery.send(Delivery::Response(response));
    }
    /// The winner runs adapter cleanup/metrics before publishing completion.
    /// Later finish attempts do nothing. Callback order and the lock lifetime
    /// match the original bridge; callbacks must not reenter this completion.
    pub fn finish(&self, result: R, before: impl FnOnce(&R)) {
        if let Some(tx) = self.completion.lock().unwrap().take() {
            before(&result);
            let _ = tx.send(result);
            let _ = self.delivery.send(Delivery::Finished);
        }
    }
}
