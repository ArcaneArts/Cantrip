use super::*;
pub fn error(error: &anyhow::Error) -> Value {
    let mut value =
        json!({"ok":false,"kind":"error","message":cantrip_worker::error::message(error)});
    if let Some(error) = error.downcast_ref::<cantrip_worker::codex::rpc_requests::Failure>() {
        value["kind"] = json!(error.kind);
        if let Some(native) = &error.native_error {
            value["nativeError"] = native.clone();
        }
        if let Some(method) = &error.request_method {
            value["requestMethod"] = Value::String(method.clone());
        }
    }
    value
}
pub(super) async fn session(fixture: &mut Fixture, input: &Value) -> Result<Response> {
    let session = fixture
        .session
        .as_ref()
        .ok_or_else(|| anyhow!("No native session"))?;
    match input["op"].as_str().unwrap() {
        "session.initialize" => {
            session
                .initialize(
                    "cantrip_native_session_fixture",
                    "Cantrip Native Session Fixture",
                    "0.0.0",
                    true,
                )
                .await
        }
        "session.send" => {
            session.send(input["message"].clone())?;
            Ok(Some(Value::Null))
        }
        "session.close" => {
            session.close().await?;
            Ok(Some(Value::Null))
        }
        "session.status" => Ok(Some(
            json!({"pending":session.pending_count(),"generation":session.generation().is_some(),"processExited":session.process_exited()}),
        )),
        "session.event" => {
            let event = tokio::time::timeout(
                Duration::from_millis(input["timeoutMs"].as_u64().unwrap_or(1000)),
                fixture.observations.as_mut().unwrap().recv(),
            )
            .await?
            .ok_or_else(|| anyhow!("Session observations closed"))?;
            let belongs = fixture.generation.as_ref() == Some(&event.generation);
            Ok(Some(match event.kind {
                EventKind::Message(message) => {
                    json!({"kind":"message","message":message,"belongsToSession":belongs})
                }
                EventKind::TransportLost(message) => {
                    json!({"kind":"transportLost","message":message,"belongsToSession":belongs})
                }
                EventKind::ProcessExited(code) => {
                    json!({"kind":"processExited","code":code,"belongsToSession":belongs})
                }
            }))
        }
        _ => bail!("Unknown session fixture operation"),
    }
}

#[derive(Default)]
pub(super) struct Track {
    pub(super) frames: Vec<Value>,
    pub(super) diagnostics: Vec<Value>,
    pub(super) tickets: Vec<Value>,
}
pub(super) fn recorder(track: Arc<Mutex<Track>>) -> Record {
    Arc::new(move |diagnostic, warning| {
        track.lock().unwrap().diagnostics.push(json!({"kind":diagnostic["kind"],"method":diagnostic["method"],"payload":diagnostic["payload"],"warning":warning}));
    })
}
pub(super) struct Ticket {
    pub(super) name: JsString,
    pub(super) track: Arc<Mutex<Track>>,
    pub(super) fail: JsString,
}
impl Ticket {
    fn record(&self, state: &str) -> Result<()> {
        self.track
            .lock()
            .unwrap()
            .tickets
            .push(json!({"name":self.name,"state":state}));
        if self.fail.as_str() == Some(state) {
            bail!("controlled observer failure");
        }
        Ok(())
    }
}
impl Settlement for Ticket {
    fn replied(&self) -> Result<()> {
        self.record("replied")
    }
    fn not_sent(&self) -> Result<()> {
        self.record("notSent")
    }
}
