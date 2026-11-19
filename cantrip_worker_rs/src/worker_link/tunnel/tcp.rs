//! A logical TCP stream with independent nested credit and TCP half-closes.
use super::{
    Carrier, Destination, FROM_DESTINATION, FROM_SOURCE, Frame, Link, Output, Reply, Stop,
    TargetError, wire,
};
use cantrip_crypto::content::{open_tunnel_data_frame, seal_tunnel_data_frame};
use cantrip_wire::{Value, value::json};
use std::{collections::VecDeque, ops::Range, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, duplex},
    net::TcpStream,
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
    request: Value,
    mut input: mpsc::Receiver<Frame>,
    mut stopped: watch::Receiver<Option<Stop>>,
) {
    let mut output = OutputStream {
        link,
        capacity,
        stopped: stopped.clone(),
        reply: Reply::new(&request),
    };
    if !output.link.active() {
        return;
    }
    let log = StreamLog::new(&output.link, &request);
    let end = tokio::select! {
        biased;
        _ = stopped.changed() => {
            match *stopped.borrow() {
                Some(Stop::RemoteClosed) => End::RemoteClosed,
                Some(Stop::Protocol) => End::Close("protocol-error"),
                Some(Stop::Congested) => End::Close("congested"),
                None => End::Remote,
            }
        },
        end = serve_socket(&request, &mut input, &mut output, &log) => end,
    };
    log.finished(&end);
    // After logical retirement the attachment still owns the outer credit.
    // Closing the receiver first prevents producers from adding to this drain.
    input.close();
    let mut returned = 0;
    while let Ok(frame) = input.try_recv() {
        returned += frame.bytes().len();
    }
    output.link.credit_bytes(returned);
    if let Some(frame) = end.frame(&output.reply) {
        output.send(frame).await;
    }
}

async fn serve_socket(
    request: &Value,
    input: &mut mpsc::Receiver<Frame>,
    output: &mut OutputStream,
    log: &StreamLog,
) -> End {
    let Some(gateway) = output.link.gateway.upgrade() else {
        return End::Remote;
    };
    if let Carrier::Direct(pipe) = &output.link.carrier
        && let Some(terminal) = pipe.upgrade().and_then(|pipe| pipe.terminal())
    {
        if terminal.claimed() {
            return End::Error;
        }
        let Some(adapter) = gateway.terminals.get().cloned() else {
            return End::Rejected("target-unavailable");
        };
        drop(gateway);
        let (socket, endpoint) = duplex(64 * 1024);
        let transport = connected(socket, None, request, input, output, log);
        tokio::pin!(transport);
        return tokio::select! {
            end = &mut transport => end,
            () = adapter.serve_direct(&terminal, endpoint) => transport.await,
        };
    }
    let destination = Destination::open(&gateway, request).await;
    drop(gateway);
    if !output.link.active() {
        return End::Remote;
    }
    let destination = match destination {
        Ok(destination) => destination,
        Err(error) => {
            log.target_rejected(&error, &request["target"]["targetKind"]);
            return End::Rejected(error.code());
        }
    };
    log.event(
        "debug",
        "tunnel.destination.opening",
        "connect",
        "started",
        "Tunnel destination logical stream opening",
    );
    let socket = match connect(&destination).await {
        Ok(socket) => socket,
        Err(end) => return end,
    };
    connected(
        socket,
        Some(destination.protection),
        request,
        input,
        output,
        log,
    )
    .await
}

async fn connected(
    socket: impl AsyncRead + AsyncWrite + Unpin,
    protection: Option<Value>,
    request: &Value,
    input: &mut mpsc::Receiver<Frame>,
    output: &mut OutputStream,
    log: &StreamLog,
) -> End {
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
        let initial = request["initialCreditBytes"].as_u64().unwrap() as usize;
        Stream::new(initial, protection, output.link.frame_limit)
            .run(socket, input, output)
            .await
    } else {
        End::Remote
    }
}

