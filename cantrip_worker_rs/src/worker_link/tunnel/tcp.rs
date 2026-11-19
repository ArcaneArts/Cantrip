//! A logical TCP stream with independent nested credit and TCP half-closes.
use super::{
    Destination, FROM_DESTINATION, FROM_SOURCE, Frame, Link, Output, Reply, TargetError, wire,
};
use cantrip_crypto::content::{open_tunnel_data_frame, seal_tunnel_data_frame};
use cantrip_wire::{Value, value::json};
use std::{collections::VecDeque, io::ErrorKind, ops::Range, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, tcp::OwnedWriteHalf},
    sync::{mpsc, watch},
    time::{Instant, timeout},
};
use zeroize::Zeroizing;

const INITIAL_CREDIT: usize = 256 * 1024;
const WRITE_BUFFER_LIMIT: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) async fn serve(
    link: Link,
    capacity: watch::Receiver<()>,
    request: Frame,
    mut input: mpsc::Receiver<Frame>,
) {
    let mut output = OutputStream {
        link,
        capacity,
        reply: Reply::new(request.header()),
    };
    let destination =
        output.link.gateway.upgrade().map(|gateway| {
            Destination::open(&gateway.encryption, &gateway.worker, request.header())
        });
    let Some(destination) = destination else {
        return;
    };
    if !output.link.active() {
        return;
    }
    let log = StreamLog::new(&output.link, request.header());
    let mut deferred = VecDeque::new();
    let end = match destination {
        Ok(destination) => {
            log.event(
                "debug",
                "tunnel.destination.opening",
                "connect",
                "started",
                "Tunnel destination logical stream opening",
            );
            let end = match connect(&destination, &mut input, &mut deferred).await {
                Ok(socket) => {
                    log.event(
                        "info",
                        "tunnel.destination.connected",
                        "connect",
                        "completed",
                        "Tunnel destination logical stream connected",
                    );
                    let accepted = output
                        .reply
                        .control("accepted", &[("initialCreditBytes", json!(INITIAL_CREDIT))]);
                    if output.send(accepted).await {
                        let initial =
                            request.header()["initialCreditBytes"].as_u64().unwrap() as usize;
                        Stream::new(initial, destination.protection)
                            .run(socket, &mut input, &mut deferred, &mut output)
                            .await
                    } else {
                        End::Remote
                    }
                }
                Err(end) => end,
            };
            log.finished(&end);
            end
        }
        Err(error) => {
            log.target_rejected(&error, &request.header()["target"]["targetKind"]);
            End::Rejected(error.code())
        }
    };
    // After logical retirement the attachment still owns the outer credit.
    // Closing the receiver first prevents producers from adding to this drain.
    input.close();
    let mut returned = deferred.iter().map(|frame| frame.bytes().len()).sum();
    while let Ok(frame) = input.try_recv() {
        returned += frame.bytes().len();
    }
    output.link.credit_bytes(returned);
    if let Some(frame) = end.frame(&output.reply) {
        output.send(frame).await;
    }
}

async fn connect(
    destination: &Destination,
    input: &mut mpsc::Receiver<Frame>,
    deferred: &mut VecDeque<Frame>,
) -> Result<TcpStream, End> {
    let addresses = destination.addresses();
    let connected = timeout(CONNECT_TIMEOUT, TcpStream::connect(addresses.as_slice()));
    tokio::pin!(connected);
    let socket = loop {
        tokio::select! {
            result = &mut connected => break match result {
                Ok(Ok(socket)) => socket,
                Ok(Err(_)) => return Err(End::Error),
                Err(_) => return Err(End::Rejected("target-unavailable")),
            },
            message = input.recv(), if deferred.len() < super::INBOUND_FRAMES => {
                let frame = message.ok_or(End::Remote)?;
                let header = frame.header();
                let close = deferred.is_empty()
                    && header["sequence"] == 1
                    && matches!(header["kind"].as_str(), Some("close" | "error"));
                deferred.push_back(frame);
                if close {
                    return Err(End::Remote);
                }
            }
        }
    };
    socket.set_nodelay(true).map_err(|_| End::Error)?;
    Ok(socket)
}

