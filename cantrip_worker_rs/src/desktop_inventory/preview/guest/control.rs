//! The assigned display has one human controller across all of its surfaces.
use super::{Group, Guests, State, native};
use crate::{
    desktop_inventory::{capture::ControlState, retire},
    filesystem::Scope,
    metadata::{Abort, Signal},
};
use anyhow::{Result, anyhow, ensure};
use cantrip_wire::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use uuid::Uuid;

pub(super) struct Control {
    inner: Mutex<Inner>,
    state: watch::Sender<Option<ControlState>>,
}

struct Inner {
    controller: Option<(Uuid, Uuid)>,
    agent: (Abort, Signal),
    unconfirmed_vnc: Option<VncCleanup>,
}

#[derive(Clone)]
struct VncCleanup {
    lease: Uuid,
    connection: String,
    descriptor: Value,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                controller: None,
                agent: Abort::new(),
                unconfirmed_vnc: None,
            }),
            state: watch::channel(None).0,
        }
    }
}

impl Control {
    pub(super) fn watch(&self) -> watch::Receiver<Option<ControlState>> {
        self.state.subscribe()
    }

    pub(in crate::desktop_inventory::preview::guest) fn agent(&self) -> Result<Signal> {
        let inner = self.inner.lock().unwrap();
        ensure!(
            inner.controller.is_none(),
            native::reject(
                "ownership-mismatch",
                "A human controls this Linux desktop. Return control before requesting fresh computer use."
            )
        );
        Ok(inner.agent.1.clone())
    }

    fn begin(&self, owner: Uuid, lease: Uuid) -> Result<bool> {
        let mut inner = self.inner.lock().unwrap();
        if inner.controller == Some((owner, lease)) {
            return Ok(false);
        }
        ensure!(
            inner.controller.is_none(),
            "Another viewer owns this desktop's control lease."
        );
        inner.controller = Some((owner, lease));
        inner
            .agent
            .0
            .abort(anyhow!("A human took control of this Linux desktop."));
        self.state.send_replace(Some(ControlState {
            id: lease,
            switching: true,
        }));
        Ok(true)
    }

    pub(super) fn owns(&self, owner: Uuid, lease: Uuid) -> bool {
        self.inner.lock().unwrap().controller == Some((owner, lease))
    }

    pub(super) fn lease(&self, owner: Uuid) -> Option<Uuid> {
        self.inner
            .lock()
            .unwrap()
            .controller
            .filter(|(current, _)| *current == owner)
            .map(|(_, lease)| lease)
    }

    pub(super) fn end(&self, owner: Uuid, lease: Uuid) {
        let mut inner = self.inner.lock().unwrap();
        if inner.controller == Some((owner, lease)) {
            inner.controller = None;
            inner.agent = Abort::new();
            inner.unconfirmed_vnc = None;
            self.state.send_replace(None);
        }
    }

    pub(super) fn has_unconfirmed_vnc(&self) -> bool {
        self.inner.lock().unwrap().unconfirmed_vnc.is_some()
    }

    fn taken(&self, lease: Uuid) {
        self.state.send_replace(Some(ControlState {
            id: lease,
            switching: false,
        }));
    }
}

impl Group {
    pub(super) async fn take_control(
        &self,
        owner: Uuid,
        lease: Uuid,
        generation: Uuid,
    ) -> Result<()> {
        if !self.control.begin(owner, lease)? {
            return Ok(());
        }
        let result = async {
            let mut state = self.state.lock().await;
            ensure!(
                self.control.owns(owner, lease),
                "The desktop control authority expired."
            );
            ensure!(
                state
                    .carrier
                    .as_ref()
                    .and_then(|carrier| carrier.helper.as_ref())
                    .is_some_and(|helper| helper.identity == generation),
                "The Linux desktop connection retired."
            );
            Self::release_agents(&mut state).await?;
            self.control.taken(lease);
            Ok(())
        }
        .await;
        if result.is_err() {
            self.control.end(owner, lease);
        }
        result
    }

