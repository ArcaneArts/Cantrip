//! A page generation borrowed by an admitted agent. The surface still owns it.
use super::{Endpoint, Manager, Shared, Work};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_browser::Page;
use cantrip_interaction::cursor::{CursorAppearance, CursorState};
use cantrip_wire::{JsString, Value, value::json};
use std::sync::{Arc, Weak};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};

pub(crate) struct Target {
    pub(crate) surface: JsString,
    pub(crate) owner: JsString,
    pub(crate) project: Value,
    pub(crate) server: Value,
}

pub(super) struct Lease {
    pub(super) id: uuid::Uuid,
    stopped: watch::Sender<bool>,
    busy: Arc<Semaphore>,
}

impl Lease {
    pub(super) fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4(),
            stopped: watch::channel(false).0,
            busy: Arc::new(Semaphore::new(1)),
        }
    }

    pub(super) fn close(&self) {
        self.stopped.send_replace(true);
    }

    pub(super) fn borrow(
        &self,
        page: Page,
        endpoint: &Arc<Endpoint>,
        shared: Arc<Shared>,
        target: Target,
    ) -> AgentPage {
        AgentPage {
            page,
            endpoint: Arc::downgrade(endpoint),
            authorize: Arc::new(move || {
                let identity = shared
                    .encryption
                    .bound_component("surface-private-state", None)?;
                ensure!(
                    identity.owner_id == target.owner && identity.server_id == target.server,
                    "Browser session authority changed."
                );
                Ok(())
            }),
            lease: self.id,
            stopped: self.stopped.subscribe(),
            busy: self.busy.clone(),
        }
    }
}

pub(crate) struct AgentPage {
    page: Page,
    endpoint: Weak<Endpoint>,
    authorize: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    lease: uuid::Uuid,
    stopped: watch::Receiver<bool>,
    busy: Arc<Semaphore>,
}

impl Manager {
    pub(crate) async fn agent_page(&self, target: Target) -> Result<AgentPage> {
        let endpoint = self.state.lock().unwrap().running.get(&target.surface).cloned()
            .context("The selected Browser surface is not open. Open that browser in Cantrip, then retry.")?;
        let (done, result) = oneshot::channel();
        endpoint
            .sender
            .try_send(Work::AgentBorrow { target, done })
            .map_err(|_| anyhow!("The selected Browser surface is unavailable."))?;
        result
            .await
            .context("The selected Browser surface closed.")?
    }
}

impl AgentPage {
    pub(crate) fn check(&self) -> Result<()> {
        ensure!(
            !*self.stopped.borrow() && self.page.is_connected() && self.endpoint.strong_count() > 0,
            "Browser target was replaced or closed. Open a fresh web session; input was not replayed."
        );
        (self.authorize)()
    }

    pub(crate) fn claim(&self) -> Result<OwnedSemaphorePermit> {
        self.check()?;
        self.busy
            .clone()
            .try_acquire_owned()
            .context("Browser session has another agent operation in progress.")
    }

    pub(crate) fn page(&self) -> &Page {
        &self.page
    }

    pub(crate) fn closed(&self) -> watch::Receiver<bool> {
        self.stopped.clone()
    }

    pub(crate) fn start(&self, chat: &JsString) {
        self.present(chat, Event::Start);
    }

    pub(crate) fn pointer(&self, chat: &JsString, x: f64, y: f64, click: bool, dragging: bool) {
        self.present(
            chat,
            Event::Pointer {
                x,
                y,
                click,
                dragging,
            },
        );
    }

    fn present(&self, chat: &JsString, event: Event) {
        if let Some(endpoint) = self.endpoint.upgrade() {
            let _ = endpoint
                .sender
                .try_send(Work::AgentPresentation(Presentation {
                    lease: self.lease,
                    chat: chat.clone(),
                    event,
                }));
        }
    }

    pub(crate) async fn hide(&self, chat: &JsString) {
        if let Some(endpoint) = self.endpoint.upgrade() {
            let _ = endpoint
                .sender
                .send(Work::AgentPresentation(Presentation {
                    lease: self.lease,
                    chat: chat.clone(),
                    event: Event::Hide,
                }))
                .await;
        }
    }
}

pub(super) struct Presentation {
    pub(super) lease: uuid::Uuid,
    chat: JsString,
    pub(super) event: Event,
}

pub(super) enum Event {
    Start,
    Pointer {
        x: f64,
        y: f64,
        click: bool,
        dragging: bool,
    },
    Hide,
    Sprite {
        epoch: uuid::Uuid,
        sprite: Value,
    },
}

