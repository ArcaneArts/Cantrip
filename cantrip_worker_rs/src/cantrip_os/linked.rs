//! Linked Host sources are mounted only on the admitted local Docker carrier.
use super::{
    assert_scope,
    carrier::DeliveryUnknown,
    carrier::Transport,
    checked,
    docker::LocalDocker,
    lock::InstanceLock,
    operations::{Journal, save},
    replacement::{self, Replacement},
    session::{Session, file_uri},
    status, text,
};
use crate::filesystem::{Scope, paths};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    io::{self, Write},
    path::PathBuf,
    time::Duration,
};
use tempfile::Builder;
use uuid::Uuid;

const CLIENT: &str = "cantrip-linked-source";

fn container(transport: &Transport) -> Result<&str> {
    match transport {
        Transport::Docker(name) => Ok(name),
        _ => bail!("Linked sources require the owning local Docker instance."),
    }
}

async fn host_path(scope: &Value) -> Result<PathBuf> {
    let path = scope["linkedWorkerPath"]
        .as_js_string()
        .context("Linked Host path")?;
    Ok(paths::canonical(&paths::native(path)).await?)
}

pub(super) async fn inspect(
    transport: &Transport,
    scope: &Value,
    lifetime: &Scope,
) -> Result<Value> {
    let engine = LocalDocker::current(lifetime).await?;
    let current = engine.record(container(transport)?, lifetime).await?;
    let mounts = replacement::bindings(&current, &scope["guestInstanceId"])?;
    let mount = mounts
        .iter()
        .find(|mount| mount["id"] == scope["bindingId"])
        .context("The intended Docker source mount is unavailable.")?;
    ensure!(
        mount["workerPath"].as_js_string() == Some(&paths::text(&host_path(scope).await?))
            && mount["guestPath"] == scope["guestPath"]
            && mount["dependencyOverlays"] == scope["dependencyOverlays"],
        "The intended Docker source mount is unavailable."
    );
    let pinned = Transport::Docker(text(&current, "Id")?.to_owned());
    let (mut session, _) = Session::open(&pinned, scope, CLIENT, lifetime).await?;
    let result = async {
        let metadata = session
            .request(
                "fs/getMetadata",
                json!({
                    "path":file_uri(text(scope, "guestPath")?)?.as_str(),"sandbox":Value::Null
                }),
            )
            .await?;
        ensure!(
            metadata["isDirectory"].as_bool() == Some(true),
            "The linked source is not a directory."
        );
        receipt(scope, &session.binding, false, &[], &[])
    }
    .await;
    session.close().await;
    result
}

fn receipt(
    scope: &Value,
    binding: &Value,
    recreated: bool,
    interrupted: &[JsString],
    warnings: &[&str],
) -> Result<Value> {
    checked(
        "cantripOsSourceReceiptSchema",
        json!({
            "bindingId":scope["bindingId"],"guestPath":scope["guestPath"],"workspaceId":scope["workspaceId"],
            "guestWorkspaceId":scope["guestWorkspaceId"],"mode":"linked","runtimeGeneration":binding["generation"],
            "uid":binding["uid"],"homeGuestPath":binding["home"],"recreated":recreated,
            "interruptedGuestWorkspaces":interrupted,"dependencyOverlays":scope["dependencyOverlays"],
            "cleanupWarnings":warnings,"head":Value::Null,"branch":Value::Null,"detached":false,
            "repositoryFingerprint":Value::Null,"gitCommonGuestPath":Value::Null,
        }),
    )
}

