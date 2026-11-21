//! Target generation and capture binding are owned by the helper process.
use super::{
    DEADLINE, Helper, NativeError, helper, public_target_id, read_targets, retire, target_id,
};
use crate::{connection::Outbound, encryption::Service};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_interaction::geometry::{MAX_IMAGE_PIXELS, MAX_SEQUENCE};
use cantrip_wire::{JsString, Value, value::json};
use std::{path::Path, sync::Arc};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Scope {
    pub(super) epoch: u64,
    owner: JsString,
    pub(super) server: Value,
    surface: JsString,
}

impl Scope {
    pub(crate) fn new(epoch: u64, owner: JsString, server: Value, surface: JsString) -> Self {
        Self {
            epoch,
            owner,
            server,
            surface,
        }
    }

    pub(super) fn authorize(&self, encryption: &Service, outgoing: &Outbound) -> Result<()> {
        let bound = encryption.bound_component("surface-private-state", None)?;
        ensure!(
            bound.owner_id == self.owner
                && bound.server_id == self.server
                && outgoing.stream_current(self.epoch),
            "The desktop capture authority expired."
        );
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Captures {
    requests: mpsc::Sender<Operation>,
    releases: mpsc::UnboundedSender<Release>,
    control: Option<ControlConnection>,
}

#[derive(Clone)]
struct ControlConnection {
    state: watch::Receiver<Option<ControlState>>,
    requests: mpsc::Sender<TakeControl>,
}

pub(super) struct TakeControl {
    pub(super) generation: Uuid,
    pub(super) lease: Uuid,
    pub(super) allowed: InputAuthority,
    pub(super) reply: oneshot::Sender<Result<()>>,
}

#[derive(Clone, PartialEq)]
pub(crate) struct ControlState {
    pub(crate) id: Uuid,
    pub(crate) switching: bool,
}

pub(super) struct Operations {
    pub(super) requests: mpsc::Receiver<Operation>,
    pub(super) releases: mpsc::UnboundedReceiver<Release>,
}

impl Captures {
    pub(super) fn channel() -> (Self, Operations) {
        let (requests, input) = mpsc::channel(4);
        // Each owned lease can enqueue exactly one release. A release never
        // needs capacity in the normal frame queue.
        let (releases, cleanup) = mpsc::unbounded_channel();
        (
            Self {
                requests,
                releases,
                control: None,
            },
            Operations {
                requests: input,
                releases: cleanup,
            },
        )
    }

    pub(super) fn with_control(
        mut self,
        state: watch::Receiver<Option<ControlState>>,
        requests: mpsc::Sender<TakeControl>,
    ) -> Self {
        self.control = Some(ControlConnection { state, requests });
        self
    }

    pub(crate) async fn open(&self, scope: Scope, target: Value) -> Result<Capture> {
        let (reply, result) = oneshot::channel();
        self.requests
            .send(Operation::Open {
                scope,
                target,
                client: self.clone(),
                reply,
            })
            .await
            .context("Desktop capture service stopped.")?;
        result.await.context("Desktop capture service stopped.")?
    }
}

#[derive(Clone)]
pub(super) struct Key {
    scope: Scope,
    pub(super) generation: Uuid,
    binding: Value,
    handle: u64,
    target: Value,
}

pub(crate) struct Capture {
    key: Option<Key>,
    client: Captures,
}

pub(crate) type InputAuthority = Arc<dyn Fn() -> bool + Send + Sync>;

pub(crate) struct Frame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) png: Vec<u8>,
    pub(crate) logical: (f64, f64),
}

impl Capture {
    pub(crate) fn is_window(&self) -> bool {
        self.key.as_ref().unwrap().target["kind"] == "window"
    }

    pub(crate) fn control_state(&self) -> Option<ControlState> {
        self.client.control.as_ref()?.state.borrow().clone()
    }

    pub(crate) fn guest_control(&self) -> Result<GuestControl> {
        ensure!(
            self.client.control.is_some(),
            "Global desktop input requires the assigned guest."
        );
        Ok(GuestControl {
            key: self.key.as_ref().unwrap().clone(),
            client: self.client.clone(),
            id: Uuid::new_v4(),
        })
    }

    pub(crate) fn participant(
        &self,
        worker: &JsString,
        attachment: &JsString,
        input_epoch: &str,
        allowed: InputAuthority,
        control: Option<&GuestControl>,
    ) -> Participant {
        let key = self.key.as_ref().unwrap().clone();
        Participant {
            binding: Some(json!({
                "workerId":worker,"surfaceId":key.scope.surface,"attachmentId":input_epoch,"participantId":attachment
            })),
            client: self.client.clone(),
            key,
            allowed,
            control: control.map(|lease| lease.id),
            handle: 0,
        }
    }

