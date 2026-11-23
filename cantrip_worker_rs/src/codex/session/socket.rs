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
    history: Hub,
    threads: ThreadVersions,
    generation: String,
    notification: Option<HistoryNotification>,
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
                Some(Ok(Message::Text(text)))=>observe(&requests, &history, &threads, &text, notification.as_ref(), &emit),
                Some(Ok(Message::Binary(bytes)))=>observe(&requests, &history, &threads, &String::from_utf8_lossy(&bytes), notification.as_ref(), &emit),
                Some(Ok(Message::Ping(bytes)))=>{let _=outgoing.send(Outgoing::Send(Message::Pong(bytes)));}
                Some(Ok(Message::Close(_)))|None=>break "Codex app-server WebSocket closed.".into(),
                Some(Err(error))=>break error.to_string().into(),
                _=>{},
            }
        }
    };
    closed.store(true, Ordering::Release);
    history.replace(None);
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
fn observe(
    requests: &Requests,
    history: &Hub,
    threads: &ThreadVersions,
    raw: &str,
    notification: Option<&HistoryNotification>,
    emit: &impl Fn(EventKind),
) {
    let Some(message) = rpc_protocol::parse_text(raw) else {
        requests.record(json!({"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"direction":"from-runtime","kind":"malformed","method":Value::Null,"payload":raw}),Some("Malformed App Server message".into()));
        return;
    };
    // The runtime owner handles these private admission/protection controls
    // before the general diagnostic pipeline, as in the current Node runtime.
    if message["method"] == rpc_protocol::RESOURCE_REQUESTED
        || rpc_protocol::is_private_inference(&message)
    {
        emit(EventKind::Message(message));
        return;
    }
    let payload = requests.diagnostic_payload(&message);
    requests.record(json!({"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"direction":"from-runtime","kind":"message","method":message.get("method").cloned().unwrap_or(Value::Null),"payload":payload}),None);
    if requests.handle_response(&message, &payload) {
        return;
    }
    // Capture before reading the next frame so a snapshot reply cannot
    // overtake earlier native notifications on the same connection.
    if message.get("id").is_none()
        && let Some(method) = message["method"].as_js_string()
        && message["params"].is_object()
    {
        if method.as_str() == Some("thread/closed")
            && let Some(thread) = message["params"]["threadId"].as_js_string()
        {
            threads.closed(thread.clone());
        }
        let params = &message["params"];
        let enriched = notification.and_then(|observe| observe(method, params));
        history.notification(
            method.clone(),
            enriched.as_ref().unwrap_or(params),
            message.get("historyCursor"),
        );
    }
    emit(EventKind::Message(message));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::live::observation::Observer;

    #[tokio::test]
    async fn history_observation_precedes_reply_without_waiting_for_the_event_consumer()
    -> Result<()> {
        let history = Hub::default();
        let threads = ThreadVersions::default();
        history.replace(Some("native-generation".into()));
        let (sent, mut wire) = mpsc::unbounded_channel();
        let requests = Requests::new(Ports {
            send: Arc::new(move |frame| Ok(sent.send(frame)?)),
            record: Arc::new(|_, _| {}),
            policy: Default::default(),
            runtime_id: None,
            logs: None,
        });
        let (captured, mut frames) = mpsc::unbounded_channel();
        let reader = requests.clone();
        let subscription = history.subscribe(
            "thread".into(),
            Observer {
                capture: Arc::new(move |frame| {
                    captured.send(frame)?;
                    Ok(None)
                }),
                on_error: Arc::new(|error, _| Err(error.error())),
            },
            Arc::new(move || {
                let request = reader.request("thread/read".into(), None, None, None);
                Box::pin(async move { request.await?.ok_or_else(|| anyhow!("Missing reply.")) })
            }),
        )?;
        let (send, mut events) = mpsc::unbounded_channel();
        let emit = |kind| send.send(kind).unwrap();
        observe(
            &requests,
            &history,
            &threads,
            r#"{"method":"turn/started","params":{"threadId":"thread"}}"#,
            None,
            &emit,
        );
        assert_eq!(frames.try_recv()?["sequence"], json!(1));
        let reading = subscription.read_snapshot();
        let request = wire.recv().await.unwrap();
        for raw in [
            r#"{"id":"native","method":"item/commandExecution/requestApproval","params":{"threadId":"thread"}}"#,
            r#"{"method":"thread/managedExecution/requested","params":{"threadId":"thread","trigger":"inference"}}"#,
            r#"{"method":"turn/completed","params":{"threadId":"thread"},"historyCursor":{"epoch":"epoch","sequence":"42","previousSequence":"41"}}"#,
        ] {
            observe(&requests, &history, &threads, raw, None, &emit);
        }
        let terminal = frames.try_recv()?;
        assert_eq!(terminal["method"], "turn/completed");
        assert_eq!(terminal["nativeCursor"]["sequence"], "42");
        assert!(frames.try_recv().is_err());
        let reply = format!(
            r#"{{"id":{},"result":{{"thread":{{"id":"thread","status":{{"type":"idle"}},"turns":[]}}}}}}"#,
            request["id"].stringify()
        );
        observe(&requests, &history, &threads, &reply, None, &emit);
        let observed = reading.await?;
        assert_eq!(observed["readBarrierSequence"], json!(1));
        assert_eq!(observed["completedSequence"], json!(2));
        assert_eq!(events.len(), 4);
        assert!(matches!(events.try_recv()?, EventKind::Message(_)));
        observe(
            &requests,
            &history,
            &threads,
            r#"{"method":"thread/closed","params":{"threadId":"thread"}}"#,
            None,
            &emit,
        );
        assert_eq!(threads.current(&"thread".into()), 1);
        assert_eq!(threads.current(&"other".into()), 0);
        Ok(())
    }
}
