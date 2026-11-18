use super::*;
pub fn corrupt(command: &Value, result: &mut Option<Value>, fault: &str) {
    let Some(result) = result else {
        return;
    };
    if command["action"] == "snapshot" && fault == "snapshot-extra" {
        result["unexpected"] = json!(true);
    }
    if command["action"] == "batch" {
        if fault == "uncorrelated" {
            *result = Value::Array(Vec::new());
            return;
        }
        let Value::Array(items) = result else {
            return;
        };
        let Some(first) = items.first_mut() else {
            return;
        };
        match fault {
            "entry-failure" => first["ok"] = json!(false),
            "wrong-key" => first["result"]["key"] = json!("f".repeat(64)),
            "wrong-worker" => {
                first["result"]["workerGeneration"] = json!("00000000-0000-4000-8000-000000000999")
            }
            "wrong-transition" => first["result"]["state"] = json!("waiting"),
            "wrong-identity" => {
                first["result"]["identity"]["operationId"] = json!("another-operation")
            }
            _ => {}
        }
    }
}
pub(super) async fn session(fixture: &mut Fixture, input: &Value) -> Result<Option<Value>> {
    match input["op"].as_str().unwrap() {
        "runtime.open" => {
            let registration = fixture
                .owner
                .as_ref()
                .unwrap()
                .prepare(text(input, "runtime"))
                .await?;
            let mut options =
                process_transport::Options::local(fixture.home.clone(), std::env::vars().collect());
            options.environment.extend(registration);
            options.environment.insert(
                "CODEX_HOME".into(),
                fixture.home.to_string_lossy().into_owned(),
            );
            options
                .environment
                .insert("PATH".into(), "/usr/bin:/bin".into());
            let (session, events) = Session::launch(
                fixture.binary.clone(),
                vec![
                    "app-server".into(),
                    "--listen".into(),
                    "ws://127.0.0.1:0".into(),
                ],
                options,
            )
            .await?;
            session
                .initialize(
                    "cantrip_inference_fixture",
                    "Cantrip Inference Fixture",
                    "0.0.0",
                    true,
                )
                .await?;
            fixture.session = Some(session);
            fixture.events = Some(events);
            Ok(Some(Value::Null))
        }
        "runtime.status" => {
            let session = fixture.session.as_ref().unwrap();
            Ok(Some(
                json!({"connected":session.generation().is_some(),"processExited":session.process_exited()}),
            ))
        }
        "runtime.exit" => {
            loop {
                let event = tokio::time::timeout(
                    Duration::from_secs(5),
                    fixture.events.as_mut().unwrap().recv(),
                )
                .await?
                .ok_or_else(|| anyhow!("runtime observer closed"))?;
                if let cantrip_worker::codex::session::EventKind::ProcessExited(_) = event.kind {
                    break;
                }
            }
            fixture.session.as_ref().unwrap().close().await?;
            Ok(Some(json!({"processExited":true})))
        }
        _ => bail!("Unknown inference fixture operation"),
    }
}