    pub(crate) async fn frame(&self) -> Result<Frame> {
        let (reply, result) = oneshot::channel();
        self.client
            .requests
            .send(Operation::Frame {
                key: self.key.as_ref().unwrap().clone(),
                reply,
            })
            .await
            .context("Desktop capture service stopped.")?;
        result.await.context("Desktop capture service stopped.")?
    }

    pub(crate) async fn close(mut self) {
        let (reply, result) = oneshot::channel();
        self.release(Some(reply));
        let _ = result.await;
    }

    fn release(&mut self, reply: Option<oneshot::Sender<()>>) {
        if let Some(key) = self.key.take() {
            let _ = self.client.releases.send(Release::Binding {
                generation: key.generation,
                binding: key.binding,
                operation: "capture.request",
                reply,
            });
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.release(None);
    }
}

pub(crate) struct GuestControl {
    key: Key,
    client: Captures,
    pub(crate) id: Uuid,
}

impl GuestControl {
    pub(crate) async fn take(&self, allowed: InputAuthority) -> Result<()> {
        let (reply, result) = oneshot::channel();
        self.client
            .control
            .as_ref()
            .expect("Guest control connection")
            .requests
            .send(TakeControl {
                generation: self.key.generation,
                lease: self.id,
                allowed,
                reply,
            })
            .await
            .context("Linux desktop control stopped.")?;
        result.await.context("Linux desktop control stopped.")?
    }
}

impl Drop for GuestControl {
    fn drop(&mut self) {
        let _ = self.client.releases.send(Release::Control(self.id));
    }
}

pub(crate) struct Participant {
    key: Key,
    client: Captures,
    binding: Option<Value>,
    allowed: InputAuthority,
    control: Option<Uuid>,
    handle: u64,
}

impl Participant {
    pub(crate) async fn open(&mut self) -> Result<Value> {
        ensure!(
            self.key.target["kind"] == "window" || self.control.is_some(),
            "Host displays are view-only."
        );
        let result = self
            .request(
                "open",
                [
                    ("targetId", self.key.target["id"].clone()),
                    ("targetGeneration", self.key.target["generation"].clone()),
                ],
            )
            .await?;
        ensure!(
            same_target(&self.key.target, &result["target"]),
            "The desktop participant opened another target."
        );
        self.handle = result["handle"]
            .as_u64()
            .filter(|handle| (1..=MAX_SEQUENCE).contains(handle))
            .context("Invalid desktop input participant handle.")?;
        Ok(result["sprite"].clone())
    }

    async fn request<const N: usize>(
        &self,
        kind: &str,
        fields: [(&str, Value); N],
    ) -> Result<Value> {
        let (reply, result) = oneshot::channel();
        let mut request = json!({"type":kind,"binding":self.binding.as_ref().unwrap()});
        if self.handle != 0 {
            request["handle"] = json!(self.handle);
        }
        for (name, value) in fields {
            request[name] = value;
        }
        self.client
            .requests
            .send(Operation::Interaction {
                key: self.key.clone(),
                request,
                allowed: self.allowed.clone(),
                control: self.control,
                reply,
            })
            .await
            .context("Desktop input service stopped.")?;
        result.await.context("Desktop input service stopped.")?
    }

    pub(crate) async fn clipboard(&self) -> Result<JsString> {
        ensure!(
            self.control.is_some(),
            "Clipboard access requires the assigned guest."
        );
        self.request("clipboardRead", []).await?["text"]
            .as_js_string()
            .cloned()
            .context("Invalid desktop clipboard response.")
    }

    pub(crate) async fn input(
        &self,
        sequence: u64,
        event: &cantrip_interaction::input::InputEvent,
    ) -> Result<()> {
        let event = Value::from_serialize(event);
        let receipt = self
            .request("input", [("sequence", json!(sequence)), ("event", event)])
            .await?;
        ensure!(
            receipt["handle"].as_u64() == Some(self.handle)
                && receipt["sequence"].as_u64() == Some(sequence)
                && receipt["outcome"] == "dispatched",
            "Invalid desktop input receipt."
        );
        Ok(())
    }

    pub(crate) async fn close(mut self) {
        let (reply, closed) = oneshot::channel();
        self.release(Some(reply));
        let _ = closed.await;
    }

