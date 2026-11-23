//! The root gateway carries only framed bytes. The Worker dials the loopback
//! destination captured in the protected record, never an address in a frame.
use super::{
    Coordinator,
    guest::{Preparation, Stream},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, DuplexStream},
    net::TcpStream,
    sync::{Notify, mpsc},
    task::{AbortHandle, JoinSet},
    time::timeout,
};
use uuid::Uuid;

const WINDOW: usize = 65_536;
const MAX_HEADER: usize = 1024;
const MAX_PEERS: usize = 16;
const CHUNK: usize = 16 * 1024;

pub(super) struct Control {
    _task: JoinSet<()>,
}

impl Control {
    pub(super) fn activate(
        gateway: &Arc<Coordinator>,
        channel: JsString,
        token: Uuid,
        preparation: Arc<Preparation>,
        stream: Stream,
        target: Vec<SocketAddr>,
    ) -> Self {
        let gateway = Arc::downgrade(gateway);
        let mut task = JoinSet::new();
        task.spawn(async move {
            let confirmed = preparation.confirm_listener().await.is_ok();
            let ready = confirmed
                && stream.active()
                && gateway.upgrade().is_some_and(|gateway| {
                    preparation.current(&gateway)
                        && gateway
                            .update_channels(|channels| channels.listener_ready(&channel, token))
                });
            if ready {
                let Stream {
                    socket,
                    fault,
                    _lifetime,
                    ..
                } = stream;
                tokio::select! {
                    biased;
                    Ok(()) = fault => {},
                    _ = forward(socket, target) => {},
                }
            } else {
                drop(stream);
            }
            if let Some(gateway) = gateway.upgrade() {
                gateway.update_channels(|channels| channels.listener_closed(&channel, token));
            }
        });
        Self { _task: task }
    }
}

enum Inbound {
    Open,
    Credit(usize),
    Data(Vec<u8>),
    Fin,
    Close,
}

struct Outbound {
    header: Value,
    payload: Vec<u8>,
}

impl Outbound {
    fn new(kind: &str, id: u32) -> Self {
        Self {
            header: json!({"type":kind,"id":id}),
            payload: Vec::new(),
        }
    }
}

async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<(u32, Inbound)> {
    let header_len = reader.read_u32().await? as usize;
    let payload_len = reader.read_u32().await? as usize;
    ensure!(
        (1..=MAX_HEADER).contains(&header_len) && payload_len <= WINDOW,
        "Invalid guest listener frame size."
    );
    let mut bytes = [0; MAX_HEADER];
    reader.read_exact(&mut bytes[..header_len]).await?;
    let header = parse_json_text(std::str::from_utf8(&bytes[..header_len])?)
        .map_err(|_| anyhow!("Invalid guest listener frame JSON."))?;
    let id = header["id"]
        .as_u64()
        .filter(|id| (1..=i32::MAX as u64).contains(id))
        .context("Invalid guest listener connection ID.")? as u32;
    let fields = header
        .as_object()
        .context("Invalid guest listener header.")?
        .len();
    let frame = match header["type"].as_str() {
        Some("open")
            if fields == 3
                && payload_len == 0
                && header["credit"].as_u64() == Some(WINDOW as u64) =>
        {
            Inbound::Open
        }
        Some("credit") if fields == 3 && payload_len == 0 => Inbound::Credit(
            header["bytes"]
                .as_u64()
                .filter(|count| (1..=WINDOW as u64).contains(count))
                .context("Invalid guest listener credit.")? as usize,
        ),
        Some("data") if fields == 2 && payload_len > 0 => {
            let mut payload = vec![0; payload_len];
            reader.read_exact(&mut payload).await?;
            Inbound::Data(payload)
        }
        Some("fin") if fields == 2 && payload_len == 0 => Inbound::Fin,
        Some("close") if fields == 2 && payload_len == 0 => Inbound::Close,
        _ => bail!("Invalid guest listener frame fields."),
    };
    Ok((id, frame))
}

