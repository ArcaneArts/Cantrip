use super::*;
use crate::{
    computer_use::NativeError,
    connection::Outbound,
    desktop_inventory::DesktopInventory,
    encryption::{Identity, Service},
    http,
};
use std::{future::ready, os::unix::fs::PermissionsExt, path::PathBuf};
use tokio::{sync::watch, time::timeout};

const SERVER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

#[tokio::test]
#[ignore = "requires the local cantrip-cua executable in CANTRIP_TEST_RUST_CUA_BIN"]
async fn host_actions_use_the_live_attachment_and_authorize_each_native_operation() -> Result<()> {
    let binary = std::env::var_os("CANTRIP_TEST_RUST_CUA_BIN")
        .map(PathBuf::from)
        .expect("Set CANTRIP_TEST_RUST_CUA_BIN to the native helper executable.");
    let data = tempfile::tempdir()?;
    let path = data.path().join("helper");
    let quoted = binary.to_string_lossy().replace('\'', "'\\''");
    std::fs::write(
        &path,
        format!("#!/bin/sh\nexec '{quoted}' --backend fake\n"),
    )?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    let server_url = "https://server.test";
    let encryption = Service::new(
        Identity::open(data.path(), server_url, &"worker".into(), false)?,
        server_url,
        http::client()?,
    )?;
    let registration = encryption.registration();
    let at = "2026-11-16T00:00:00.000Z";
    encryption.accept_bootstrap(&json!({
        "serverId":SERVER,"ownerId":"owner",
        "principal":json!({"id":registration["principalId"],"ownerId":"owner","kind":"worker",
            "workerId":"worker","label":Value::Null,"publicKey":registration["publicKey"],
            "state":"approved","revision":1,"approvedAt":at,"revokedAt":Value::Null,
            "revokedReason":Value::Null,"createdAt":at,"updatedAt":at}),
        "grants":Vec::<Value>::new(),
    }))?;
    let outgoing = Arc::new(Outbound::default());
    outgoing.ready_for_test();
    let (stop, running) = watch::channel(false);
    let inventory = DesktopInventory::start(
        data.path(),
        data.path(),
        &cantrip_config::Environment::from([(
            "CANTRIP_CUA_BIN".into(),
            path.to_string_lossy().into(),
        )]),
        encryption.clone(),
        outgoing.clone(),
        running,
    );
    let authority = json!({
        "serverId":SERVER,"ownerId":"owner","workerId":"worker","chatId":"chat",
        "projectId":Value::Null,"contextKind":"standalone","placementId":"scratch",
        "executionLaneId":"lane","generation":7,"cantripAppAllowed":false,
        "profile":json!({"selectedId":":workspace","effectiveId":":workspace",
            "forcedByWorktreePolicy":false,"usesDefault":true}),
    });
    let (retire, turn) = Abort::new();
    let (_, request) = Abort::new();
    let mut javascript = Javascript::new(
        binary,
        vec!["--backend".into(), "fake".into()],
        json!({"sessionId":"evaluation","workerId":"worker","chatId":"chat",
            "threadId":"observed-thread","turnId":"observed-turn","taskId":Value::Null}),
        turn,
    )?;
    let epoch = *outgoing.stream_epoch().borrow();
    let host = inventory
        .previews()
        .bind_host(&authority, &javascript, epoch)?;
    let open = "await cua.attach({targetId:'fake-window', targetGeneration:1})";
    let denied = host
        .evaluate(
            &mut javascript,
            &open.into(),
            request.clone(),
            |action, _| {
                assert_eq!(action.operation, Some("target.attach"));
                assert_eq!(action.target["targetId"], "fake-window");
                ready(Err(HostError::new("permission-denied")))
            },
        )
        .await
        .err()
        .expect("permission must stop attach");
    assert_eq!(
        denied.downcast_ref::<NativeError>().unwrap().code(),
        "permission-denied"
    );

    let checks = Mutex::new(Vec::new());
    let authorize = |action: HostAction, signal: Signal| {
        assert!(signal.check().is_ok());
        checks
            .lock()
            .unwrap()
            .push((action.operation, action.target));
        ready(Ok(()))
    };
    let work = format!(
        "const targets = await cua.targets({{after:'fake-monitor'}}); {open}; \
        const image = await cua.snapshot(); \
        ({{id:targets.targets[0].id, imageIndex:image.imageIndex, bytes:image.payload ?? null}})"
    );
    let result = host
        .evaluate(&mut javascript, &work.into(), request.clone(), authorize)
        .await?;
    assert_eq!(
        result.value,
        json!({"id":"fake-window","imageIndex":0,"bytes":Value::Null})
    );
    let checks = checks.lock().unwrap();
    assert_eq!(
        checks
            .iter()
            .map(|(operation, _)| *operation)
            .collect::<Vec<_>>(),
        [
            Some("targets.list"),
            Some("target.attach"),
            Some("observation.snapshot")
        ]
    );
    assert_eq!(checks[2].1["targetGeneration"], 1);
    drop(checks);
    assert_eq!(result.images.len(), 1);
    let snapshot = &result.images[0];
    assert!(snapshot.pixels.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert_eq!(
        snapshot.metadata["session"]["binding"]["turnId"],
        "observed-turn"
    );
    assert_eq!(snapshot.metadata["image"]["width"], 320);

    let (cancel, pending_call) = Abort::new();
    let (submitted, observed) = oneshot::channel();
    let submitted = Mutex::new(Some(submitted));
    let pending_source = "await cua.snapshot()".into();
    let pending = host.evaluate(
        &mut javascript,
        &pending_source,
        pending_call,
        |action, signal| {
            assert_eq!(action.operation, Some("observation.snapshot"));
            let _ = submitted.lock().unwrap().take().unwrap().send(signal);
            std::future::pending()
        },
    );
    let cancel_approval = async {
        let signal = observed.await.unwrap();
        cancel.abort(anyhow::anyhow!("Fixture cancelled approval."));
        signal.cancelled().await;
    };
    let (pending, _) = timeout(Duration::from_secs(5), async {
        tokio::join!(pending, cancel_approval)
    })
    .await?;
    assert!(pending.is_err());
    let state = host
        .evaluate(
            &mut javascript,
            &"await cua.getState()".into(),
            request.clone(),
            |_, _| ready(Ok(())),
        )
        .await?;
    assert_eq!(state.value, json!({"session":Value::Null}));

    host.evaluate(&mut javascript, &open.into(), request.clone(), |_, _| {
        ready(Ok(()))
    })
    .await?;
    host.reset(&mut javascript).await?;
    let state = host
        .evaluate(
            &mut javascript,
            &"await cua.getState()".into(),
            request.clone(),
            |_, _| ready(Ok(())),
        )
        .await?;
    assert_eq!(state.value, json!({"session":Value::Null}));
    retire.abort(anyhow::anyhow!("Fixture retired the native turn."));
    assert!(
        host.evaluate(&mut javascript, &open.into(), request, |_, _| ready(Ok(())))
            .await
            .is_err()
    );
    stop.send_replace(true);
    inventory.close().await;
    encryption.close().await?;
    Ok(())
}
