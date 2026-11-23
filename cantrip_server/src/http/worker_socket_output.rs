//! Preserve accepted frame order and the reference ws closing deadline.
use super::{Peer, WebSocket};
use crate::workers::bridge::Outgoing;
use futures::{SinkExt, stream::SplitSink};
use tokio::sync::{mpsc, watch};
use tungstenite::{Message, protocol::CloseFrame};

pub(super) fn close_message(code: u16, reason: String) -> Message {
    Message::Close((code != 1005).then(|| CloseFrame {
        code: code.into(),
        reason: reason.into(),
    }))
}
pub(super) async fn expired(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
async fn send(
    sink: &mut SplitSink<WebSocket, Message>,
    message: Message,
    peer: &Peer,
    closing: &mut watch::Receiver<Option<(u16, String)>>,
    shutdown: &mut watch::Receiver<bool>,
) -> bool {
    let sending = sink.send(message);
    tokio::pin!(sending);
    loop {
        let deadline = peer.close_deadline();
        tokio::select! {
            result = &mut sending => return result.is_ok(),
            _ = closing.changed() => {},
            _ = shutdown.changed() => peer.close_empty(),
            _ = expired(deadline) => return false,
        }
    }
}
/// True means CLOSE was flushed. The reader must remain alive for the ACK.
pub(super) async fn run(
    mut sink: SplitSink<WebSocket, Message>,
    output: &mut mpsc::UnboundedReceiver<Outgoing>,
    peer: &Peer,
    mut shutdown: watch::Receiver<bool>,
) -> bool {
    let mut closing = peer.closing.subscribe();
    if *shutdown.borrow() {
        peer.close_empty();
    }
    loop {
        let deadline = peer.close_deadline();
        let mut message = tokio::select! {
            message = output.recv() => match message {Some(message) => message, None => return false},
            _ = shutdown.changed() => {peer.close_empty(); continue;},
            _ = closing.changed() => continue,
            _ = expired(deadline) => return false,
        };
        let (frame, is_close) = match &mut message {
            Outgoing::Text(text) => (Message::Text(text.take().into()), false),
            Outgoing::Binary(frame) => (
                Message::Binary(tungstenite::Bytes::from_owner(frame.take())),
                false,
            ),
            Outgoing::Tunnel(frame) => (
                Message::Binary(tungstenite::Bytes::from_owner(frame.take())),
                false,
            ),
            Outgoing::Surface(frame) => (
                Message::Binary(tungstenite::Bytes::from_owner(frame.take())),
                false,
            ),
            Outgoing::Close(code, reason) => (close_message(*code, std::mem::take(reason)), true),
        };
        // Keep this exact send future through close/shutdown notifications:
        // cancellation would lose a partially written accepted frame.
        if !send(&mut sink, frame, peer, &mut closing, &mut shutdown).await {
            return false;
        }
        // Preserve the reservation through the actual flush, including while
        // a close request wakes a backpressured writer.
        drop(message);
        if is_close {
            return true;
        }
    }
}
#[cfg(all(test, unix))]
#[path = "worker_socket_output_tests.rs"]
mod tests;
