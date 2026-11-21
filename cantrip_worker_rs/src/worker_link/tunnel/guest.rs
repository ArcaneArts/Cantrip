//! A guest service is admitted by the installed Core grant, then opened against
//! the captured guest workspace and service generation.
use super::super::{Coordinator, Grant, State, expiration, hex_digest, timestamp};
use crate::{
    cantrip_os::carrier::Transport,
    desktop_inventory::preview::{Previews, VncDesktop},
    filesystem::Scope,
    http::checked,
    protected_content::open_tunnel_record,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{Value, value::json};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, duplex},
    process::{Child, Command},
    sync::{oneshot, watch},
    time::timeout,
};
use uuid::Uuid;

pub(crate) const PREPARE: &str = "surface.tunnel.os-prepare";
const READY: Duration = Duration::from_secs(35);
const PLACEMENT: [(&str, &str); 8] = [
    ("instance_id", "guestInstanceId"),
    ("generation", "runtimeGeneration"),
    ("owner_id", "ownerId"),
    ("worker_id", "workerId"),
    ("workspace_id", "guestWorkspaceId"),
    ("uid", "uid"),
    ("gid", "gid"),
    ("home", "homeGuestPath"),
];

#[derive(Default)]
pub(in crate::worker_link) struct Slot {
    pending: Option<(Uuid, watch::Sender<bool>)>,
    installed: Option<Installed>,
}

struct Installed {
    preparation: Arc<Preparation>,
    _lifetime: watch::Sender<bool>,
}

pub(in crate::worker_link) struct Preparation {
    pub(super) record: Value,
    transport: Transport,
    descriptor: Value,
    vnc: Option<VncDesktop>,
    expires: i64,
    epoch: u64,
    scope: Scope,
}

pub(super) struct Stream {
    pub(super) socket: DuplexStream,
    pub(super) fault: oneshot::Receiver<()>,
    // Dropping the WorkerLink stream cancels the owned guest carrier.
    pub(super) _lifetime: oneshot::Sender<()>,
}

impl Slot {
    fn retire(&mut self) -> bool {
        std::mem::take(self).installed.is_some()
    }

    pub(in crate::worker_link) fn opened(&self) -> Option<Arc<Preparation>> {
        self.installed
            .as_ref()
            .map(|entry| entry.preparation.clone())
    }
}

impl Preparation {
    pub(super) fn current(&self, coordinator: &Coordinator) -> bool {
        self.scope.check().is_ok()
            && self.expires > Utc::now().timestamp_millis()
            && coordinator.outgoing.stream_current(self.epoch)
    }
}

fn matching(grant: &Grant, command: &Value, now: i64) -> bool {
    let binding = &grant.value["binding"];
    let resource = &binding["resource"];
    binding["grantId"] == command["grantId"]
        && resource["kind"] == "tunnel"
        && resource["resourceId"] == command["tunnelId"]
        && resource["attachmentId"] == command["attachmentId"]
        && expiration(&binding["lease"]).is_ok_and(|expires| expires > now)
        && binding["lease"]["absoluteExpiresAt"] == command["expiresAt"]
        && binding["operations"].as_array().is_some_and(|operations| {
            operations.contains(&json!("stream:guest-connect"))
                && !operations.contains(&json!("stream:guest-listen"))
        })
}

fn grants(state: &mut State) -> impl Iterator<Item = &mut Grant> {
    state
        .sessions
        .values_mut()
        .flat_map(|session| session.grants.values_mut())
}

impl State {
    pub(in crate::worker_link) fn retire_guest_tunnels(
        &mut self,
        attachment: Option<&Value>,
        reason: &str,
    ) {
        let mut retired = Vec::new();
        for (session, installed) in &mut self.sessions {
            for (grant, current) in &mut installed.grants {
                let resource = &current.value["binding"]["resource"];
                if resource["kind"] == "tunnel"
                    && attachment.is_none_or(|attachment| resource["attachmentId"] == *attachment)
                    && current.guest.retire()
                {
                    retired.push((session.clone(), grant.clone()));
                }
            }
        }
        for (session, grant) in retired {
            self.channels.close_grant(&session, &grant, reason);
        }
    }
}