enum End {
    Remote,
    RemoteClosed,
    Close(&'static str),
    Rejected(&'static str),
    Error,
}

impl End {
    fn frame(self, reply: &Reply) -> Option<Frame> {
        match self {
            Self::Remote | Self::RemoteClosed => None,
            Self::Close(code) => Some(reply.control("close", &[("code", json!(code))])),
            Self::Rejected(code) => Some(reply.rejected(code)),
            Self::Error => Some(reply.control("error", &[("code", json!("connection-failed"))])),
        }
    }
}

struct StreamLog {
    logs: std::sync::Arc<crate::logging::Logs>,
    scope: Value,
    started: Instant,
}

impl StreamLog {
    fn new(link: &Link, header: &Value) -> Self {
        let mut scope = json!({
            "connectionScope":"logical-stream", "subsystem":"tunnel",
            "tunnelId":header["tunnelId"], "attachmentId":header["attachmentId"],
            "connectionId":header["connectionId"],
        });
        if let Some(trace) = header.get("diagnosticTraceId") {
            scope["diagnosticTraceId"] = trace.clone();
        }
        Self {
            logs: link.logs.clone(),
            scope,
            started: Instant::now(),
        }
    }

    fn context(&self, event: &str, operation: &str, status: &str) -> Value {
        let mut context = self.scope.clone();
        context["event"] = json!(event);
        context["operation"] = json!(operation);
        context["status"] = json!(status);
        context["durationMs"] = json!(self.started.elapsed().as_millis() as u64);
        context
    }

    fn event(&self, level: &str, event: &str, operation: &str, status: &str, message: &str) {
        self.logs
            .event(level, message, self.context(event, operation, status));
    }

    fn target_rejected(&self, error: &TargetError, mode: &Value) {
        let mut context = self.context(
            "tunnel.protected-target.rejected",
            "open-protected-target",
            "rejected",
        );
        context["reasonCode"] = json!(error.reason());
        context["mode"] = mode.clone();
        self.logs.repeated(
            format!(
                "tunnel-protected-target-rejected:{}:{}",
                context["tunnelId"].stringify(),
                error.reason()
            ),
            "warn",
            "Protected tunnel target rejected",
            context,
        );
    }

    fn finished(&self, end: &End) {
        let (event, operation, level, message, reason, code) = match end {
            End::Remote => return,
            End::RemoteClosed => (
                "remote-close-completed",
                "close",
                "debug",
                "Tunnel destination remote close completed",
                "normal",
                "normal",
            ),
            End::Close("normal") => (
                "closed",
                "connect",
                "debug",
                "Tunnel destination logical stream closed",
                "normal",
                "normal",
            ),
            End::Close(code) => (
                "closed-locally",
                "close",
                "warn",
                "Tunnel destination logical stream closed locally",
                *code,
                *code,
            ),
            End::Rejected(code) => (
                "failed",
                "connect",
                "warn",
                "Tunnel destination logical stream failed",
                "timeout",
                *code,
            ),
            End::Error => (
                "failed",
                "connect",
                "warn",
                "Tunnel destination logical stream failed",
                "connection-error",
                "connection-failed",
            ),
        };
        let event = format!("tunnel.destination.{event}");
        let status = if level == "warn" {
            "failed"
        } else {
            "completed"
        };
        let mut context = self.context(&event, operation, status);
        context["reasonCode"] = json!(reason);
        context["code"] = json!(code);
        if level == "warn" {
            self.logs
                .repeated(format!("{event}:{reason}"), level, message, context);
        } else {
            self.logs.event(level, message, context);
        }
    }
}

struct OutputStream {
    link: Link,
    capacity: watch::Receiver<()>,
    reply: Reply,
}

impl OutputStream {
    fn try_send(&mut self, frame: &Frame) -> Output {
        let result = self.link.send(frame);
        if matches!(result, Output::Queued) {
            self.reply.sequence += 1;
        }
        result
    }

    async fn send(&mut self, frame: Frame) -> bool {
        loop {
            match self.try_send(&frame) {
                Output::Queued => return true,
                Output::Closed => return false,
                Output::Pending => {
                    if self.capacity.changed().await.is_err() {
                        return false;
                    }
                }
            }
        }
    }
}

struct Stream {
    protection: Value,
    input_sequence: u64,
    destination_credit: usize,
    source_credit: usize,
    write_buffer: VecDeque<Zeroizing<Vec<u8>>>,
    write_offset: usize,
    write_bytes: usize,
    source_closed: bool,
    written_eof: bool,
    socket_eof: bool,
    sent_eof: bool,
}

impl Stream {
    fn new(destination_credit: usize, protection: Value) -> Self {
        Self {
            protection,
            input_sequence: 1,
            destination_credit,
            source_credit: 0,
            write_buffer: VecDeque::new(),
            write_offset: 0,
            write_bytes: 0,
            source_closed: false,
            written_eof: false,
            socket_eof: false,
            sent_eof: false,
        }
    }

    async fn run(
        mut self,
        socket: TcpStream,
        input: &mut mpsc::Receiver<Frame>,
        deferred: &mut VecDeque<Frame>,
        output: &mut OutputStream,
    ) -> End {
        let (mut reader, mut writer) = socket.into_split();
        let mut read_buffer = Zeroizing::new(vec![0; wire::MAX_PLAINTEXT_BYTES]);
        let mut unread = 0..0;
        let mut pending = None;
        loop {
            if pending.is_none() {
                match self.next_output(&output.reply, &read_buffer, &mut unread) {
                    Ok(frame) => pending = frame,
                    Err(end) => return end,
                }
            }
            if let Some(frame) = &pending {
                match output.try_send(frame) {
                    Output::Closed => return End::Remote,
                    Output::Pending => {}
                    Output::Queued => {
                        pending = None;
                        tokio::task::yield_now().await;
                        continue;
                    }
                }
            }
            if !self.written_eof && self.source_closed && self.write_buffer.is_empty() {
                if writer.shutdown().await.is_err() {
                    return End::Error;
                }
                self.written_eof = true;
            }
            if self.sent_eof && self.written_eof && pending.is_none() {
                return End::Close("normal");
            }
            tokio::select! {
                message = async {
                    match deferred.pop_front() {
                        Some(frame) => Some(frame),
                        None => input.recv().await,
                    }
                } => {
                    let Some(frame) = message else { return End::Remote };
                    let result = self.receive(&frame);
                    output.link.credit(&frame);
                    if let Err(end) = result {
                        return end;
                    }
                }
                change = output.capacity.changed(), if pending.is_some() => {
                    if change.is_err() {
                        return End::Remote;
                    }
                }
                read = reader.read(&mut read_buffer), if unread.is_empty() && !self.socket_eof && pending.is_none() => {
                    match read {
                        Ok(0) => self.socket_eof = true,
                        Ok(bytes) => unread = 0..bytes,
                        Err(_) => return End::Error,
                    }
                }
                ready = writer.writable(), if !self.write_buffer.is_empty() => {
                    if ready.is_err() || self.write(&writer).is_err() {
                        return End::Error;
                    }
                }
            }
        }
    }

    fn receive(&mut self, frame: &Frame) -> Result<(), End> {
        let header = frame.header();
        if header["sequence"].as_u64() != Some(self.input_sequence) {
            return Err(End::Close("protocol-error"));
        }
        self.input_sequence += 1;
        match header["kind"].as_str() {
            Some("data") => {
                let data = open_tunnel_data_frame(&self.protection, header, frame.payload())
                    .map_err(|_| End::Close("protocol-error"))?;
                if self.source_closed || self.write_bytes + data.len() > WRITE_BUFFER_LIMIT {
                    return Err(End::Close("congested"));
                }
                self.write_bytes += data.len();
                self.write_buffer.push_back(data);
            }
            Some("credit") => {
                self.destination_credit = (self.destination_credit
                    + header["bytes"].as_u64().unwrap() as usize)
                    .min(wire::MAX_CREDIT_BYTES);
            }
            Some("half-close") => self.source_closed = true,
            Some("close" | "error") => return Err(End::RemoteClosed),
            _ => unreachable!("tunnel attachment validates source frame kinds"),
        }
        Ok(())
    }

    fn write(&mut self, socket: &OwnedWriteHalf) -> std::io::Result<()> {
        let front = self.write_buffer.front().expect("pending TCP write");
        let written = match socket.try_write(&front[self.write_offset..]) {
            Ok(0) => return Err(ErrorKind::WriteZero.into()),
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error),
        };
        self.write_offset += written;
        self.write_bytes -= written;
        self.source_credit += written;
        if self.write_offset == front.len() {
            self.write_buffer.pop_front();
            self.write_offset = 0;
        }
        Ok(())
    }

    fn next_output(
        &mut self,
        reply: &Reply,
        buffer: &[u8],
        unread: &mut Range<usize>,
    ) -> Result<Option<Frame>, End> {
        if !Range::is_empty(unread) && self.destination_credit > 0 {
            let len = self.destination_credit.min(unread.len());
            let end = unread.start + len;
            let header = reply.header("data", &[("direction", json!(FROM_DESTINATION))]);
            let sealed =
                seal_tunnel_data_frame(&self.protection, &header, &buffer[unread.start..end])
                    .map_err(|_| End::Close("protocol-error"))?;
            let frame = wire::create(sealed.header, &sealed.payload)
                .map_err(|_| End::Close("protocol-error"))?;
            self.destination_credit -= len;
            unread.start = end;
            return Ok(Some(frame));
        }
        if self.source_credit > 0 {
            let bytes = self.source_credit.min(wire::MAX_CREDIT_BYTES);
            self.source_credit -= bytes;
            return Ok(Some(reply.control(
                "credit",
                &[("direction", json!(FROM_SOURCE)), ("bytes", json!(bytes))],
            )));
        }
        if self.socket_eof && Range::is_empty(unread) && !self.sent_eof {
            self.sent_eof = true;
            return Ok(Some(
                reply.control("half-close", &[("direction", json!(FROM_DESTINATION))]),
            ));
        }
        Ok(None)
    }
}
