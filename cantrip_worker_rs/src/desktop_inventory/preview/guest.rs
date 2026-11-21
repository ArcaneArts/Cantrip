//! Desktop carriers pinned to privately recorded Cantrip OS placements.
mod capture;
mod control;
pub(super) use capture::CaptureConnection;

use super::{Request, native};
use crate::{
    cantrip_os::carrier::Transport,
    codex::guest_environment::{record_path, stored},
    desktop_inventory::{DEADLINE, Helper, process::Process, read_targets, retire},
    filesystem::Scope,
    metadata::Signal,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, payload_digest, value::json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, oneshot},
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
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    groups: HashMap<String, Weak<Group>>,
    jobs: JoinSet<()>,
    closed: bool,
}

#[derive(Clone)]
pub(super) struct GuestLease {
    id: uuid::Uuid,
    group: Arc<Group>,
}

struct Group {
    transport: Transport,
    placement: Value,
    attachment: Value,
    pending: Arc<Semaphore>,
    state: AsyncMutex<State>,
    control: control::Control,
}

#[derive(Default)]
struct State {
    owners: HashSet<uuid::Uuid>,
    agents: HashMap<uuid::Uuid, Weak<native::Attachment>>,
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
            registry: Mutex::default(),
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

    pub(super) fn submit(
        &self,
        authority: &Value,
        slot: &Mutex<Option<GuestLease>>,
        execution: &Value,
        mut request: Request,
    ) -> Result<()> {
        let mut lease = slot.lock().unwrap();
        request.signal.check()?;
        let mut registry = self.registry.lock().unwrap();
        let group = registry.group(&authority["serverId"], execution)?;
        request.signal = Signal::any(vec![request.signal, group.control.agent()?]);
        ensure!(
            lease
                .as_ref()
                .is_none_or(|bound| Arc::ptr_eq(&bound.group, &group)),
            native::reject(
                "ownership-mismatch",
                "The captured Cantrip OS desktop changed."
            )
        );
        let permit = group.admit()?;
        let lease = lease
            .get_or_insert_with(|| GuestLease {
                id: uuid::Uuid::new_v4(),
                group,
            })
            .clone();
        while registry.jobs.try_join_next().is_some() {}
        registry.jobs.spawn(async move {
            // Once accepted the carrier owns framing, even if the requester
            // stops waiting. Its cancellation drains or retires the pipe.
            let _permit = permit;
            lease.dispatch(request).await;
        });
        Ok(())
    }

    pub(super) fn prepare(
        &self,
        server: &Value,
        execution: &Value,
        signal: Signal,
    ) -> Result<oneshot::Receiver<Result<Value>>> {
        let mut registry = self.registry.lock().unwrap();
        let group = registry.group(server, execution)?;
        let permit = group.admit()?;
        let (reply, result) = oneshot::channel();
        while registry.jobs.try_join_next().is_some() {}
        registry.jobs.spawn(async move {
            let _permit = permit;
            let _ = reply.send(group.prepare(&signal).await);
        });
        Ok(result)
    }

    pub(super) fn release(
        &self,
        slot: &Mutex<Option<GuestLease>>,
        attachment: Arc<native::Attachment>,
    ) {
        let Some(lease) = slot.lock().unwrap().take() else {
            return;
        };
        let mut registry = self.registry.lock().unwrap();
        if registry.closed {
            return;
        }
        while registry.jobs.try_join_next().is_some() {}
        registry.jobs.spawn(async move {
            let mut state = lease.group.state.lock().await;
            state.owners.remove(&lease.id);
            state.agents.remove(&lease.id);
            if state.owners.is_empty() {
                if let Some(carrier) = state.carrier.take() {
                    carrier.close(&lease.group.transport).await;
                }
            } else if let Some(carrier) = state.carrier.as_mut() {
                native::release(&attachment, &mut carrier.helper).await;
            }
        });
    }

    pub(super) async fn close(&self) {
        let (mut jobs, groups) = {
            let mut registry = self.registry.lock().unwrap();
            registry.closed = true;
            let groups = registry
                .groups
                .drain()
                .filter_map(|(_, group)| group.upgrade())
                .collect::<Vec<_>>();
            (std::mem::take(&mut registry.jobs), groups)
        };
        while jobs.join_next().await.is_some() {}
        for group in groups {
            jobs.spawn(async move {
                let mut state = group.state.lock().await;
                if let Some(carrier) = state.carrier.take() {
                    carrier.close(&group.transport).await;
                }
            });
        }
        while jobs.join_next().await.is_some() {}
    }
}

impl Registry {
    fn group(&mut self, server: &Value, execution: &Value) -> Result<Arc<Group>> {
        ensure!(!self.closed, native::cancelled("not-sent"));
        let scope = &execution["scope"];
        let transport = Transport::from_value(&execution["transport"])?;
        let placement = Value::object(
            DESKTOP_FIELDS
                .iter()
                .map(|(guest, field)| (*guest, scope[*field].clone())),
        );
        let key = payload_digest(&json!([
            server.clone(),
            scope["ownerId"].clone(),
            scope["workerId"].clone(),
            scope["instanceId"].clone(),
            scope["workspaceId"].clone(),
        ]));
        self.groups.retain(|_, group| group.strong_count() > 0);
        Ok(match self.groups.get(&key).and_then(Weak::upgrade) {
            Some(group) => {
                ensure!(
                    group.transport == transport
                        && group.placement == placement
                        && group.attachment == scope["attachmentGeneration"],
                    native::reject(
                        "ownership-mismatch",
                        "The captured Cantrip OS desktop changed."
                    )
                );
                group
            }
            None => {
                let group = Arc::new(Group {
                    transport,
                    placement,
                    attachment: scope["attachmentGeneration"].clone(),
                    pending: Arc::new(Semaphore::new(4)),
                    state: AsyncMutex::default(),
                    control: control::Control::default(),
                });
                self.groups.insert(key, Arc::downgrade(&group));
                group
            }
        })
    }
}

