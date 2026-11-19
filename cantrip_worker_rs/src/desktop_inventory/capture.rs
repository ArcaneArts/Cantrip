//! Target generation and capture binding are owned by the helper process.
use super::{
    DEADLINE, Helper, NativeError, helper, public_target_id, read_targets, retire, target_id,
};
use crate::{connection::Outbound, encryption::Service};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_interaction::geometry::{MAX_IMAGE_PIXELS, MAX_SEQUENCE};
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;
use tokio::{
    sync::{mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Scope {
    pub(super) epoch: u64,
    owner: JsString,
    server: Value,
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

    fn authorize(&self, encryption: &Service, outgoing: &Outbound) -> Result<()> {
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
            Self { requests, releases },
            Operations {
                requests: input,
                releases: cleanup,
            },
        )
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
    generation: Uuid,
    binding: Value,
    handle: u64,
    target: Value,
}

pub(crate) struct Capture {
    key: Option<Key>,
    client: Captures,
}

pub(crate) struct Frame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) png: Vec<u8>,
}

impl Capture {
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
            let _ = self.client.releases.send(Release { key, reply });
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.release(None);
    }
}

pub(super) struct Release {
    key: Key,
    reply: Option<oneshot::Sender<()>>,
}

impl Release {
    pub(super) async fn close(self, current: &mut Option<Helper>) {
        if let Some(helper) = current
            .as_mut()
            .filter(|helper| helper.identity == self.key.generation)
        {
            let result = helper
                .process
                .request(json!({
                    "operation":"capture.request",
                    "request":json!({"type":"closeBinding","binding":self.key.binding})
                }))
                .await;
            if result.is_err() {
                retire(current).await;
            }
        }
        if let Some(reply) = self.reply {
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
    Frame {
        key: Key,
        reply: oneshot::Sender<Result<Frame>>,
    },
}

impl Operation {
    pub(super) fn scope(&self) -> &Scope {
        match self {
            Self::Open { scope, .. } => scope,
            Self::Frame { key, .. } => &key.scope,
        }
    }

    pub(super) fn expired(self) {
        match self {
            Self::Open { reply, .. } => {
                let _ = reply.send(Err(anyhow!("The desktop capture authority expired.")));
            }
            Self::Frame { reply, .. } => {
                let _ = reply.send(Err(anyhow!("The desktop capture authority expired.")));
            }
        }
    }

    pub(super) async fn execute(
        self,
        current: &mut Option<Helper>,
        binary: &Path,
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
    binary: &Path,
    encryption: &Service,
    scope: Scope,
    requested: Value,
) -> Result<Key> {
    let helper = helper(current, binary).await?;
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
    Ok(Frame { width, height, png })
}