impl Coordinator {
    pub(crate) async fn prepare_guest_tunnel(
        &self,
        command: &Value,
        epoch: u64,
        previews: &Previews,
    ) -> Result<Value> {
        let placement = &command["osExecution"]["scope"];
        let (owner, server) = self.encryption.bound_identity()?;
        let now = Utc::now().timestamp_millis();
        let expires = timestamp(command, "expiresAt")?;
        ensure!(
            self.outgoing.stream_current(epoch)
                && command["serverId"] == server
                && placement["ownerId"].as_js_string() == Some(&owner)
                && placement["workerId"].as_js_string() == Some(&self.worker)
                && placement["projectId"] == command["projectId"]
                && expires > now,
            "The OS tunnel preparation does not match this Worker authority."
        );
        let (token, scope) = {
            let mut state = self.state.lock().unwrap();
            state.sweep(now, Some(&(owner, server)));
            ensure!(
                state.transport_ready
                    && grants(&mut state).any(|grant| matching(grant, command, now)),
                "The guest tunnel grant has no matching Server preparation."
            );
            let token = Uuid::new_v4();
            let (stop, receiver) = watch::channel(false);
            let mut pending = Some(stop);
            for grant in grants(&mut state).filter(|grant| {
                grant.value["binding"]["resource"]["attachmentId"] == command["attachmentId"]
            }) {
                grant.guest.pending = if matching(grant, command, now) {
                    pending.take().map(|stop| (token, stop))
                } else {
                    None
                };
            }
            (token, Scope::with_stop(receiver))
        };
        let observed = self.observe_guest_tunnel(command, &scope, previews).await;
        let mut state = self.state.lock().unwrap();
        let now = Utc::now().timestamp_millis();
        let identity = self.encryption.bound_identity();
        state.sweep(now, identity.as_ref().ok());
        let grant = grants(&mut state)
            .find(|grant| {
                matching(grant, command, now)
                    && grant
                        .guest
                        .pending
                        .as_ref()
                        .is_some_and(|pending| pending.0 == token)
            })
            .context("The OS tunnel preparation was retired.")?;
        let (_, lifetime) = grant.guest.pending.take().unwrap();
        ensure!(
            self.outgoing.stream_current(epoch) && expires > now,
            "The OS tunnel preparation was retired."
        );
        let (transport, descriptor, vnc) = observed?;
        let identity = hex_digest(&Sha256::digest(descriptor.stringify()));
        ensure!(
            command["expectedIdentity"].is_null() || command["expectedIdentity"] == identity,
            "The captured guest service is retired. Stop and explicitly start a new forward."
        );
        let mut result = json!({"identity":identity});
        if descriptor["service"]["kind"] == "ssh" {
            result["ssh"] = json!({
                "user": descriptor["user"],
                "hostAlias": format!("cantrip-os-{}", descriptor["instance_id"].as_str().unwrap()),
                "hostKey": descriptor["ssh_host_key"],
            });
        }
        let result = checked("tunnelOsPrepareResultSchema", &result)?;
        state.retire_guest_tunnels(Some(&command["attachmentId"]), "route-replaced");
        grants(&mut state)
            .find(|grant| matching(grant, command, now))
            .unwrap()
            .guest
            .installed = Some(Installed {
            preparation: Arc::new(Preparation {
                record: command["protectedRecord"].clone(),
                transport,
                descriptor,
                vnc,
                expires,
                epoch,
                scope,
            }),
            _lifetime: lifetime,
        });
        Ok(result)
    }

    async fn observe_guest_tunnel(
        &self,
        command: &Value,
        scope: &Scope,
        previews: &Previews,
    ) -> Result<(Transport, Value, Option<VncDesktop>)> {
        let content = open_tunnel_record(
            &self.encryption,
            &command["tunnelId"],
            &command["protectedRecord"],
        )?;
        let destination = &content["destination"];
        let scope_value = &command["osExecution"]["scope"];
        let source = Value::object(
            [
                "bindingId",
                "worktreeId",
                "bindingGeneration",
                "attachmentGeneration",
                "runtimeGeneration",
            ]
            .map(|field| (field, scope_value[field].clone())),
        );
        ensure!(
            destination["workerId"].as_js_string() == Some(&self.worker)
                && destination["source"] == source,
            "The encrypted tunnel differs from its canonical OS capture."
        );
        ensure!(
            command["mode"] != "listen" && content["source"]["kind"] == "desktop-loopback",
            "The incoming guest service does not match its canonical direction."
        );
        let service = match destination["kind"].as_str() {
            Some("worker-os-tcp") => json!({"kind":"tcp","port":destination["port"]}),
            Some("worker-os-ssh") => json!({"kind":"ssh"}),
            Some("worker-os-vnc") => json!({"kind":"vnc"}),
            _ => bail!("The guest tunnel has no supported captured OS destination."),
        };
        let transport = Transport::from_value(&command["osExecution"]["transport"])?;
        let placement =
            Value::object(PLACEMENT.map(|(field, source)| (field, scope_value[source].clone())));
        let is_vnc = service["kind"] == "vnc";
        let observe = describe_service(&transport, placement, service, scope);
        let (descriptor, vnc) = if is_vnc {
            let desktop = previews.vnc_desktop(&command["serverId"], &command["osExecution"])?;
            (desktop.reconcile(observe, scope).await?, Some(desktop))
        } else {
            (observe.await?, None)
        };
        Ok((transport, descriptor, vnc))
    }