impl GuestLease {
    async fn dispatch(&self, request: Request) {
        let mut state = tokio::select! {
            biased;
            _ = request.signal.cancelled() => {
                request.expired();
                return;
            },
            state = self.group.state.lock() => state,
        };
        if request
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            request.expired();
            return;
        }
        state.owners.insert(self.id);
        state
            .agents
            .retain(|_, attachment| attachment.strong_count() > 0);
        state
            .agents
            .insert(self.id, Arc::downgrade(&request.attachment));
        if state.carrier.as_mut().is_some_and(|carrier| {
            carrier
                .helper
                .as_mut()
                .is_none_or(|child| child.process.exited())
        }) {
            if let Some(carrier) = state.carrier.take() {
                carrier.close(&self.group.transport).await;
            }
        }
        let starts_helper = matches!(
            request.action["operation"].as_str(),
            Some("capabilities.get" | "targets.list" | "session.open")
        );
        if state.carrier.is_none() && starts_helper {
            match self.group.connect(&request.signal).await {
                Ok(carrier) => state.carrier = Some(carrier),
                Err(error) => {
                    request.fail(error);
                    return;
                }
            }
        }
        if let Some(carrier) = state.carrier.as_mut() {
            native::run(request, &mut carrier.helper, None).await;
        } else {
            native::run(request, &mut None, None).await;
        }
    }
}

impl Group {
    fn admit(&self) -> Result<OwnedSemaphorePermit> {
        self.pending
            .clone()
            .try_acquire_owned()
            .map_err(|_| native::reject("capacity", "Computer-use guest requests are busy."))
    }

    async fn prepare(&self, signal: &Signal) -> Result<Value> {
        let mut state = tokio::select! {
            biased;
            reason = signal.cancelled() => return Err(reason.into()),
            state = self.state.lock() => state,
        };
        let context = self.open_context(signal, None).await?;
        let generation = context["desktop_generation"].clone();
        self.install_context(&mut state, context, signal).await?;
        let process = &mut state
            .carrier
            .as_mut()
            .unwrap()
            .helper
            .as_mut()
            .unwrap()
            .process;
        let inventory = tokio::select! {
            biased;
            reason = signal.cancelled() => Err(reason.into()),
            result = timeout(DEADLINE, read_targets(process)) =>
                result.context("The assigned Linux display did not respond.").and_then(|result| result),
        };
        // An interrupted inventory can leave a partial frame in the pipe.
        if (state.owners.is_empty() || inventory.is_err())
            && let Some(carrier) = state.carrier.take()
        {
            carrier.close(&self.transport).await;
        }
        let (targets, _) = inventory?;
        ensure!(
            targets.iter().any(|target| target["kind"] == "monitor"),
            "The assigned Linux display is unavailable."
        );
        Ok(json!({"desktopGeneration":generation}))
    }

    async fn connect(&self, signal: &Signal) -> Result<Carrier> {
        let context = self.open_context(signal, None).await?;
        self.connect_context(context, signal).await
    }

    async fn install_context(
        &self,
        state: &mut State,
        context: Value,
        signal: &Signal,
    ) -> Result<()> {
        if state.carrier.as_mut().is_some_and(|carrier| {
            carrier.context != context
                || carrier
                    .helper
                    .as_mut()
                    .is_none_or(|helper| helper.process.exited())
        }) && let Some(carrier) = state.carrier.take()
        {
            carrier.close(&self.transport).await;
        }
        if state.carrier.is_none() {
            state.carrier = Some(self.connect_context(context, signal).await?);
        }
        Ok(())
    }

    async fn open_context(&self, signal: &Signal, generation: Option<&str>) -> Result<Value> {
        let workspace = self.placement["workspace_id"]
            .as_str()
            .context("Missing guest workspace.")?;
        let lifetime = Scope::default();
        let mut expected = self.placement.clone();
        if let Some(generation) = generation {
            expected["desktop_generation"] = json!(generation);
        }
        let expected = expected.stringify();
        let arguments = ["open", workspace, "--expect-placement", &expected];
        let control = self.transport.remote_control(&arguments, &lifetime);
        let context = tokio::select! {
            biased;
            _ = signal.cancelled() => return Err(native::cancelled("not-sent")),
            receipt = control => receipt.map_err(|_| native::reject("unavailable", if generation.is_some() {
                "The captured Linux desktop is unavailable. Open a new view."
            } else {
                "The assigned Cantrip OS desktop could not be opened."
            }))?,
        };
        validate_context(&self.placement, &context)?;
        if let Some(generation) = generation {
            ensure!(
                context["desktop_generation"] == generation,
                native::reject(
                    "ownership-mismatch",
                    "The captured Linux desktop generation changed."
                )
            );
        }
        Ok(context)
    }

    async fn connect_context(&self, context: Value, signal: &Signal) -> Result<Carrier> {
        signal.check()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (program, args) = self.transport.remote_connection(&context, &id)?;
        let mut carrier = Carrier {
            context,
            id,
            helper: Some(Helper::new(Process::spawn(program, &args)?)),
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