async fn forward(stream: DuplexStream, target: Vec<SocketAddr>) -> Result<()> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (output, mut frames) = mpsc::channel::<Outbound>(32);
    let write = async {
        while let Some(frame) = frames.recv().await {
            let json = frame.header.stringify();
            writer.write_u32(json.len() as u32).await?;
            writer.write_u32(frame.payload.len() as u32).await?;
            writer.write_all(json.as_bytes()).await?;
            writer.write_all(&frame.payload).await?;
        }
        Ok(())
    };
    tokio::select! {
        result = dispatch(&mut reader, &target, output) => result,
        result = write => result,
    }
}

struct Peer {
    flow: Arc<Flow>,
    task: AbortHandle,
    draining: bool,
}

async fn dispatch(
    reader: &mut (impl AsyncRead + Unpin),
    target: &[SocketAddr],
    output: mpsc::Sender<Outbound>,
) -> Result<()> {
    let mut peers = HashMap::<u32, Peer>::new();
    let mut tasks = JoinSet::<(u32, bool)>::new();
    let mut last = 0;
    loop {
        let incoming = read_frame(reader);
        tokio::pin!(incoming);
        let (id, frame) = loop {
            tokio::select! {
                next = &mut incoming => break next?,
                done = tasks.join_next(), if !tasks.is_empty() => {
                    match done {
                        Some(Ok((id, success))) => {
                            if peers.get(&id).is_some_and(|peer| !success || peer.draining) {
                                let peer = peers.remove(&id).unwrap();
                                if !peer.draining {
                                    send(&output, Outbound::new("close", id)).await?;
                                }
                            }
                        }
                        Some(Err(error)) if error.is_panic() => return Err(error.into()),
                        _ => {}
                    }
                }
            }
        };
        match frame {
            Inbound::Open => {
                ensure!(
                    id > last && peers.values().filter(|peer| !peer.draining).count() < MAX_PEERS,
                    "Guest listener connection escaped its limit."
                );
                last = id;
                if peers.len() >= 2 * MAX_PEERS || tasks.len() >= 2 * MAX_PEERS {
                    send(&output, Outbound::new("close", id)).await?;
                    continue;
                }
                let flow = Arc::new(Flow::new());
                let task = tasks.spawn({
                    let target = target.to_owned();
                    let output = output.clone();
                    let flow = flow.clone();
                    async move { (id, relay(id, &target, flow, &output).await.is_ok()) }
                });
                peers.insert(
                    id,
                    Peer {
                        flow,
                        task,
                        draining: false,
                    },
                );
            }
            Inbound::Close => {
                if let Some(peer) = peers.get_mut(&id) {
                    // A guest can finish after receiving the Host FIN while
                    // bytes sent before the guest FIN still await the Host.
                    if peer.flow.both_finished() && !peer.task.is_finished() {
                        peer.draining = true;
                    } else if let Some(peer) = peers.remove(&id) {
                        peer.task.abort();
                    }
                }
            }
            frame => {
                if let Some(peer) = peers.get(&id).filter(|peer| !peer.draining) {
                    peer.flow.receive(frame)?;
                }
            }
        }
    }
}

struct Flow {
    state: Mutex<State>,
    input: Notify,
    writable: Notify,
}

struct State {
    accepted: bool,
    credit: usize,
    receive: usize,
    pending: VecDeque<u8>,
    fin: bool,
    host_fin: bool,
}

impl Flow {
    fn new() -> Self {
        Self {
            state: Mutex::new(State {
                accepted: false,
                credit: WINDOW,
                receive: WINDOW,
                pending: VecDeque::new(),
                fin: false,
                host_fin: false,
            }),
            input: Notify::new(),
            writable: Notify::new(),
        }
    }

    fn both_finished(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.fin && state.host_fin
    }