impl Event {
    pub(super) fn position(&self) -> Option<(f64, f64)> {
        match self {
            Self::Pointer { x, y, .. } => Some((*x, *y)),
            _ => None,
        }
    }
}

pub(super) struct Cursor {
    chat: Option<JsString>,
    epoch: uuid::Uuid,
    sequence: u64,
    point: Option<(f64, f64)>,
    dragging: bool,
    sprite: Option<Value>,
}

impl Default for Cursor {
    fn default() -> Self {
        Self {
            chat: None,
            epoch: uuid::Uuid::new_v4(),
            sequence: 0,
            point: None,
            dragging: false,
            sprite: None,
        }
    }
}

impl Cursor {
    pub(super) fn state(&self, click: bool, include_sprite: bool) -> Value {
        let mut state = json!({
            "type":"browser-agent-cursor","epoch":self.epoch.to_string(),"sequence":self.sequence,
            "position":self.point.map(|(x,y)| json!({"x":x,"y":y})),"click":click,"dragging":self.dragging,
        });
        if include_sprite && let Some(sprite) = &self.sprite {
            state["sprite"] = sprite.clone();
        }
        state
    }

    pub(super) fn update(
        &mut self,
        update: Presentation,
        point: Option<(f64, f64)>,
        endpoint: &Arc<Endpoint>,
    ) -> Option<Value> {
        if matches!(&update.event, Event::Start | Event::Pointer { .. })
            && self.chat.as_ref() != Some(&update.chat)
        {
            *self = Self {
                chat: Some(update.chat.clone()),
                ..Self::default()
            };
            let lease = update.lease;
            let epoch = self.epoch;
            let chat = update.chat.clone();
            let deliver = endpoint.sender.clone();
            tokio::spawn(async move {
                let identity = chat.clone();
                let generated = tokio::task::spawn_blocking(move || {
                    let state = CursorState {
                        appearance: CursorAppearance::for_identity(&identity.lossy()),
                        ..CursorState::default()
                    };
                    cantrip_interaction::sprite::sprite(&state)
                        .map(|sprite| Value::from_serialize(&sprite))
                })
                .await;
                if let Ok(Some(sprite)) = generated {
                    let _ = deliver
                        .send(Work::AgentPresentation(Presentation {
                            lease,
                            chat,
                            event: Event::Sprite { epoch, sprite },
                        }))
                        .await;
                }
            });
        }
        if self.chat.as_ref() != Some(&update.chat) {
            return None;
        }
        let (click, include_sprite) = match update.event {
            Event::Start => return None,
            Event::Pointer {
                click, dragging, ..
            } => {
                self.point = point;
                self.dragging = dragging;
                (click, false)
            }
            Event::Hide => {
                self.point = None;
                self.dragging = false;
                (false, false)
            }
            Event::Sprite { epoch, sprite } if epoch == self.epoch => {
                self.sprite = Some(sprite);
                (false, true)
            }
            Event::Sprite { .. } => return None,
        };
        self.sequence += 1;
        Some(self.state(click, include_sprite))
    }
}

#[cfg(test)]
pub(crate) async fn with_owned_fixture<T>(
    page: Page,
    check: impl AsyncFnOnce(AgentPage, watch::Sender<bool>, watch::Receiver<Value>) -> Result<T>,
) -> Result<T> {
    let lease = Lease::new();
    let (sender, mut work) = tokio::sync::mpsc::channel(32);
    let endpoint = Arc::new(Endpoint {
        kind: "browser",
        sender,
        buffered: Default::default(),
        attachments: Default::default(),
    });
    let borrowed = AgentPage {
        page,
        endpoint: Arc::downgrade(&endpoint),
        authorize: Arc::new(|| Ok(())),
        lease: lease.id,
        stopped: lease.stopped.subscribe(),
        busy: lease.busy.clone(),
    };
    let (updates, event) = watch::channel(Value::Null);
    let observe = async {
        let mut cursor = Cursor::default();
        while let Some(Work::AgentPresentation(present)) = work.recv().await {
            let point = present
                .event
                .position()
                .map(|(x, y)| (x / 1280.0, y / 720.0));
            if let Some(mut message) = cursor.update(present, point, &endpoint) {
                let previous = updates.borrow();
                if message["epoch"] == previous["epoch"]
                    && message["sprite"].is_null()
                    && !previous["sprite"].is_null()
                {
                    message["sprite"] = previous["sprite"].clone();
                }
                drop(previous);
                updates.send_replace(message);
            }
        }
        anyhow::bail!("Browser fixture presentation ended.")
    };
    tokio::select! {
        result = check(borrowed, lease.stopped, event) => result,
        result = observe => result,
    }
}
