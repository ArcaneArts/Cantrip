use super::*;
use crate::{
    computer_use::NativeError,
    connection::Outbound,
    desktop_inventory::DesktopInventory,
    encryption::{Identity, Service},
    http,
};
use std::{
    future::ready,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
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
    let (inventory, encryption, outgoing, stop) = inventory(data.path(), &path, "owner")?;
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
        .bind_turn(&authority, &javascript, epoch)?;
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

fn inventory(
    data: &Path,
    host: &Path,
    owner: &str,
) -> Result<(
    DesktopInventory,
    Arc<Service>,
    Arc<Outbound>,
    watch::Sender<bool>,
)> {
    let server_url = "https://server.test";
    let encryption = Service::new(
        Identity::open(data, server_url, &"worker".into(), false)?,
        server_url,
        http::client()?,
    )?;
    let registration = encryption.registration();
    let at = "2026-11-16T00:00:00.000Z";
    encryption.accept_bootstrap(&json!({
        "serverId":SERVER,"ownerId":owner,
        "principal":json!({"id":registration["principalId"],"ownerId":owner,"kind":"worker",
            "workerId":"worker","label":Value::Null,"publicKey":registration["publicKey"],
            "state":"approved","revision":1,"approvedAt":at,"revokedAt":Value::Null,
            "revokedReason":Value::Null,"createdAt":at,"updatedAt":at}),
        "grants":Vec::<Value>::new(),
    }))?;
    let outgoing = Arc::new(Outbound::default());
    outgoing.ready_for_test();
    let (stop, running) = watch::channel(false);
    let inventory = DesktopInventory::start(
        data,
        data,
        &cantrip_config::Environment::from([(
            "CANTRIP_CUA_BIN".into(),
            host.to_string_lossy().into(),
        )]),
        encryption.clone(),
        outgoing.clone(),
        running,
    );
    Ok((inventory, encryption, outgoing, stop))
}

struct Guest(String);

impl Guest {
    async fn command(&self, args: &[&str]) -> Result<Value> {
        let prefix = ["exec", "--user", "0", &self.0];
        let raw = docker(&[&prefix[..], args].concat()).await?;
        cantrip_wire::parse_json_text(&raw)
            .map_err(|_| anyhow::anyhow!("Invalid guest fixture JSON."))
    }

    async fn connections(&self) -> Result<Value> {
        Ok(self.command(&["cantrip-remote", "status"]).await?["connections"].clone())
    }
}

impl Drop for Guest {
    fn drop(&mut self) {
        let _ = std::process::Command::new("docker")
            .args(["rm", "--force", &self.0])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

async fn docker(arguments: &[&str]) -> Result<String> {
    let output = timeout(
        Duration::from_secs(45),
        tokio::process::Command::new("docker")
            .args(arguments)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "Docker fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

#[tokio::test]
#[ignore = "requires the local cantrip-cua executable and an existing CANTRIP_TEST_CUA_GUEST_IMAGE"]
async fn guest_actions_use_the_assigned_carrier_for_distinct_turn_sessions() -> Result<()> {
    const OWNER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let helper = PathBuf::from(
        std::env::var_os("CANTRIP_TEST_RUST_CUA_BIN").expect("Native CUA helper path"),
    );
    let image = std::env::var("CANTRIP_TEST_CUA_GUEST_IMAGE")?;
    let guest = Guest(format!("cantrip-agent-guest-test-{}", uuid::Uuid::new_v4()));
    let container = docker(&[
        "run",
        "-d",
        "--rm",
        "--pull=never",
        "--network=none",
        "--shm-size=256m",
        "--name",
        &guest.0,
        &image,
    ])
    .await?;
    let status = timeout(Duration::from_secs(35), async {
        loop {
            if let Ok(status) = guest.command(&["cantrip-executor", "status"]).await
                && status["service"] == "running"
            {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await?;
    assert!(status["attachment"].is_null());
    docker(&[
        "exec",
        "--user",
        "0",
        &guest.0,
        "cantrip-executor",
        "attach",
        OWNER,
        "worker",
    ])
    .await?;
    let workspace = guest
        .command(&["cantrip-workspaces", "create", "agent-check"])
        .await?;
    docker(&["exec", "--user", "0", &guest.0, "cantrip-remote", "enable"]).await?;
    let id = || uuid::Uuid::new_v4().to_string();
    let scope = json!({
        "ownerId":OWNER,"workerId":"worker","instanceId":id(),"guestInstanceId":status["instance_id"],
        "attachmentGeneration":id(),"runtimeGeneration":status["generation"],"bindingId":id(),"bindingGeneration":id(),
        "projectId":id(),"projectSourceId":id(),"sourceKind":"folder","worktreeId":id(),"workspaceId":id(),
        "guestWorkspaceId":workspace["id"],"uid":workspace["uid"],"gid":workspace["gid"],"homeGuestPath":workspace["home"],
        "guestPath":format!("{}/checkout", workspace["home"].as_str().unwrap()),
        "dependencyOverlays":Vec::<Value>::new(),"mode":"linux-owned","linkedWorkerPath":Value::Null,
    });
    let placement = Value::object(
        [
            "instanceId",
            "guestInstanceId",
            "attachmentGeneration",
            "runtimeGeneration",
            "bindingId",
            "bindingGeneration",
            "projectSourceId",
            "worktreeId",
            "workspaceId",
            "guestWorkspaceId",
        ]
        .into_iter()
        .map(|key| (key, scope[key].clone())),
    );
    let execution = json!({"kind":"cantrip-os","transport":json!({"kind":"docker","container":container}),"scope":scope});
    let data = tempfile::tempdir()?;
    let (inventory, encryption, outgoing, stop) = inventory(
        data.path(),
        &data.path().join("host-helper-unavailable"),
        OWNER,
    )?;
    let epoch = *outgoing.stream_epoch().borrow();
    let desktop = inventory.previews();
    let authority = |chat: &JsString| {
        json!({
            "serverId":SERVER,"ownerId":OWNER,"workerId":"worker","chatId":chat,
            "contextKind":"project","projectId":scope["projectId"],"placementId":scope["worktreeId"],
            "executionLaneId":id(),"generation":1,"cantripAppAllowed":false,"osPlacement":placement,
            "profile":json!({"selectedId":":workspace","effectiveId":":workspace","forcedByWorktreePolicy":false,"usesDefault":true}),
        })
    };
    let prepare = |chat: JsString| -> Result<_> {
        let authority = authority(&chat);
        let file = crate::codex::guest_environment::record_path(data.path(), &authority, &chat);
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(&file, execution.stringify())?;
        let (abort, signal) = Abort::new();
        let js = Javascript::new(
            helper.clone(),
            vec!["--backend".into(), "fake".into()],
            json!({
                "sessionId":id(),"workerId":"worker","chatId":chat,"taskId":Value::Null,
                "threadId":id(),"turnId":id(),
            }),
            signal,
        )?;
        let mut stale = authority.clone();
        stale["osPlacement"]["runtimeGeneration"] = json!(id());
        assert!(desktop.bind_turn(&stale, &js, epoch).is_err());
        let mut host = authority.clone();
        host["osPlacement"] = Value::Null;
        assert!(desktop.bind_turn(&host, &js, epoch).is_err());
        let turn = desktop.bind_turn(&authority, &js, epoch)?;
        Ok((abort, turn, js))
    };
    let (_first_abort, first, mut first_js) = prepare("first-agent-chat".into())?;
    let (_second_abort, second, mut second_js) = prepare("second-agent-chat".into())?;
    let (_, request) = Abort::new();
    let allow = |_: HostAction, _: Signal| ready(Ok(()));
    let attach = "const monitor = (await cua.targets()).targets.find(t => t.kind === 'monitor'); \
        await cua.attach({targetId: monitor.id, targetGeneration: monitor.generation});";
    let script =
        format!("{attach} await cua.writeClipboard('guest Rust fixture'); await cua.snapshot()");
    let image = first
        .evaluate(&mut first_js, &script.into(), request.clone(), allow)
        .await?;
    assert_eq!(image.images.len(), 1);
    assert!(image.images[0].pixels.starts_with(b"\x89PNG\r\n\x1a\n"));
    let first_binding = &image.images[0].metadata["session"]["binding"];
    assert_eq!(first_binding["turnId"], first_js.binding()["turnId"]);
    let script = format!(
        "{attach} ({{session:(await cua.getState()).session, clipboard:await cua.readClipboard()}})"
    );
    let state = second
        .evaluate(&mut second_js, &script.into(), request.clone(), allow)
        .await?;
    assert_eq!(state.value["clipboard"], "guest Rust fixture");
    assert_ne!(
        state.value["session"]["binding"]["sessionId"],
        first_binding["sessionId"]
    );
    assert_eq!(guest.connections().await?.as_object().unwrap().len(), 1);

    first.reset(&mut first_js).await?;
    let state = second
        .evaluate(
            &mut second_js,
            &"await cua.getState()".into(),
            request,
            allow,
        )
        .await?;
    assert_eq!(
        state.value["session"]["binding"]["turnId"],
        second_js.binding()["turnId"]
    );
    assert_eq!(guest.connections().await?.as_object().unwrap().len(), 1);
    stop.send_replace(true);
    timeout(Duration::from_secs(25), inventory.close()).await?;
    assert!(guest.connections().await?.as_object().unwrap().is_empty());
    encryption.close().await?;
    Ok(())
}