    async fn release_agents(state: &mut State) -> Result<()> {
        let agents = std::mem::take(&mut state.agents);
        if let Some(carrier) = &mut state.carrier {
            for attachment in agents.into_values().filter_map(|agent| agent.upgrade()) {
                if let Err(error) = native::close_attachment(&attachment, &mut carrier.helper).await
                {
                    retire(&mut carrier.helper).await;
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}

pub(crate) struct VncDesktop(Arc<Group>);

pub(crate) struct VncLease {
    group: Arc<Group>,
    id: Uuid,
    retained: bool,
}

impl VncDesktop {
    pub(crate) async fn acquire(&self, scope: &Scope) -> Result<VncLease> {
        scope.check()?;
        let id = Uuid::new_v4();
        self.0.control.begin(id, id)?;
        let lease = VncLease {
            group: self.0.clone(),
            id,
            retained: false,
        };
        let mut state = tokio::select! {
            biased;
            _ = scope.stopped() => return Err(anyhow!("The VNC control authority expired.")),
            state = self.0.state.lock() => state,
        };
        Group::release_agents(&mut state).await?;
        scope.check()?;
        self.0.control.taken(id);
        Ok(lease)
    }

    pub(crate) async fn reconcile(
        &self,
        observe: impl std::future::Future<Output = Result<Value>>,
        scope: &Scope,
    ) -> Result<Value> {
        let retired = self.0.control.inner.lock().unwrap().unconfirmed_vnc.clone();
        let observed = observe.await?;
        let Some(retired) = retired else {
            return Ok(observed);
        };
        if vnc_replaced(&retired.descriptor, &observed) {
            self.0.fence_vnc(&retired.descriptor).await;
        } else {
            self.0
                .transport
                .close_tunnel_service(&retired.descriptor, &retired.connection, scope)
                .await?;
        }
        self.0.control.end(retired.lease, retired.lease);
        Ok(observed)
    }
}

impl VncLease {
    pub(crate) async fn recover(
        mut self,
        descriptor: Value,
        connection: String,
        observed: Option<&Value>,
    ) -> bool {
        if observed.is_some_and(|current| vnc_replaced(&descriptor, current)) {
            self.group.fence_vnc(&descriptor).await;
            return true;
        }
        self.group.control.inner.lock().unwrap().unconfirmed_vnc = Some(VncCleanup {
            lease: self.id,
            connection,
            descriptor,
        });
        self.retained = true;
        false
    }
}

impl Drop for VncLease {
    fn drop(&mut self) {
        if !self.retained {
            self.group.control.end(self.id, self.id);
        }
    }
}

fn vnc_replaced(before: &Value, after: &Value) -> bool {
    ["generation", "remote_generation", "desktop_generation"]
        .into_iter()
        .any(|field| before[field] != after[field])
}

impl Group {
    async fn fence_vnc(&self, retired: &Value) {
        let mut state = self.state.lock().await;
        if state
            .carrier
            .as_ref()
            .is_some_and(|carrier| !vnc_replaced(retired, &carrier.context))
            && let Some(carrier) = state.carrier.take()
        {
            carrier.close(&self.transport).await;
        }
    }
}

pub(in crate::desktop_inventory::preview) struct Agent {
    _group: Arc<Group>,
    pub(in crate::desktop_inventory::preview) signal: Signal,
}

impl Guests {
    pub(in crate::desktop_inventory::preview) fn vnc_desktop(
        &self,
        server: &Value,
        execution: &Value,
    ) -> Result<VncDesktop> {
        self.registry
            .lock()
            .unwrap()
            .group(server, execution)
            .map(VncDesktop)
    }

    pub(in crate::desktop_inventory::preview) fn agent(
        &self,
        server: &Value,
        execution: &Value,
    ) -> Result<Agent> {
        let group = self.registry.lock().unwrap().group(server, execution)?;
        let signal = group.control.agent()?;
        Ok(Agent {
            _group: group,
            signal,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cantrip_wire::value::json;

    #[tokio::test]
    async fn vnc_fences_agent_requests_until_the_captured_controller_retires() {
        let guests = Guests::new(Default::default());
        let server = json!("server");
        let execution = json!({
            "scope": json!({
                "ownerId":"owner", "workerId":"worker", "instanceId":"instance",
                "workspaceId":"workspace", "guestWorkspaceId":"guest",
                "attachmentGeneration":"attachment", "runtimeGeneration":"runtime"
            }),
            "transport": json!({"kind":"docker", "container":"fixture"})
        });
        let scope = Scope::default();
        let agent = guests.agent(&server, &execution).unwrap();
        let desktop = guests.vnc_desktop(&server, &execution).unwrap();
        let lease = desktop.acquire(&scope).await.unwrap();
        assert!(agent.signal.check().is_err());
        assert!(guests.agent(&server, &execution).is_err());
        assert!(desktop.acquire(&scope).await.is_err());

        let descriptor = json!({"remote_generation":"previous"});
        assert!(
            !lease
                .recover(descriptor, "connection".to_owned(), None)
                .await
        );
        drop(agent);
        drop(desktop);
        assert!(guests.agent(&server, &execution).is_err());

        let replacement = guests.vnc_desktop(&server, &execution).unwrap();
        replacement
            .reconcile(async { Ok(json!({"remote_generation":"current"})) }, &scope)
            .await
            .unwrap();
        assert!(
            guests
                .agent(&server, &execution)
                .unwrap()
                .signal
                .check()
                .is_ok()
        );
    }
}