pub(super) async fn install(
    transport: &Transport,
    scope: &Value,
    id: &str,
    journal: &mut Journal<'_>,
    lifetime: &Scope,
) -> Result<Value> {
    let name = container(transport)?;
    let _lock = InstanceLock::acquire(name, lifetime).await?;
    let engine = LocalDocker::current(lifetime).await?;
    let original = engine.record(name, lifetime).await?;
    let original_id = text(&original, "Id")?;
    let pinned = Transport::Docker(original_id.to_owned());
    let before = assert_scope(&pinned, scope, true, lifetime).await?;
    Session::capture_binding(&pinned, scope, lifetime).await?;
    let root = host_path(scope).await?;
    let home = std::env::home_dir().context("Linked source Host home")?;
    ensure!(
        root.parent().is_some() && !paths::equal(&root, &paths::canonical(&home).await?),
        "A linked source must be a selected worktree directory outside the Host root or home itself."
    );
    ensure!(
        tokio::fs::metadata(&root).await?.is_dir(),
        "The selected worktree root is not a directory."
    );
    let instance = &scope["guestInstanceId"];
    let mut bindings = replacement::bindings(&original, instance)?;
    let new_mount = json!({
        "id":scope["bindingId"],
        "cacheKey":format!("{}:{}:{}",text(scope, "projectSourceId")?, text(scope, "worktreeId")?, text(scope, "workspaceId")?),
        "workerPath":paths::text(&root),"guestPath":scope["guestPath"],"dependencyOverlays":scope["dependencyOverlays"],
    });
    let recreate = match bindings
        .iter()
        .find(|mount| mount["id"] == scope["bindingId"])
    {
        Some(old) => {
            ensure!(
                old == &new_mount,
                "This binding has a different mount configuration."
            );
            false
        }
        None => {
            bindings.push(new_mount.clone());
            true
        }
    };
    if recreate {
        replacement::check_original(&original, name)?;
    }
    let mut probe = Builder::new()
        .prefix(".cantrip-os-link-")
        .tempfile_in(&root)?;
    let probe_name = probe
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .context("OS source probe name")?
        .to_owned();
    let mut docker_path = journal.path().as_os_str().to_owned();
    docker_path.push(".docker");
    let mut binding_path = docker_path.clone();
    binding_path.push(".binding");
    let binding_path = PathBuf::from(binding_path);
    let docker_path = PathBuf::from(docker_path);
    let mut outcome = json!({"version":1,"operationId":id,"bindingId":scope["bindingId"],
        "instanceId":instance,"ownerId":scope["ownerId"],"workerId":scope["workerId"],
        "probePath":paths::text(probe.path()),"state":"planned","cleanupWarnings":Vec::<Value>::new()});
    save(&binding_path, &outcome, true)?;
    let mut warnings = Vec::new();
    let verified = async {
        let from_host = Uuid::new_v4().to_string();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // These random probe bytes are intentionally shared so the same
            // verification works on native Linux with an independent guest UID.
            probe
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o666))?;
        }
        probe.write_all(from_host.as_bytes())?;
        probe.as_file().sync_all()?;
        let replacement = if recreate {
            let uid = scope["uid"].as_u64().context("OS workspace UID")?;
            replacement::initialize_caches(
                &engine,
                &original["Image"],
                instance,
                &new_mount,
                id,
                uid,
                lifetime,
            )
            .await?;
            Some(
                Replacement::start(
                    &engine,
                    name,
                    &original,
                    &bindings,
                    instance,
                    id,
                    &docker_path,
                    lifetime,
                )
                .await?,
            )
        } else {
            None
        };
        let candidate = replacement
            .as_ref()
            .map_or(Ok(original_id), Replacement::candidate_id)?;
        let selected = Transport::Docker(candidate.to_owned());
        let ready = ready(&selected, scope, lifetime).await?;
        let mut expected = scope.clone();
        expected["runtimeGeneration"] = ready["generation"].clone();
        let (mut session, session_id) =
            Session::open(&selected, &expected, CLIENT, lifetime).await?;
        let result = async {
            journal.bind(&session.binding, &session_id)?;
            verify(&mut session, scope, &root, &probe_name, &from_host).await?;
            let actual = engine.record(name, lifetime).await?;
            ensure!(
                actual["Id"] == candidate,
                "The verified OS container changed."
            );
            Ok::<_, anyhow::Error>(session.binding.clone())
        }
        .await;
        session.close().await;
        let binding = result?;
        if let Some(replacement) = replacement
            && replacement.finish(&engine, lifetime).await.is_err()
        {
            warnings.push("The previous container was retained because cleanup did not finish.");
        }
        Ok::<_, anyhow::Error>(binding)
    }
    .await;
    if probe.close().is_err() {
        warnings.push("The temporary Host verification file could not be removed.");
    }
    outcome["cleanupWarnings"] = json!(warnings);
    match verified {
        Ok(binding) => {
            let interrupted: Vec<_> = before["workspaces"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, workspace)| recreate && workspace["status"] == "running")
                .map(|(name, _)| name.clone())
                .collect();
            let result = receipt(scope, &binding, recreate, &interrupted, &warnings)?;
            outcome["state"] = json!("succeeded");
            outcome["receipt"] = json!({
                "bindingId":result["bindingId"],"guestPath":result["guestPath"],
                "runtimeGeneration":result["runtimeGeneration"],"workspaceId":binding["workspace_id"],
                "uid":result["uid"],"homeGuestPath":result["homeGuestPath"],
                "interruptedWorkspaces":result["interruptedGuestWorkspaces"],"dependencyOverlays":result["dependencyOverlays"],
                "recreated":result["recreated"],"cleanupWarnings":result["cleanupWarnings"],
            });
            save(&binding_path, &outcome, false).map_err(|_| {
                DeliveryUnknown(
                    "The source was verified but its outcome journal could not be saved.".into(),
                )
            })?;
            Ok(json!({"kind":"source","source":result}))
        }
        Err(error) => {
            outcome["state"] = json!(if error.is::<DeliveryUnknown>() {
                "unknown"
            } else {
                "failed"
            });
            outcome["error"] = json!(error.to_string());
            let _ = save(&binding_path, &outcome, false);
            Err(error)
        }
    }
}