    pub(super) async fn open_guest_stream(
        &self,
        preparation: Arc<Preparation>,
        public_key: Option<String>,
    ) -> Result<Stream> {
        ensure!(
            preparation.current(self),
            "The OS tunnel preparation was retired."
        );
        let (local, guest) = duplex(64 * 1024);
        let (retire, retired) = oneshot::channel();
        let (ready, readiness) = oneshot::channel();
        let (fail, fault) = oneshot::channel();
        let logs = self.logs.clone();
        {
            let mut jobs = self.guest_streams.lock().unwrap();
            let jobs = jobs.as_mut().context("The guest tunnel worker stopped.")?;
            preparation.scope.check()?;
            while jobs.try_join_next().is_some() {}
            ensure!(
                jobs.len() < super::MAX_STREAMS,
                "Guest service carrier capacity exhausted."
            );
            jobs.spawn(async move {
                if service_stream(preparation, public_key, guest, ready, retired, fail)
                    .await
                    .is_err()
                {
                    logs.event(
                        "warn",
                        "Guest service cleanup was not confirmed",
                        json!({
                            "event":"tunnel.guest-cleanup.unconfirmed", "subsystem":"tunnel",
                            "operation":"close", "status":"failed",
                        }),
                    );
                }
            });
        }
        ensure!(
            readiness.await.unwrap_or(false),
            "The guest service connection did not become ready."
        );
        Ok(Stream {
            socket: local,
            fault,
            _lifetime: retire,
        })
    }
}

async fn describe_service(
    transport: &Transport,
    placement: Value,
    service: Value,
    scope: &Scope,
) -> Result<Value> {
    let ssh = service["kind"] == "ssh";
    let vnc = service["kind"] == "vnc";
    let workspace = placement["workspace_id"]
        .as_str()
        .context("The OS workspace is unavailable.")?;
    let response = transport
        .remote_control(
            &[
                "service-info",
                workspace,
                "--service",
                &service.stringify(),
                "--expect-placement",
                &placement.stringify(),
            ],
            scope,
        )
        .await?;
    ensure!(
        placement
            .as_object()
            .unwrap()
            .iter()
            .all(
                |(field, value)| response.as_object().and_then(|fields| fields.get(field))
                    == Some(value)
            )
            && response["service"] == service,
        "The guest service descriptor differs from its captured placement."
    );
    ensure!(
        response
            .as_object()
            .is_some_and(|fields| fields.len() == 11 + usize::from(ssh) + 2 * usize::from(vnc))
            && response["user"]
                .as_str()
                .is_some_and(|user| !user.is_empty())
            && response["remote_generation"]
                .as_str()
                .is_some_and(|value| Uuid::parse_str(value).is_ok()),
        "The guest returned an invalid service descriptor."
    );
    // Preserve the archived descriptor's JSON field order for saved pins.
    let mut descriptor = placement;
    descriptor["user"] = response["user"].clone();
    descriptor["remote_generation"] = response["remote_generation"].clone();
    descriptor["service"] = service;
    if vnc {
        ensure!(
            response["display"]
                .as_u64()
                .is_some_and(|display| display <= 65_535)
                && response["desktop_generation"]
                    .as_str()
                    .is_some_and(|value| {
                        value.len() == 64
                            && value
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    }),
            "The VNC service has no captured running desktop."
        );
        descriptor["display"] = response["display"].clone();
        descriptor["desktop_generation"] = response["desktop_generation"].clone();
    }
    if ssh {
        descriptor["ssh_host_key"] = response["ssh_host_key"].clone();
    }
    Ok(descriptor)
}

