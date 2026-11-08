use super::*;
use crate::workers::{bridge::Continuity, output::Buffered};
use axum::{Router, extract::Request, routing::get};
use futures::StreamExt;
use std::{
    os::fd::AsRawFd,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

#[tokio::test]
async fn backpressured_accepted_frames_and_reservations_survive_close() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let (peer, receiver) = Peer::new(Continuity {
            owner: "owner".into(), credential: "credential".into(), process_generation: "generation".into(),
        });
        let buffered = Buffered::default();
        const SIZE: usize = 4 * 1024 * 1024;
        for byte in [b'A', b'B'] {
            let value = String::from_utf8(vec![byte; SIZE]).unwrap();
            peer.output.send(Outgoing::Text(buffered.reserve(value, SIZE))).ok().unwrap();
        }
        let receiver = Arc::new(Mutex::new(Some(receiver)));
        let finished = Arc::new(AtomicBool::new(false));
        let (closed, completion) = oneshot::channel();
        let closed = Arc::new(Mutex::new(Some(closed)));
        let router = Router::new().route("/", get({
            let peer = peer.clone();
            let finished = finished.clone();
            move |request: Request| {
                let peer = peer.clone();
                let finished = finished.clone();
                let mut receiver = receiver.lock().unwrap().take().unwrap();
                let closed = closed.lock().unwrap().take().unwrap();
                async move {
                    super::super::super::websocket::upgrade(request, SIZE * 3, move |mut socket, _| async move {
                        socket.on_closed(move || { let _ = closed.send(()); });
                        let (sink, mut stream) = socket.split();
                        let (_shutdown, shutdown) = watch::channel(false);
                        assert!(run(sink, &mut receiver, &peer, shutdown).await);
                        finished.store(true, Ordering::Release);
                        while let Some(Ok(message)) = stream.next().await {
                            if matches!(message, Message::Close(_)) { break; }
                        }
                    })
                }
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let mut client = TcpStream::connect(address).await.unwrap();
        // Apply actual receive pressure; no simulated sink or timing-only
        // assumption stands in for the stalled TCP flush below.
        let size: libc::c_int = 64 * 1024;
        assert_eq!(unsafe { libc::setsockopt(client.as_raw_fd(), libc::SOL_SOCKET, libc::SO_RCVBUF,
            &size as *const _ as *const libc::c_void, std::mem::size_of_val(&size) as libc::socklen_t) }, 0);
        client.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") { header.push(client.read_u8().await.unwrap()); }
        assert!(header.starts_with(b"HTTP/1.1 101"));
        async fn text_header(client: &mut TcpStream) {
            assert_eq!(client.read_u8().await.unwrap(), 0x81);
            assert_eq!(client.read_u8().await.unwrap(), 127);
            assert_eq!(client.read_u64().await.unwrap(), SIZE as u64);
        }
        text_header(&mut client).await;
        // We have observed the first frame on wire, but hold its payload. Both
        // admitted messages must precede CLOSE even when it arrives mid-flush.
        peer.close_empty();
        tokio::time::sleep(Duration::from_millis(75)).await;
        assert!(!finished.load(Ordering::Acquire), "actual TCP writer remains backpressured");
        assert!(buffered.bytes() >= SIZE, "unflushed frame reservation remains owned");
        let mut bytes = vec![0; SIZE];
        client.read_exact(&mut bytes).await.unwrap();
        assert!(bytes.iter().all(|byte| *byte == b'A'));
        text_header(&mut client).await;
        client.read_exact(&mut bytes).await.unwrap();
        assert!(bytes.iter().all(|byte| *byte == b'B'));
        assert_eq!(client.read_u8().await.unwrap(), 0x88);
        assert_eq!(client.read_u8().await.unwrap(), 0, "empty CLOSE follows both complete frames");
        client.write_all(&[0x88, 0x80, 1, 2, 3, 4]).await.unwrap();
        client.shutdown().await.unwrap();
        completion.await.unwrap();
        assert_eq!(buffered.bytes(), 0);
        assert!(finished.load(Ordering::Acquire));
        server.abort();
    }).await.expect("actual backpressure/close handshake completes");
}
