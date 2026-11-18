use super::*;
use crate::codex::{process_transport::Exit, rpc_protocol};
use futures::{SinkExt, StreamExt};
use tokio::sync::watch;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    mut receive: mpsc::UnboundedReceiver<Outgoing>,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    requests: Requests,
    closed: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    process: Arc<tokio::sync::Mutex<Option<Process>>>,
    mut exit: watch::Receiver<Option<Exit>>,
    events: mpsc::UnboundedSender<Event>,
    generation: String,
) {
    let (mut writer, mut reader) = socket.split();
    let (failed, mut failure) = tokio::sync::oneshot::channel();
    let mut write = tokio::spawn(async move {
        while let Some(message) = receive.recv().await {
            let result = match message {
                Outgoing::Send(message) => writer.send(message).await,
                Outgoing::Close => {
                    let _ = writer.close().await;
                    break;
                }
            };
            if let Err(error) = result {
                let _ = failed.send(JsString::from(error.to_string()));
                return;
            }
        }
    });
    let emit = |kind| {
        let _ = events.send(Event {
            generation: generation.clone(),
            kind,
        });
    };
    let mut process_exit = false;
    let lost = loop {
        if let Some(status) = *exit.borrow() {
            if !status.confirmed {
                break "Codex app-server process exit could not be confirmed.".into();
            }
            let code = status.code;
            process_exit = true;
            exited.store(true, Ordering::Release);
            emit(EventKind::ProcessExited(code));
            break JsString::from(format!("Codex app-server exited (code {code})."));
        }
        tokio::select! {
            changed=exit.changed()=>{if changed.is_err(){break "Codex app-server process observer closed.".into();}}
            error=&mut failure=>break error.unwrap_or_else(|_|"Codex app-server WebSocket closed.".into()),
            message=reader.next()=>match message {
                Some(Ok(Message::Text(text)))=>observe(&requests,&text, &emit),
                Some(Ok(Message::Binary(bytes)))=>observe(&requests,&String::from_utf8_lossy(&bytes), &emit),
                Some(Ok(Message::Ping(bytes)))=>{let _=outgoing.send(Outgoing::Send(Message::Pong(bytes)));}
                Some(Ok(Message::Close(_)))|None=>break "Codex app-server WebSocket closed.".into(),
                Some(Err(error))=>break error.to_string().into(),
                _=>{},
            }
        }
    };
    closed.store(true, Ordering::Release);
    requests.reject_all(lost.clone());
    emit(EventKind::TransportLost(lost));
    // Complete the native peer's close handshake before retiring the writer.
    // Dropping the socket here can turn its clean close into a broken pipe.
    let _ = outgoing.send(Outgoing::Close);
    if tokio::time::timeout(Duration::from_secs(2), &mut write)
        .await
        .is_err()
    {
        write.abort();
        let _ = write.await;
    }
    if !process_exit {
        if let Some(process) = process.lock().await.as_ref() {
            process.interrupt();
        }
        while exit.borrow().is_none() {
            if exit.changed().await.is_err() {
                break;
            }
        }
        if let Some(status) = *exit.borrow()
            && status.confirmed
        {
            let code = status.code;
            exited.store(true, Ordering::Release);
            emit(EventKind::ProcessExited(code));
        }
    }
}
fn observe(requests: &Requests, raw: &str, emit: &impl Fn(EventKind)) {
    let Some(message) = rpc_protocol::parse_text(raw) else {
        requests.record(json!({"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"direction":"from-runtime","kind":"malformed","method":Value::Null,"payload":raw}),Some("Malformed App Server message".into()));
        return;
    };
    // The runtime owner handles these private admission/protection controls
    // before the general diagnostic pipeline, as in the current Node runtime.
    if message["method"] == "thread/nativeResources/requested"
        || rpc_protocol::is_private_inference(&message)
    {
        emit(EventKind::Message(message));
        return;
    }
    let payload = requests.diagnostic_payload(&message);
    requests.record(json!({"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"direction":"from-runtime","kind":"message","method":message.get("method").cloned().unwrap_or(Value::Null),"payload":payload}),None);
    if !requests.handle_response(&message, &payload) {
        emit(EventKind::Message(message));
    }
}