async fn connect(destination: &Destination) -> Result<TcpStream, End> {
    let addresses = destination.addresses();
    let socket = match timeout(CONNECT_TIMEOUT, TcpStream::connect(addresses.as_slice())).await {
        Ok(Ok(socket)) => socket,
        Ok(Err(_)) => return Err(End::Error),
        Err(_) => return Err(End::Rejected("target-unavailable")),
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
            End::Rejected(code @ "target-unavailable") => (
                "failed",
                "connect",
                "warn",
                "Tunnel destination logical stream failed",
                "timeout",
                *code,
            ),
            End::Rejected(_) => return,
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
    stopped: watch::Receiver<Option<Stop>>,
    reply: Reply,
}

impl OutputStream {
    fn try_send(&mut self, frame: &Frame) -> Output {
        let result = self.link.send(frame, &self.stopped);
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
    protection: Option<Value>,
    frame_limit: Option<usize>,
    chunk_limit: usize,
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
    fn new(
        destination_credit: usize,
        protection: Option<Value>,
        frame_limit: Option<usize>,
    ) -> Self {
        Self {
            protection,
            frame_limit,
            chunk_limit: wire::MAX_PLAINTEXT_BYTES,
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
        socket: impl AsyncRead + AsyncWrite + Unpin,
        input: &mut mpsc::Receiver<Frame>,
        output: &mut OutputStream,
    ) -> End {
        let (mut reader, mut writer) = tokio::io::split(socket);
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
                message = input.recv() => {
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
                written = async {
                    let front = self.write_buffer.front().expect("pending TCP write");
                    writer.write(&front[self.write_offset..]).await
                }, if !self.write_buffer.is_empty() => {
                    match written {
                        Ok(bytes) if bytes > 0 => self.written(bytes),
                        _ => return End::Error,
                    }
                }
            }
        }
    }

    fn receive(&mut self, frame: &Frame) -> Result<(), End> {
        let header = frame.header();
        match header["kind"].as_str() {
            Some("data") => {
                let data = match &self.protection {
                    Some(protection) => open_tunnel_data_frame(protection, header, frame.payload())
                        .map_err(|_| End::Close("protocol-error"))?,
                    // The legacy terminal WebSocket protects the PTY payload
                    // inside its own JSON messages. CTTN carries its bytes as-is.
                    None if header.get("protection").is_none() => {
                        Zeroizing::new(frame.payload().to_vec())
                    }
                    None => return Err(End::Close("protocol-error")),
                };
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
            _ => unreachable!("tunnel attachment validates source frame kinds"),
        }
        Ok(())
    }

    fn written(&mut self, written: usize) {
        let front = self.write_buffer.front().expect("pending TCP write");
        self.write_offset += written;
        self.write_bytes -= written;
        self.source_credit += written;
        if self.write_offset == front.len() {
            self.write_buffer.pop_front();
            self.write_offset = 0;
        }
    }

    fn next_output(
        &mut self,
        reply: &Reply,
        buffer: &[u8],
        unread: &mut Range<usize>,
    ) -> Result<Option<Frame>, End> {
        if !Range::is_empty(unread) && self.destination_credit > 0 {
            let mut len = self
                .destination_credit
                .min(unread.len())
                .min(self.chunk_limit);
            let header = reply.header("data", &[("direction", json!(FROM_DESTINATION))]);
            let mut frame = self.encode_data(&header, &buffer[unread.start..unread.start + len])?;
            if let Some(limit) = self
                .frame_limit
                .filter(|&limit| frame.bytes().len() > limit)
            {
                // Measure the encoded CTTN header and tag. Only the fitting
                // frame is emitted and charged against the stream's credit.
                let overhead = frame.bytes().len() - len;
                len = limit
                    .checked_sub(overhead)
                    .filter(|&len| len > 0)
                    .ok_or(End::Close("congested"))?;
                self.chunk_limit = len;
                frame = self.encode_data(&header, &buffer[unread.start..unread.start + len])?;
            }
            self.destination_credit -= len;
            unread.start += len;
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

    fn encode_data(&self, header: &Value, payload: &[u8]) -> Result<Frame, End> {
        if let Some(protection) = &self.protection {
            let sealed = seal_tunnel_data_frame(protection, header, payload)
                .map_err(|_| End::Close("protocol-error"))?;
            wire::create(sealed.header, &sealed.payload)
        } else {
            wire::create(header.clone(), payload)
        }
        .map_err(|_| End::Close("protocol-error"))
    }
}