async fn service_stream(
    preparation: Arc<Preparation>,
    public_key: Option<String>,
    guest: DuplexStream,
    ready: oneshot::Sender<bool>,
    mut close: oneshot::Receiver<()>,
    fault: oneshot::Sender<()>,
) -> Result<()> {
    let connection = Uuid::new_v4().to_string();
    let descriptor = preparation.descriptor.stringify();
    let workspace = preparation.descriptor["workspace_id"].as_str().unwrap();
    let stop = async {
        let remaining = preparation
            .expires
            .saturating_sub(Utc::now().timestamp_millis())
            .max(0);
        tokio::select! {
            _ = &mut close => {},
            _ = preparation.scope.stopped() => {},
            _ = tokio::time::sleep(Duration::from_millis(remaining as u64)) => {},
        }
    };
    tokio::pin!(stop);
    tokio::select! {
        biased;
        _ = &mut stop => return Ok(()),
        _ = std::future::ready(()) => {},
    }
    let vnc = if let Some(desktop) = &preparation.vnc {
        let Ok(lease) = desktop.acquire(&preparation.scope).await else {
            return Ok(());
        };
        Some(lease)
    } else {
        None
    };
    let mut arguments = vec![
        "service-connect",
        workspace,
        "--expect",
        &descriptor,
        "--connection-id",
        &connection,
        "--notify-ready",
    ];
    if let Some(key) = public_key.as_deref() {
        arguments.extend(["--public-key", key]);
    }
    let (program, args) = preparation.transport.tunnel_service(&arguments);
    tokio::select! {
        biased;
        _ = &mut stop => return Ok(()),
        _ = std::future::ready(()) => {},
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let Ok(mut child) = command.spawn() else {
        return Ok(());
    };
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let initialized = tokio::select! {
        biased;
        _ = &mut stop => false,
        outcome = timeout(READY, wait_ready(&mut stderr, &connection)) => matches!(outcome, Ok(Ok(()))),
    };
    if ready.send(initialized).is_ok() && initialized {
        tokio::select! {
            biased;
            _ = &mut stop => {},
            result = relay(&mut child, guest, &mut stderr) => {
                if result.is_err() {
                    let _ = fault.send(());
                }
            }
        }
    }
    drop(child.stdin.take());
    drop(child.stdout.take());
    let closed = preparation
        .transport
        .close_tunnel_service(&preparation.descriptor, &connection, &Scope::default())
        .await;
    retire_child(&mut child).await;
    if closed.is_err()
        && let Some(lease) = vnc
    {
        let prior = &preparation.descriptor;
        let placement = Value::object(PLACEMENT.map(|(key, _)| (key, prior[key].clone())));
        let observed = describe_service(
            &preparation.transport,
            placement,
            prior["service"].clone(),
            &Scope::default(),
        )
        .await
        .ok();
        if lease
            .recover(prior.clone(), connection, observed.as_ref())
            .await
        {
            return Ok(());
        }
    }
    closed
}

async fn relay(
    child: &mut Child,
    guest: DuplexStream,
    stderr: &mut BufReader<tokio::process::ChildStderr>,
) -> std::io::Result<()> {
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let (mut input, mut output) = tokio::io::split(guest);
    let transfer = async {
        tokio::try_join!(
            async {
                tokio::io::copy(&mut input, &mut stdin).await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            },
            async {
                tokio::io::copy(&mut stdout, &mut output).await?;
                output.shutdown().await
            },
        )?;
        Ok(())
    };
    tokio::pin!(transfer);
    let carrier = async {
        let status = child.wait().await?;
        if !status.success() {
            return Err(std::io::Error::other("Guest service carrier failed."));
        }
        std::future::pending().await
    };
    let diagnostics = async {
        tokio::io::copy(stderr, &mut tokio::io::sink()).await?;
        std::future::pending().await
    };
    tokio::select! {
        biased;
        result = carrier => result,
        result = &mut transfer => result,
        result = diagnostics => result,
    }
}

async fn wait_ready(
    stderr: &mut BufReader<tokio::process::ChildStderr>,
    connection: &str,
) -> Result<()> {
    let receipt = format!("CANTRIP_OS_SERVICE_READY {connection}");
    loop {
        let mut line = Vec::new();
        let count = stderr.take(4096).read_until(b'\n', &mut line).await?;
        ensure!(
            count > 0,
            "The guest service ended before its readiness receipt."
        );
        if String::from_utf8_lossy(&line).trim() == receipt {
            return Ok(());
        }
    }
}

async fn retire_child(child: &mut Child) {
    if child.id().is_some() {
        #[cfg(unix)]
        let _ = cantrip_host::process::signal_owned(
            child,
            libc::SIGKILL,
            true,
            "Guest service carrier",
        );
        #[cfg(windows)]
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

pub(super) fn guest_grant(grant: &Value) -> bool {
    grant["operations"]
        .as_array()
        .is_some_and(|operations| operations.contains(&json!("stream:guest-connect")))
}
