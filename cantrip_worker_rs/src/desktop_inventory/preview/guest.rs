//! Preview carriers pinned to privately recorded Cantrip OS placements.
use super::{Lease, Request, native};
use crate::{
    cantrip_os::carrier::Transport,
    codex::guest_environment::{record_path, stored},
    desktop_inventory::{Helper, effects, process::Process, retire},
    filesystem::Scope,
    metadata::Signal,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, Semaphore},
    task::JoinSet,
    time::{Instant, timeout},
};

const CONNECT: Duration = Duration::from_secs(60);
const RELEASE: Duration = Duration::from_secs(22);
const PLACEMENT_FIELDS: &[&str] = &[
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
];
const DESKTOP_FIELDS: &[(&str, &str)] = &[
    ("instance_id", "guestInstanceId"),
    ("generation", "runtimeGeneration"),
    ("owner_id", "ownerId"),
    ("worker_id", "workerId"),
    ("workspace_id", "guestWorkspaceId"),
    ("uid", "uid"),
    ("gid", "gid"),
    ("home", "homeGuestPath"),
];

pub(super) struct Guests {
    data: PathBuf,
    groups: Mutex<HashMap<String, Weak<Group>>>,
    releases: Mutex<JoinSet<()>>,
}

pub(super) struct Group {
    transport: Transport,
    placement: Value,
    attachment: Value,
    pending: Semaphore,
    state: AsyncMutex<State>,
}

#[derive(Default)]
struct State {
    owners: HashSet<JsString>,
    carrier: Option<Carrier>,
}

struct Carrier {
    context: Value,
    id: String,
    helper: Option<Helper>,
}

impl Guests {
    pub(super) fn new(data: PathBuf) -> Self {
        Self {
            data,
            groups: Mutex::default(),
            releases: Mutex::new(JoinSet::new()),
        }
    }

    pub(super) fn placement(&self, authority: &Value) -> Result<Option<Value>> {
        let chat = authority["chatId"]
            .as_js_string()
            .context("Missing preview Chat.")?;
        let saved = stored(&record_path(&self.data, authority, chat))?;
        let presented = &authority["osPlacement"];
        if let Some(execution) = &saved {
            let scope = &execution["scope"];
            ensure!(
                !presented.is_null()
                    && authority["contextKind"] == "project"
                    && scope["ownerId"] == authority["ownerId"]
                    && scope["workerId"] == authority["workerId"]
                    && scope["projectId"] == authority["projectId"]
                    && scope["worktreeId"] == authority["placementId"]
                    && PLACEMENT_FIELDS
                        .iter()
                        .all(|key| scope[*key] == presented[*key]),
                native::reject(
                    "ownership-mismatch",
                    "The preview belongs to another Cantrip OS placement."
                )
            );
        } else {
            ensure!(
                presented.is_null(),
                native::reject(
                    "unavailable",
                    "The Chat's Cantrip OS placement is unavailable."
                )
            );
        }
        Ok(saved)
    }

    fn group(&self, lease: &Lease, execution: &Value) -> Result<Arc<Group>> {
        let mut connection = lease.guest.lock().unwrap();
        lease.signal.check()?;
        let scope = &execution["scope"];
        let transport = Transport::from_value(&execution["transport"])?;
        let placement = Value::object(
            DESKTOP_FIELDS
                .iter()
                .map(|(guest, field)| (*guest, scope[*field].clone())),
        );
        let key = payload_digest(&json!([
            lease.authority["serverId"].clone(),
            scope["ownerId"].clone(),
            scope["workerId"].clone(),
            scope["instanceId"].clone(),
            scope["workspaceId"].clone(),
        ]));
        let mut groups = self.groups.lock().unwrap();
        groups.retain(|_, group| group.strong_count() > 0);
        let selected = match groups.get(&key).and_then(Weak::upgrade) {
            Some(existing) => {
                ensure!(
                    existing.transport == transport
                        && existing.placement == placement
                        && existing.attachment == scope["attachmentGeneration"],
                    native::reject(
                        "ownership-mismatch",
                        "The captured Cantrip OS desktop changed."
                    )
                );
                existing
            }
            None => {
                let group = Arc::new(Group {
                    transport,
                    placement,
                    attachment: scope["attachmentGeneration"].clone(),
                    pending: Semaphore::new(4),
                    state: AsyncMutex::default(),
                });
                groups.insert(key, Arc::downgrade(&group));
                group
            }
        };
        ensure!(
            connection
                .as_ref()
                .is_none_or(|registered| Arc::ptr_eq(registered, &selected)),
            native::reject(
                "ownership-mismatch",
                "The captured Cantrip OS desktop changed."
            )
        );
        *connection = Some(selected.clone());
        Ok(selected)
    }