    fn receive(&self, frame: Inbound) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        match frame {
            Inbound::Credit(bytes) => {
                ensure!(
                    state.credit + bytes <= WINDOW,
                    "Guest listener credit escaped its window."
                );
                state.credit += bytes;
                self.writable.notify_one();
            }
            Inbound::Data(payload) => {
                ensure!(
                    state.accepted && !state.fin && payload.len() <= state.receive,
                    "Guest listener data escaped its window."
                );
                state.receive -= payload.len();
                state.pending.extend(payload);
                self.input.notify_one();
            }
            Inbound::Fin => {
                ensure!(
                    state.accepted && !state.fin,
                    "Invalid guest listener half-close."
                );
                state.fin = true;
                self.input.notify_one();
            }
            _ => unreachable!("dispatch owns peer lifetimes"),
        }
        Ok(())
    }

    async fn window(&self) -> usize {
        loop {
            let credit = self.state.lock().unwrap().credit;
            if credit > 0 {
                return credit.min(CHUNK);
            }
            self.writable.notified().await;
        }
    }

    async fn next_input(&self) -> Option<Vec<u8>> {
        loop {
            {
                let mut state = self.state.lock().unwrap();
                let length = state.pending.len().min(CHUNK);
                if length > 0 {
                    return Some(state.pending.drain(..length).collect());
                }
                if state.fin {
                    return None;
                }
            }
            self.input.notified().await;
        }
    }
}

async fn relay(
    id: u32,
    target: &[SocketAddr],
    flow: Arc<Flow>,
    output: &mpsc::Sender<Outbound>,
) -> Result<()> {
    let socket = timeout(Duration::from_secs(15), TcpStream::connect(target)).await??;
    socket.set_nodelay(true)?;
    flow.state.lock().unwrap().accepted = true;
    let mut accepted = Outbound::new("accepted", id);
    accepted.header["credit"] = json!(WINDOW);
    send(output, accepted).await?;
    let (mut read, mut write) = socket.into_split();
    let to_guest = async {
        let mut buffer = [0; CHUNK];
        loop {
            let limit = flow.window().await;
            let count = read.read(&mut buffer[..limit]).await?;
            if count == 0 {
                flow.state.lock().unwrap().host_fin = true;
                return send(output, Outbound::new("fin", id)).await;
            }
            flow.state.lock().unwrap().credit -= count;
            let mut frame = Outbound::new("data", id);
            frame.payload.extend_from_slice(&buffer[..count]);
            send(output, frame).await?;
        }
    };
    let to_host = async {
        while let Some(bytes) = flow.next_input().await {
            write.write_all(&bytes).await?;
            flow.state.lock().unwrap().receive += bytes.len();
            let mut frame = Outbound::new("credit", id);
            frame.header["bytes"] = json!(bytes.len());
            send(output, frame).await?;
        }
        write.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::try_join!(to_guest, to_host)?;
    Ok(())
}

async fn send(output: &mpsc::Sender<Outbound>, frame: Outbound) -> Result<()> {
    output
        .send(frame)
        .await
        .map_err(|_| anyhow!("Guest listener carrier closed."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn listener_rejects_out_of_window_frames_and_guest_supplied_destinations() {
        for (header, payload) in [
            (r#"{"type":"open","id":1,"credit":65536,"port":22}"#, 0),
            (r#"{"type":"open","id":1,"credit":65537}"#, 0),
            (r#"{"type":"data","id":1}"#, 65_537),
        ] {
            let mut wire = Vec::new();
            wire.extend_from_slice(&(header.len() as u32).to_be_bytes());
            wire.extend_from_slice(&(payload as u32).to_be_bytes());
            wire.extend_from_slice(header.as_bytes());
            assert!(read_frame(&mut wire.as_slice()).await.is_err());
        }
        let flow = Flow::new();
        assert!(flow.receive(Inbound::Credit(1)).is_err());
        assert!(flow.receive(Inbound::Data(vec![1])).is_err());
    }
}