    fn release(&mut self, reply: Option<oneshot::Sender<()>>) {
        // The unique binding also closes an open whose response was canceled.
        if let Some(binding) = self.binding.take() {
            let _ = self.client.releases.send(Release::Binding {
                generation: self.key.generation,
                binding,
                operation: "interaction.request",
                reply,
            });
        }
    }
}

impl Drop for Participant {
    fn drop(&mut self) {
        self.release(None);
    }
}

pub(super) enum Release {
    Binding {
        generation: Uuid,
        binding: Value,
        operation: &'static str,
        reply: Option<oneshot::Sender<()>>,
    },
    Control(Uuid),
}

impl Release {
    pub(super) async fn close(self, current: &mut Option<Helper>) {
        let Self::Binding {
            generation,
            binding,
            operation,
            reply,
        } = self
        else {
            return;
        };
        if let Some(helper) = current
            .as_mut()
            .filter(|helper| helper.identity == generation)
        {
            let result = helper
                .process
                .request(json!({
                    "operation":operation,
                    "request":json!({"type":"closeBinding","binding":binding})
                }))
                .await;
            if !result.is_ok_and(|value| value["closed"] == true) {
                retire(current).await;
            }
        }
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
    }
}

pub(super) enum Operation {
    Open {
        scope: Scope,
        target: Value,
        client: Captures,
        reply: oneshot::Sender<Result<Capture>>,
    },
    Interaction {
        key: Key,
        request: Value,
        allowed: InputAuthority,
        control: Option<Uuid>,
        reply: oneshot::Sender<Result<Value>>,
    },
    Frame {
        key: Key,
        reply: oneshot::Sender<Result<Frame>>,
    },
}

impl Operation {
    pub(super) fn scope(&self) -> &Scope {
        match self {
            Self::Open { scope, .. } => scope,
            Self::Frame { key, .. } | Self::Interaction { key, .. } => &key.scope,
        }
    }

    pub(super) fn expired(self) {
        match self {
            Self::Open { reply, .. } => {
                let _ = reply.send(Err(anyhow!("The desktop capture authority expired.")));
            }
            Self::Interaction { reply, .. } => {
                let _ = reply.send(Err(anyhow!("The desktop input authority expired.")));
            }
            Self::Frame { reply, .. } => {
                let _ = reply.send(Err(anyhow!("The desktop capture authority expired.")));
            }
        }
    }