    pub(super) async fn dispatch(
        &self,
        lease: &Arc<Lease>,
        request: Request,
        execution: &Value,
    ) -> Result<()> {
        let group = self.group(lease, execution)?;
        let _permit = group
            .pending
            .try_acquire()
            .map_err(|_| native::reject("capacity", "Computer-use preview is busy."))?;
        let mut state = tokio::select! {
            biased;
            _ = lease.signal.cancelled() => return Err(native::cancelled("not-sent")),
            state = group.state.lock() => state,
        };
        if request
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            request.expired();
            return Ok(());
        }
        state.owners.insert(lease.id.clone());
        let starts_helper = matches!(
            request.action["operation"].as_str(),
            Some("capabilities.get" | "targets.list" | "session.open")
        );
        if state.carrier.is_none() && starts_helper {
            state.carrier = Some(group.connect(&lease.signal).await?);
        }
        if let Some(carrier) = state.carrier.as_mut() {
            native::run(request, &mut carrier.helper, None).await;
        } else {
            native::run(request, &mut None, None).await;
        }
        Ok(())
    }

    pub(super) fn release(&self, lease: Arc<Lease>) {
        let Some(group) = lease.guest.lock().unwrap().take() else {
            return;
        };
        let mut releases = self.releases.lock().unwrap();
        while releases.try_join_next().is_some() {}
        releases.spawn(async move {
            let mut state = group.state.lock().await;
            state.owners.remove(&lease.id);
            if state.owners.is_empty() {
                if let Some(carrier) = state.carrier.take() {
                    carrier.close(&group.transport).await;
                }
            } else if let Some(carrier) = state.carrier.as_mut() {
                native::release(&lease.attachment, &mut carrier.helper).await;
            }
        });
    }

    pub(super) async fn close(&self) {
        let mut releases = std::mem::take(&mut *self.releases.lock().unwrap());
        while releases.join_next().await.is_some() {}
    }
}

impl Group {
    async fn connect(&self, signal: &Signal) -> Result<Carrier> {
        let workspace = self.placement["workspace_id"]
            .as_str()
            .context("Missing guest workspace.")?;
        let lifetime = Scope::default();
        let expected = self.placement.stringify();
        let arguments = ["open", workspace, "--expect-placement", &expected];
        let control = self.transport.remote_control(&arguments, &lifetime);
        let context = tokio::select! {
            biased;
            _ = signal.cancelled() => return Err(native::cancelled("not-sent")),
            receipt = control => receipt.map_err(|_| native::reject("unavailable", "The assigned Cantrip OS desktop could not be opened."))?,
        };
        validate_context(&self.placement, &context)?;
        signal.check()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (program, args) = self.transport.remote_connection(&context, &id)?;
        let mut carrier = Carrier {
            context,
            id,
            helper: Some(Helper {
                identity: uuid::Uuid::new_v4(),
                process: Process::spawn(program, &args)?,
                effects: effects::NativeState::default(),
            }),
        };
        let ready = tokio::select! {
            biased;
            _ = signal.cancelled() => Err(native::cancelled("not-sent")),
            result = timeout(CONNECT, carrier.helper.as_mut().unwrap().process.initialize()) =>
                result.ok().and_then(Result::ok).ok_or_else(|| native::reject("unavailable", "The assigned Cantrip OS desktop connection could not be started.")),
        };
        match ready {
            Ok(()) => Ok(carrier),
            Err(error) => {
                carrier.close(&self.transport).await;
                Err(error)
            }
        }
    }
}

impl Carrier {
    async fn close(mut self, transport: &Transport) {
        retire(&mut self.helper).await;
        let workspace = self.context["workspace_id"]
            .as_str()
            .expect("Captured workspace");
        let context = self.context.stringify();
        // The guest checks both the original manager generation and exact
        // connection ID. A late release cannot stop a different connection.
        let _ = timeout(
            RELEASE,
            transport.remote_control(
                &[
                    "close",
                    workspace,
                    "--expect",
                    &context,
                    "--connection-id",
                    &self.id,
                ],
                &Scope::default(),
            ),
        )
        .await;
    }
}

fn validate_context(expected: &Value, context: &Value) -> Result<()> {
    let uuid = |name| {
        context[name]
            .as_str()
            .and_then(|text| uuid::Uuid::parse_str(text).ok())
            .is_some()
    };
    let token = context["desktop_generation"].as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    ensure!(
        context
            .as_object()
            .is_some_and(|fields| fields.len() == DESKTOP_FIELDS.len() + 4)
            && DESKTOP_FIELDS
                .iter()
                .all(|(field, _)| expected[*field] == context[*field])
            && uuid("instance_id")
            && uuid("generation")
            && uuid("remote_generation")
            && token
            && context["display"]
                .as_u64()
                .is_some_and(|display| display <= 65535)
            && context["user"]
                == format!(
                    "ctw-{}",
                    expected["workspace_id"].as_str().unwrap_or_default()
                ),
        native::reject(
            "ownership-mismatch",
            "The assigned Cantrip OS desktop identity changed."
        )
    );
    Ok(())
}
