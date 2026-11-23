use super::*;
pub(super) async fn configure(fixture: &mut Fixture, input: &Value) -> Result<Option<Value>> {
    fixture.reset().await?;
    fixture.binary = PathBuf::from(input["binary"].as_str().unwrap());
    fixture.home = PathBuf::from(input["home"].as_str().unwrap());
    let mut options = Options::local(
        PathBuf::from(input["cwd"].as_str().unwrap()),
        std::env::vars().collect(),
    );
    options
        .environment
        .insert("PATH".into(), "/usr/bin:/bin".into());
    options.environment.insert(
        "CODEX_HOME".into(),
        fixture.home.to_string_lossy().into_owned(),
    );
    options.environment.insert(
        "CANTRIP_NATIVE_OWNER_FIXTURE".into(),
        input["config"].stringify(),
    );
    // Exercise role isolation: a keeper must not inherit a model's registration.
    for name in [
        "CANTRIP_INFERENCE_SCOPE",
        "CANTRIP_INFERENCE_GENERATION",
        "CANTRIP_INFERENCE_RUNTIME",
    ] {
        options
            .environment
            .insert(name.into(), "inherited-registration-must-be-cleared".into());
    }
    if let Some(ms) = input["ackTimeoutMs"].as_u64() {
        options.ack_timeout = Duration::from_millis(ms);
    }
    if let Some(ms) = input["journalTimeoutMs"].as_u64() {
        options.journal_timeout = Duration::from_millis(ms);
    }
    let trace = fixture.trace.clone();
    options.report = Arc::new(move |message| {
        trace.lock().unwrap().reports.push(message);
        Ok(())
    });
    let scope = &input["scope"];
    let generation = text(scope, "workerGeneration");
    let owner = Owner::new(
        fixture.binary.clone(),
        &PathBuf::from(input["data"].as_str().unwrap()),
        Scope {
            server_id: text(scope, "serverId"),
            owner_id: text(scope, "ownerId"),
            worker_id: text(scope, "workerId"),
            worker_generation: generation.clone(),
        },
        options,
    );
    let lost = fixture.lost.clone();
    owner.on_lost(Arc::new(move || {
        lost.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }));
    let port_owner = owner.clone();
    let fault = fixture.fault.clone();
    let trace = fixture.trace.clone();
    fixture.journal = Some(Journal::new(
        generation,
        Arc::new(move |command| {
            trace.lock().unwrap().calls.push(command.clone());
            let pending = port_owner.journal(command.clone());
            let fault = fault.clone();
            cantrip_transport::lifecycle::owned(async move {
                let mut result = pending.await?;
                driver::corrupt(&command, &mut result, &fault.lock().unwrap());
                Ok(result)
            })
        }),
    ));
    fixture.owner = Some(owner);
    Ok(Some(Value::Null))
}
