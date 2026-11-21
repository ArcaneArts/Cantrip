//! The assigned display has one human controller across all of its surfaces.
use super::{Group, Guests, native};
use crate::{
    desktop_inventory::{capture::ControlState, retire},
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result, anyhow, ensure};
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
}

impl Default for Control {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                controller: None,
                agent: Abort::new(),
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
            self.state.send_replace(None);
        }
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
            let super::State {
                agents, carrier, ..
            } = &mut *state;
            let carrier = carrier
                .as_mut()
                .context("The Linux desktop connection retired.")?;
            ensure!(
                carrier
                    .helper
                    .as_ref()
                    .is_some_and(|helper| helper.identity == generation),
                "The Linux desktop connection retired."
            );
            for attachment in std::mem::take(agents)
                .into_values()
                .filter_map(|agent| agent.upgrade())
            {
                if let Err(error) = native::close_attachment(&attachment, &mut carrier.helper).await
                {
                    retire(&mut carrier.helper).await;
                    return Err(error);
                }
            }
            self.control.state.send_replace(Some(ControlState {
                id: lease,
                switching: false,
            }));
            Ok(())
        }
        .await;
        if result.is_err() {
            self.control.end(owner, lease);
        }
        result
    }
}

pub(in crate::desktop_inventory::preview) struct Agent {
    _group: Arc<Group>,
    pub(in crate::desktop_inventory::preview) signal: Signal,
}

impl Guests {
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