async fn ready(transport: &Transport, scope: &Value, lifetime: &Scope) -> Result<Value> {
    let ready = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            lifetime.check()?;
            if let Ok(observed) = status(transport, lifetime).await {
                return Ok::<_, anyhow::Error>(observed);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("The replacement executor did not become ready.")??;
    ensure!(
        ready["instance_id"] == scope["guestInstanceId"]
            && ready["attachment"]["owner_id"] == scope["ownerId"]
            && ready["attachment"]["worker_id"] == scope["workerId"],
        "The replacement executor did not return the expected instance and attachment."
    );
    Ok(ready)
}

async fn verify(
    session: &mut Session<'_>,
    scope: &Value,
    root: &std::path::Path,
    name: &str,
    from_host: &str,
) -> Result<()> {
    let guest = text(scope, "guestPath")?;
    let uri = file_uri(&format!("{guest}/{name}"))?;
    let read = session
        .request(
            "fs/readFile",
            json!({"path":uri.as_str(),"sandbox":Value::Null}),
        )
        .await?;
    ensure!(
        STANDARD.decode(text(&read, "dataBase64")?)? == from_host.as_bytes(),
        "The mounted worktree did not return the actual Host file bytes."
    );
    let from_guest = Uuid::new_v4().to_string();
    let data = STANDARD.encode(&from_guest);
    session
        .request(
            "fs/writeFile",
            json!({"path":uri.as_str(),"dataBase64":data,"sandbox":Value::Null}),
        )
        .await?;
    ensure!(
        tokio::fs::read(root.join(name)).await? == from_guest.as_bytes(),
        "Guest edits did not reach the original Host worktree."
    );
    for overlay in scope["dependencyOverlays"]
        .as_array()
        .context("OS dependency overlays")?
    {
        let path = text(overlay, "path")?;
        let uri = file_uri(&format!("{guest}/{path}/{name}"))?;
        session
            .request(
                "fs/writeFile",
                json!({"path":uri.as_str(),"dataBase64":data,"sandbox":Value::Null}),
            )
            .await?;
        let observed = tokio::fs::metadata(root.join(path).join(name)).await;
        session
            .request(
                "fs/remove",
                json!({"path":uri.as_str(),"recursive":false,"force":false,"sandbox":Value::Null}),
            )
            .await?;
        match observed {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => bail!("Linux dependency writes reached Host dependencies."),
        }
    }
    Ok(())
}