    pub(super) async fn execute(
        self,
        current: &mut Option<Helper>,
        binary: Option<&Path>,
        encryption: &Service,
        outgoing: &Outbound,
    ) -> Result<()> {
        if self.scope().authorize(encryption, outgoing).is_err() {
            self.expired();
            return Ok(());
        }
        // A native operation error is an authoritative response. A partial
        // frame or late response makes the ordered pipe unusable.
        let retire =
            |error: &anyhow::Error| !error.is::<NativeError>() && !error.is::<Unavailable>();
        let broken = match self {
            Self::Open {
                scope,
                target,
                client,
                reply,
            } => {
                if reply.is_closed() {
                    return Ok(());
                }
                let result = timeout(DEADLINE, open(current, binary, encryption, scope, target))
                    .await
                    .context("Desktop capture opening timed out.")
                    .and_then(|result| result)
                    .map(|key| Capture {
                        key: Some(key),
                        client,
                    });
                let broken = result.as_ref().is_err_and(retire);
                let _ = reply.send(result);
                broken
            }
            Self::Interaction {
                key,
                request,
                allowed,
                mut reply,
                ..
            } => {
                if reply.is_closed() || !allowed() {
                    let _ = reply.send(Err(anyhow!("The desktop input authority expired.")));
                    return Ok(());
                }
                let result = timeout(DEADLINE, async {
                    let helper = current
                        .as_mut()
                        .filter(|helper| helper.identity == key.generation)
                        .ok_or(Unavailable("The desktop input helper was replaced."))?;
                    helper
                        .process
                        .interaction(request, async { reply.closed().await })
                        .await
                })
                .await
                .context("Desktop input timed out.")
                .and_then(|result| result);
                let broken = result.as_ref().is_err_and(retire);
                let _ = reply.send(result);
                broken
            }
            Self::Frame { key, reply } => {
                if reply.is_closed() {
                    return Ok(());
                }
                let result = timeout(DEADLINE, frame(current, &key))
                    .await
                    .context("Desktop frame timed out.")
                    .and_then(|result| result)
                    .and_then(|frame| key.scope.authorize(encryption, outgoing).map(|()| frame));
                let broken = result.as_ref().is_err_and(retire);
                let _ = reply.send(result);
                broken
            }
        };
        ensure!(!broken, "Desktop capture helper requires retirement.");
        Ok(())
    }
}

#[derive(Debug)]
struct Unavailable(&'static str);

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Unavailable {}

async fn open(
    current: &mut Option<Helper>,
    binary: Option<&Path>,
    encryption: &Service,
    scope: Scope,
    requested: Value,
) -> Result<Key> {
    let helper = match binary {
        Some(binary) => helper(current, binary).await?,
        None => current.as_mut().ok_or(Unavailable(
            "The captured Linux desktop connection retired.",
        ))?,
    };
    let (targets, _) = read_targets(&mut helper.process).await?;
    let selected = select(&targets, &requested)?;
    let target_id = target_id(selected)?;
    let target_generation = selected["generation"]
        .as_u64()
        .filter(|generation| (1..=MAX_SEQUENCE).contains(generation))
        .context("Invalid desktop target generation.")?;
    let attachment = Uuid::new_v4().to_string();
    let binding = json!({
        "workerId":encryption.worker_id(),"surfaceId":scope.surface,
        "attachmentId":attachment,"participantId":"capture"
    });
    let response = helper.process.request(json!({
        "operation":"capture.request",
        "request":json!({
            "type":"open","binding":binding,"targetId":target_id,"targetGeneration":target_generation
        })
    })).await?;
    let handle = response["handle"]
        .as_u64()
        .filter(|handle| (1..=MAX_SEQUENCE).contains(handle))
        .context("Invalid desktop capture lease handle.")?;
    let target = &response["target"];
    ensure!(
        same_target(selected, target),
        "The desktop capture opened another target."
    );
    Ok(Key {
        scope,
        generation: helper.identity,
        binding,
        handle,
        target: target.clone(),
    })
}

fn select<'a>(targets: &'a [Value], requested: &Value) -> Result<&'a Value> {
    for target in targets {
        if target["kind"] != requested["kind"] {
            continue;
        }
        let id = target_id(target)?;
        let labels_match = |native: &str, desired: &str| {
            requested[desired]
                .as_js_string()
                .filter(|value| !value.is_empty())
                .is_none_or(|value| {
                    target[native]
                        .as_js_string()
                        .is_some_and(|label| label.lowercase() == value.lowercase())
                })
        };
        let matched = if let Some(requested) = requested["id"].as_str() {
            public_target_id(id) == requested
        } else if requested["kind"] == "window" {
            labels_match("application", "application") && labels_match("title", "title")
        } else {
            labels_match("title", "name")
        };
        if matched {
            return Ok(target);
        }
    }
    Err(Unavailable("Requested capture target is unavailable.").into())
}

fn same_target(expected: &Value, actual: &Value) -> bool {
    ["id", "generation", "kind", "processId"]
        .iter()
        .all(|field| expected[*field] == actual[*field])
}

async fn frame(current: &mut Option<Helper>, key: &Key) -> Result<Frame> {
    let Some(helper) = current
        .as_mut()
        .filter(|helper| helper.identity == key.generation)
    else {
        bail!(Unavailable("The desktop capture helper was replaced."));
    };
    let (response, png) = helper
        .process
        .frame(json!({
            "operation":"capture.request",
            "request":json!({"type":"frame","binding":key.binding,"handle":key.handle})
        }))
        .await?;
    ensure!(
        response["handle"].as_u64() == Some(key.handle)
            && same_target(&key.target, &response["target"]),
        "The desktop frame has the wrong lease or target."
    );
    let image = &response["image"];
    let dimension = |name| {
        image[name]
            .as_u64()
            .filter(|&size| (1..=16_384).contains(&size))
            .map(|size| size as u32)
            .context("Invalid desktop capture dimensions.")
    };
    let width = dimension("width")?;
    let height = dimension("height")?;
    ensure!(
        u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS as u64
            && image["mediaType"] == "image/png"
            && image["cursorIncluded"] == false,
        "Invalid desktop capture image metadata."
    );
    let bounds = &response["target"]["bounds"];
    let logical = |name| {
        bounds[name]
            .as_f64()
            .filter(|size| size.is_finite() && *size > 0.0)
            .context("Invalid desktop target bounds.")
    };
    Ok(Frame {
        width,
        height,
        png,
        logical: (logical("width")?, logical("height")?),
    })
}
