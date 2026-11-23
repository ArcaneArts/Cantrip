use crate::{
    live,
    tunnels::{frame, runtime},
    workers::output::{Buffered, Queued, framed_size},
};
use anyhow::{Result, bail};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};
pub(super) enum Outgoing {
    Text(Queued<String>),
    Binary(Queued<frame::Frame>),
    Ping(Queued<Vec<u8>>),
    Flush,
    Close(u16, String),
    Terminate,
}
pub(super) struct Peer {
    pub state: AtomicU8,
    buffered: Buffered,
    pub queue: Mutex<mpsc::UnboundedSender<Outgoing>>,
    deadline: watch::Sender<Option<tokio::time::Instant>>,
}
impl Peer {
    pub fn new(
        queue: mpsc::UnboundedSender<Outgoing>,
        deadline: watch::Sender<Option<tokio::time::Instant>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(1),
            buffered: Buffered::default(),
            queue: Mutex::new(queue),
            deadline,
        })
    }
    pub fn terminate(&self) {
        self.state.store(3, Ordering::Release);
        let _ = self.queue.lock().unwrap().send(Outgoing::Terminate);
    }
}
impl live::Socket for Peer {
    fn is_open(&self) -> bool {
        self.state.load(Ordering::Acquire) == 1
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.bytes()
    }
    fn send(&self, text: Arc<str>) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if !self.is_open() {
            bail!("Tunnel socket is closed");
        }
        queue.send(Outgoing::Text(
            self.buffered
                .reserve(text.to_string(), framed_size(text.len())),
        ))?;
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        let queue = self.queue.lock().unwrap();
        if self
            .state
            .compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.deadline
                .send_replace(Some(tokio::time::Instant::now() + Duration::from_secs(30)));
            let _ = queue.send(if reason.len() > 123 {
                Outgoing::Terminate
            } else {
                Outgoing::Close(code, reason.into())
            });
        }
    }
}
impl runtime::Socket for Peer {
    fn state(&self) -> u8 {
        self.state.load(Ordering::Acquire)
    }
    fn send_binary(&self, frame: frame::Frame) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if self.state() != 1 {
            bail!("Tunnel socket is closed");
        }
        let bytes = framed_size(frame.bytes().len());
        queue.send(Outgoing::Binary(self.buffered.reserve(frame, bytes)))?;
        Ok(())
    }
    fn ping(&self, token: &[u8]) -> Result<()> {
        let queue = self.queue.lock().unwrap();
        if self.state() != 1 {
            bail!("Tunnel socket is closed");
        }
        queue.send(Outgoing::Ping(
            self.buffered
                .reserve(token.to_vec(), framed_size(token.len())),
        ))?;
        Ok(())
    }
}
