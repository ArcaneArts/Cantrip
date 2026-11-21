use super::{Endpoint, FrameSource, Route, Shared, accepted, agent, id, profile};
use crate::{
    http::checked,
    protected_content::{
        open_private_state, open_remote_surface, protect_private_state, protect_remote_surface,
    },
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_browser::{Event, Page, Subscription};
use cantrip_framing::remote_surface::{self, Frame};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) struct Session {
    shared: Arc<Shared>,
    endpoint: Arc<Endpoint>,
    lease: Option<profile::Lease>,
    profile_id: JsString,
    surface: JsString,
    owner: JsString,
    server: Value,
    project: Value,
    stored: Location,
    current_url: JsString,
    attachments: HashMap<JsString, Attachment>,
    viewport: Value,
    loading: bool,
    suspended: bool,
    operations: VecDeque<JsString>,
    cursor: JsString,
    agent_cursor: agent::Cursor,
    agent_lease: agent::Lease,
    last_cursor: Option<Instant>,
}

#[derive(PartialEq)]
struct Location {
    revision: u64,
    url: JsString,
}

struct Attachment {
    viewport: Value,
    route: Arc<Route>,
    incoming: Option<u64>,
    outgoing: HashMap<&'static str, u64>,
}

pub(super) type Opening = Pin<Box<dyn Future<Output = Result<profile::Lease>> + Send>>;

impl Session {
    pub fn new(
        shared: Arc<Shared>,
        endpoint: Arc<Endpoint>,
        surface: JsString,
        command: &Value,
        epoch: u64,
    ) -> Result<Self> {
        let (owner, server) = shared.encryption.bound_identity()?;
        ensure!(
            server == command["serverId"],
            "Browser command has the wrong server binding."
        );
        ensure!(
            shared.outgoing.stream_current(epoch),
            "Browser command socket expired."
        );
        let stored = location(&shared, &owner, &surface, command)?;
        let profile_id = profile_id(command, &surface);
        let current_url = stored.url.clone();
        Ok(Self {
            shared,
            endpoint,
            lease: None,
            profile_id,
            surface,
            owner,
            server,
            stored,
            current_url,
            project: command["projectId"].clone(),
            attachments: HashMap::new(),
            viewport: command["viewport"].clone(),
            loading: true,
            suspended: false,
            operations: VecDeque::new(),
            cursor: "default".into(),
            agent_cursor: agent::Cursor::default(),
            agent_lease: agent::Lease::new(),
            last_cursor: None,
        })
    }

    pub fn open_after(&self, delay: Duration, retired: Option<profile::Lease>) -> Opening {
        let shared = self.shared.clone();
        let identity = self.profile_id.clone();
        let viewport = (
            self.viewport["width"].as_u64().unwrap() as u32,
            self.viewport["height"].as_u64().unwrap() as u32,
        );
        Box::pin(async move {
            if let Some(old) = retired {
                old.close().await;
            }
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            shared.profiles.open(&identity, viewport).await
        })
    }

    pub async fn activate(
        &mut self,
        lease: profile::Lease,
        initial_epoch: Option<u64>,
    ) -> Result<Subscription> {
        let events = lease.page.subscribe();
        self.lease = Some(lease);
        ensure!(
            self.lease.as_ref().unwrap().identity == self.profile_id,
            "Browser profile changed while Chromium was starting."
        );
        if let Some(epoch) = initial_epoch {
            self.authorize(epoch)?;
        } else {
            self.authorize_endpoint()?;
        }
        self.request("Page.enable", json!({})).await?;
        self.request("Runtime.enable", json!({})).await?;
        self.request("Inspector.enable", json!({})).await?;
        self.configure_viewport(&self.viewport.clone(), true)
            .await?;
        // A page can be restored even if the last site is temporarily unavailable.
        let navigation = self.navigate(self.current_url.clone()).await;
        if initial_epoch.is_some() || !self.page()?.is_connected() {
            navigation?;
        }
        self.cursor = "default".into();
        self.agent_lease.close();
        self.agent_lease = agent::Lease::new();
        self.agent_cursor = agent::Cursor::default();
        self.last_cursor = None;
        self.send_cursor_state(None);
        self.runtime_status(None);
        Ok(events)
    }

    pub fn retire(&mut self) -> Option<profile::Lease> {
        self.agent_lease.close();
        self.agent_cursor = agent::Cursor::default();
        self.send_cursor_state(None);
        let lease = self.lease.take();
        self.loading = true;
        lease
    }

    pub fn recovering(&mut self) {
        self.runtime_status(None);
    }

    pub async fn resync(&mut self) {
        let _ = self.publish_state(None).await;
        let _ = self.screenshot(None).await;
    }

    fn page(&self) -> Result<&Page> {
        self.lease
            .as_ref()
            .map(|lease| &lease.page)
            .context("Browser runtime is reconnecting.")
    }

    pub async fn close(mut self) {
        self.agent_lease.close();
        self.attachments.clear();
        if let Some(lease) = self.lease.take() {
            lease.close().await;
        }
    }

    fn authorize_endpoint(&self) -> Result<()> {
        let identity = self
            .shared
            .encryption
            .bound_component("surface-private-state", None)?;
        ensure!(
            self.owner == identity.owner_id && self.server == identity.server_id,
            "Browser session authority changed."
        );
        Ok(())
    }

    fn authorize(&self, epoch: u64) -> Result<()> {
        self.authorize_endpoint()?;
        ensure!(
            self.shared.outgoing.stream_current(epoch),
            "Browser attachment socket expired."
        );
        Ok(())
    }

    pub fn reconcile(&mut self) -> Result<()> {
        self.authorize_endpoint()?;
        self.attachments
            .retain(|_, attachment| attachment.route.alive(&self.shared.outgoing));
        Ok(())
    }

    pub async fn attach(&mut self, command: &Value, epoch: u64) -> Result<Value> {
        self.authorize(epoch)?;
        ensure!(
            command["projectId"] == self.project,
            "Browser attachment belongs to another project."
        );
        self.configure_location(command).await?;
        self.attachments
            .retain(|_, attachment| attachment.route.alive(&self.shared.outgoing));
        let attachment = id(command, "attachmentId").clone();
        ensure!(
            self.attachments.contains_key(&attachment) || self.attachments.len() < 4,
            "Remote Surface already has four active attachments."
        );
        let viewport = &command["viewport"];
        self.configure_viewport(viewport, false).await?;
        self.authorize(epoch)?;
        self.attachments
            .entry(attachment.clone())
            .and_modify(|current| current.viewport = viewport.clone())
            .or_insert_with(|| Attachment {
                viewport: viewport.clone(),
                route: self.endpoint.register(
                    attachment.clone(),
                    epoch,
                    self.owner.clone(),
                    self.server.clone(),
                ),
                incoming: None,
                outgoing: HashMap::new(),
            });
        self.refresh(&attachment).await;
        Ok(json!({"accepted":true,"transport":"websocket"}))
    }

    pub async fn refresh(&mut self, attachment: &JsString) {
        self.runtime_status(Some(attachment));
        self.send_cursor_state(Some(attachment));
        if self.lease.is_some() {
            let _ = self.publish_state(Some(attachment)).await;
            let _ = self.screenshot(Some(attachment)).await;
        }
    }

    fn runtime_status(&mut self, only: Option<&JsString>) {
        let (status, message) = if self.lease.is_some() {
            ("ready", Value::Null)
        } else {
            ("recovering", json!("Browser runtime is reconnecting."))
        };
        self.send_json(
            only,
            "control",
            &json!({"type":"browser-runtime","status":status,"message":message}),
        );
    }

    fn send_cursor_state(&mut self, only: Option<&JsString>) {
        let state = self.agent_cursor.state(false, true);
        self.send_json(only, "control", &state);
    }

    pub(super) fn agent_page(&self, target: agent::Target) -> Result<agent::AgentPage> {
        self.authorize_endpoint()?;
        ensure!(
            target.owner == self.owner
                && target.project == self.project
                && target.server == self.server
                && target.surface == self.surface,
            "The Browser target is outside this execution scope."
        );
        let page = self.page()?.clone();
        ensure!(page.is_connected(), "The selected Browser is reconnecting.");
        Ok(self
            .agent_lease
            .borrow(page, &self.endpoint, self.shared.clone(), target))
    }

    pub(super) fn present_agent(&mut self, presentation: agent::Presentation) {
        if self.agent_lease.id != presentation.lease || self.authorize_endpoint().is_err() {
            return;
        }
        let point = presentation.event.position().map(|(x, y)| {
            (
                x / self.viewport["width"].as_f64().unwrap_or(1.0),
                y / self.viewport["height"].as_f64().unwrap_or(1.0),
            )
        });
        let emitted = self
            .agent_cursor
            .update(presentation, point, &self.endpoint);
        if let Some(state) = emitted {
            self.send_json(None, "control", &state);
        }
    }

    pub async fn command(&mut self, value: &Value, epoch: u64) -> Result<Value> {
        if value["type"] == "surface.close" || value["type"] == "surface.detach" {
            ensure!(
                self.shared.outgoing.stream_current(epoch),
                "Browser command authority expired."
            );
        } else {
            self.authorize(epoch)?;
        }
        match value["type"].as_str().unwrap() {
            "surface.attach" => return self.attach(value, epoch).await,
            "surface.detach" => {
                let attachment = id(value, "attachmentId");
                if self
                    .attachments
                    .get(attachment)
                    .is_some_and(|member| member.route.closes_on(epoch))
                {
                    self.attachments.remove(attachment);
                }
            }
            "surface.configure" => self.configure_location(value).await?,
            "surface.suspend" => {
                self.suspended = true;
                if self.lease.is_some() {
                    self.request("Page.stopScreencast", json!({})).await?;
                }
            }
            "surface.resume" => {
                self.suspended = false;
                if let Some(viewport) = self
                    .attachments
                    .values()
                    .next()
                    .map(|member| member.viewport.clone())
                {
                    self.configure_viewport(&viewport, true).await?;
                }
            }
            "surface.close" => {}
            _ => bail!("Unknown browser surface command."),
        }
        Ok(accepted())
    }

    async fn configure_location(&mut self, command: &Value) -> Result<()> {
        ensure!(
            command["configuration"]["kind"] == "browser" && command["serverId"] == self.server,
            "Browser configuration authority changed."
        );
        let next = location(&self.shared, &self.owner, &self.surface, command)?;
        if next != self.stored {
            ensure!(
                next.revision >= self.stored.revision,
                "Browser configuration revision is stale."
            );
            if self.lease.is_some() {
                let history = self.history().await?;
                if active_entry(&history)
                    .is_none_or(|entry| entry["url"].as_js_string() != Some(&next.url))
                {
                    self.navigate(next.url.clone()).await?;
                }
            }
            self.current_url = next.url.clone();
            self.stored = next;
            if self.lease.is_some() {
                let _ = self.publish_state(None).await;
            }
        }
        self.profile_id = profile_id(command, &self.surface);
        Ok(())
    }

    pub async fn frame(&mut self, frame: &Frame, source: &FrameSource) -> Result<()> {
        self.authorize_endpoint()?;
        let header = frame.header();
        let id = id(header, "attachmentId");
        let sequence = header["sequence"].as_u64().unwrap();
        let attachment = self
            .attachments
            .get_mut(id)
            .context("Browser attachment is not active.")?;
        ensure!(
            attachment.route.receives(source, &self.shared.outgoing)
                && attachment.incoming.is_none_or(|last| sequence > last),
            "Browser input binding or sequence is stale."
        );
        let clear = open_remote_surface(
            &self.shared.encryption,
            &stream(
                &self.server,
                &self.surface,
                id,
                "client-to-worker",
                "control",
                sequence,
            ),
            frame.payload(),
        )?;
        let value = parse_json_text(&String::from_utf8_lossy(&clear))
            .map_err(|_| anyhow::anyhow!("Invalid browser control message JSON."))?;
        let command = checked("remoteBrowserClientMessageSchema", &value)?;
        ensure!(
            attachment.route.receives(source, &self.shared.outgoing),
            "Browser input binding expired."
        );
        attachment.incoming = Some(sequence);
        self.authorize_endpoint()?;
        self.input(id, &command).await
    }

    async fn input(&mut self, attachment: &JsString, message: &Value) -> Result<()> {
        match message["type"].as_str().unwrap() {
            "viewport" => {
                self.attachments.get_mut(attachment).unwrap().viewport =
                    message["viewport"].clone();
                self.configure_viewport(&message["viewport"], false).await?;
                if self.lease.is_some() {
                    self.publish_state(Some(attachment)).await?;
                    self.screenshot(Some(attachment)).await?;
                }
            }
            "navigate" => {
                let operation = id(message, "operationId");
                let content = open_private_state(
                    &self.shared.encryption,
                    &self.owner,
                    &private(
                        &self.server,
                        &self.surface,
                        &json!(operation),
                        "browser-operation",
                    ),
                    &message["stateProtection"],
                )?;
                let content = checked("browserPrivateStateProtectedContentSchema", &content)?;
                ensure!(
                    content["revision"].as_u64() == Some(self.stored.revision),
                    "Browser navigation revision is stale."
                );
                ensure!(
                    !self.operations.contains(operation),
                    "Browser navigation was already applied."
                );
                self.operations.push_back(operation.clone());
                if self.operations.len() > 1_000 {
                    self.operations.pop_front();
                }
                let url = id(&content, "url").clone();
                if self.lease.is_some() {
                    self.navigate(url).await?;
                } else {
                    self.current_url = url;
                }
            }
            "history" => {
                let history = self.history().await?;
                let next = history["currentIndex"].as_i64().unwrap_or(0)
                    + message["delta"].as_i64().unwrap();
                if let Some(entry) = usize::try_from(next)
                    .ok()
                    .and_then(|index| history["entries"].as_array()?.get(index))
                {
                    self.loading = true;
                    self.request(
                        "Page.navigateToHistoryEntry",
                        json!({"entryId":entry["id"]}),
                    )
                    .await?;
                }
            }
            "reload" => {
                self.loading = true;
                self.request("Page.reload", json!({})).await?;
            }
            "stop" => {
                self.request("Page.stopLoading", json!({})).await?;
                self.loading = false;
                self.publish_state(None).await?;
            }
            "pointer" => self.pointer(message).await?,
            "key" => self.key(message).await?,
            "touch" => {
                let kind = match message["event"].as_str().unwrap() {
                    "start" => "touchStart",
                    "move" => "touchMove",
                    "cancel" => "touchCancel",
                    _ => "touchEnd",
                };
                self.request(
                    "Input.dispatchTouchEvent",
                    json!({
                        "type":kind,"touchPoints":message["points"],"modifiers":message["modifiers"]
                    }),
                )
                .await?;
                if kind == "touchEnd" {
                    self.input_focus(attachment).await?;
                }
            }
            "clipboard" if message["operation"] == "paste-text" => {
                if !id(message, "text").is_empty() {
                    self.request("Input.insertText", json!({"text":message["text"]}))
                        .await?;
                }
            }
            "clipboard" => {
                let text = self
                    .page()?
                    .evaluate("String(globalThis.getSelection?.() ?? '')")
                    .await?;
                let result = checked(
                    "remoteBrowserClipboardMessageSchema",
                    &json!({
                        "type":"browser-clipboard","operation":"copy-selection","text":text
                    }),
                )?;
                self.send_json(Some(attachment), "clipboard", &result);
            }
            "focus" => {
                self.request("Page.bringToFront", json!({})).await?;
            }
            _ => bail!("Unsupported browser input."),
        }
        Ok(())
    }

    async fn pointer(&mut self, message: &Value) -> Result<()> {
        let kind = match message["event"].as_str().unwrap() {
            "move" => "mouseMoved",
            "down" => "mousePressed",
            "up" => "mouseReleased",
            _ => "mouseWheel",
        };
        self.request("Input.dispatchMouseEvent", json!({
            "type":kind,"pointerType":"mouse","x":message["x"],"y":message["y"],
            "button":message["button"],"buttons":message["buttons"],"clickCount":message["clickCount"],
            "deltaX":message["deltaX"],"deltaY":message["deltaY"],"modifiers":message["modifiers"]
        })).await?;
        if kind == "mouseMoved"
            && self
                .last_cursor
                .is_none_or(|at| at.elapsed() >= Duration::from_millis(50))
        {
            self.last_cursor = Some(Instant::now());
            let expression = format!(
                "(() => {{const node=document.elementFromPoint({},{});return node ? getComputedStyle(node).cursor : 'default'}})()",
                message["x"].stringify(),
                message["y"].stringify()
            );
            let result = self.page()?.evaluate(&expression).await?;
            let parsed = checked(
                "remoteBrowserCursorMessageSchema",
                &json!({"type":"browser-cursor","cursor":result}),
            )
            .unwrap_or_else(|_| json!({"type":"browser-cursor","cursor":"default"}));
            // Store only the bounded, validated cursor enum string.
            let next = id(&parsed, "cursor");
            if self.cursor != *next {
                self.cursor = next.clone();
                self.send_json(None, "cursor", &parsed);
            }
        }
        Ok(())
    }

    async fn key(&self, message: &Value) -> Result<()> {
        let key = message["key"].as_str().unwrap_or_default();
        let down = message["event"] == "down";
        let modifiers = message["modifiers"].as_u64().unwrap();
        let explicit = if !down || (key == "Enter" && modifiers & !8 != 0) {
            None
        } else if key == "Enter" {
            Some(json!("\r"))
        } else {
            message["text"]
                .as_js_string()
                .filter(|text| !text.is_empty())
                .map(|text| json!(text))
        };
        let kind = if !down {
            "keyUp"
        } else if explicit.is_some() {
            "keyDown"
        } else {
            "rawKeyDown"
        };
        let mut params = json!({
            "type":kind,"key":message["key"],"code":message["code"],"modifiers":message["modifiers"]
        });
        if let Some(text) = explicit {
            params["unmodifiedText"] = text.clone();
            params["text"] = text;
        }
        if let Some(code) = key_code(key) {
            params["windowsVirtualKeyCode"] = json!(code);
        }
        if key == "Enter" && message["code"] == "NumpadEnter" {
            params["isKeypad"] = json!(true);
            params["location"] = json!(3);
        }
        self.request("Input.dispatchKeyEvent", params).await?;
        Ok(())
    }

    async fn input_focus(&mut self, attachment: &JsString) -> Result<()> {
        let editable = self.page()?.evaluate(
            "(() => {const e=document.activeElement;if(!(e instanceof HTMLElement))return false;if(e instanceof HTMLTextAreaElement)return !e.disabled&&!e.readOnly;if(e instanceof HTMLInputElement)return !e.disabled&&!e.readOnly&&!['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(e.type);return e.isContentEditable})()"
        ).await.ok().and_then(|value| value.as_bool()).unwrap_or(false);
        self.send_json(
            Some(attachment),
            "control",
            &json!({"type":"browser-input-focus","editable":editable}),
        );
        Ok(())
    }

    async fn navigate(&mut self, url: JsString) -> Result<()> {
        self.loading = true;
        match self.request("Page.navigate", json!({"url":url})).await {
            Ok(reply) => {
                // Chromium can commit a browser error page on network failure.
                // Keep the viewer attached so it can show that page and retry.
                if !reply["errorText"].is_null() {
                    self.loading = false;
                }
                Ok(())
            }
            Err(_) => {
                self.loading = false;
                bail!("Chromium could not navigate to the browser location.")
            }
        }
    }

    async fn configure_viewport(&mut self, viewport: &Value, restart: bool) -> Result<()> {
        if !restart && self.viewport == *viewport {
            return Ok(());
        }
        self.viewport = viewport.clone();
        if self.lease.is_none() {
            return Ok(());
        }
        self.request(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width":viewport["width"],"height":viewport["height"],
                "deviceScaleFactor":viewport["devicePixelRatio"],"mobile":false
            }),
        )
        .await?;
        self.request(
            "Emulation.setTouchEmulationEnabled",
            json!({"enabled":true,"maxTouchPoints":10}),
        )
        .await?;
        let _ = self.request("Page.stopScreencast", json!({})).await;
        if !self.suspended {
            self.request("Page.startScreencast", json!({
                "format":"jpeg","quality":78,"maxWidth":viewport["width"],"maxHeight":viewport["height"],"everyNthFrame":1
            })).await?;
        }
        Ok(())
    }

    pub async fn event(&mut self, event: Event) {
        match event.method() {
            "Page.screencastFrame" => {
                let params = event.params();
                let _ = self
                    .request(
                        "Page.screencastFrameAck",
                        json!({"sessionId":params["sessionId"]}),
                    )
                    .await;
                if !self.suspended
                    && let Some(data) = params["data"].as_str()
                    && let Ok(bytes) = STANDARD.decode(data)
                {
                    self.send(None, "frame", &bytes);
                }
            }
            "Page.frameStartedLoading" => {
                self.loading = true;
                let _ = self.publish_state(None).await;
            }
            "Page.frameStoppedLoading" | "Page.loadEventFired" => {
                self.loading = false;
                let _ = self.publish_state(None).await;
                let _ = self.screenshot(None).await;
            }
            "Page.frameNavigated" if event.params()["frame"]["parentId"].is_null() => {
                if !self.suspended {
                    let _ = self.configure_viewport(&self.viewport.clone(), true).await;
                }
                let _ = self.publish_state(None).await;
            }
            "Page.navigatedWithinDocument" => {
                let _ = self.publish_state(None).await;
            }
            _ => {}
        }
    }

    async fn history(&self) -> Result<Value> {
        self.request("Page.getNavigationHistory", json!({})).await
    }

    async fn publish_state(&mut self, only: Option<&JsString>) -> Result<()> {
        let history = self.history().await?;
        let Some(entry) = active_entry(&history) else {
            return Ok(());
        };
        // Restore only a location Chromium actually committed, using the same
        // validation as the encrypted browser state sent to clients.
        let content = checked(
            "browserPrivateStateProtectedContentSchema",
            &json!({"version":1,"classification":json!({"recordKind":"browser-state"}),
                "revision":self.stored.revision,"url":entry["url"]}),
        )?;
        self.current_url = id(&content, "url").clone();
        if self.attachments.is_empty() {
            return Ok(());
        }
        let operation = json!(uuid::Uuid::new_v4().to_string());
        let protected = protect_private_state(
            &self.shared.encryption,
            &self.owner,
            &private(&self.server, &self.surface, &operation, "browser-operation"),
            &content,
        )?;
        let title = entry["title"]
            .as_js_string()
            .map(|text| JsString::new(text.units().iter().take(2_000).copied().collect()))
            .unwrap_or_else(|| "".into());
        let index = history["currentIndex"].as_u64().unwrap_or(0);
        let count = history["entries"]
            .as_array()
            .map_or(0, |entries| entries.len() as u64);
        let message = checked(
            "remoteBrowserServerMessageSchema",
            &json!({
                "type":"browser-state","operationId":operation,"stateProtection":protected,
                "title":title,"canGoBack":index > 0,"canGoForward":index + 1 < count,"loading":self.loading
            }),
        )?;
        self.send_json(only, "control", &message);
        Ok(())
    }

    async fn screenshot(&mut self, only: Option<&JsString>) -> Result<()> {
        if self.suspended || self.attachments.is_empty() {
            return Ok(());
        }
        let screenshot = self
            .request(
                "Page.captureScreenshot",
                json!({
                    "format":"jpeg","quality":78,"fromSurface":true,"captureBeyondViewport":false,
                }),
            )
            .await?;
        let data = STANDARD.decode(
            screenshot["data"]
                .as_str()
                .context("Chromium returned no browser frame.")?,
        )?;
        self.send(only, "frame", &data);
        Ok(())
    }

    fn send_json(&mut self, only: Option<&JsString>, channel: &'static str, value: &Value) {
        self.send(only, channel, value.stringify().as_bytes());
    }

    fn send(&mut self, only: Option<&JsString>, channel: &'static str, data: &[u8]) {
        let encryption = &self.shared.encryption;
        let outgoing = &self.shared.outgoing;
        let matches_owner = || {
            encryption
                .bound_identity()
                .is_ok_and(|(owner, server)| owner == self.owner && server == self.server)
        };
        if !matches_owner() {
            return;
        }
        for (id, member) in &mut self.attachments {
            if only.is_some_and(|chosen| chosen != id) || !member.route.alive(outgoing) {
                continue;
            }
            let position = member.outgoing.entry(channel).or_default();
            let binding = stream(
                &self.server,
                &self.surface,
                id,
                "worker-to-client",
                channel,
                *position,
            );
            let result = protect_remote_surface(encryption, &binding, data).and_then(|payload| {
                remote_surface::create(json!({
                    "protocolVersion":1,"surfaceId":self.surface,"attachmentId":id,"sequence":*position,"channel":channel
                }), &payload)
            });
            if let Ok(frame) = result
                && matches_owner()
                && member.route.emit(frame, outgoing)
            {
                *position += 1;
            }
        }
    }

    async fn request(&self, method: &str, value: Value) -> Result<Value> {
        self.page()?.request(method, value).await
    }
}

fn profile_id(command: &Value, surface: &JsString) -> JsString {
    command["configuration"]["profileId"]
        .as_js_string()
        .unwrap_or(surface)
        .clone()
}

fn location(
    shared: &Shared,
    owner: &JsString,
    surface: &JsString,
    command: &Value,
) -> Result<Location> {
    let resource = command["stateResource"]
        .as_str()
        .context("Browser configuration resource is missing.")?;
    ensure!(
        matches!(resource, "browser-row" | "browser-remote-surface"),
        "Browser configuration resource is invalid."
    );
    let opened = open_private_state(
        &shared.encryption,
        owner,
        &private(&command["serverId"], surface, &Value::Null, resource),
        &command["stateProtection"],
    )?;
    let checked = checked("browserPrivateStateProtectedContentSchema", &opened)?;
    ensure!(
        checked["revision"] == command["stateRevision"],
        "Browser configuration revision is stale."
    );
    Ok(Location {
        revision: checked["revision"].as_u64().unwrap(),
        url: id(&checked, "url").clone(),
    })
}

fn stream(
    server: &Value,
    surface: &JsString,
    attachment: &JsString,
    direction: &str,
    channel: &str,
    sequence: u64,
) -> Value {
    json!({"serverId":server,"surfaceKind":"browser","surfaceId":surface,
        "attachmentId":attachment,"direction":direction,"channel":channel,"sequence":sequence})
}

fn private(server: &Value, surface: &JsString, operation: &Value, resource: &str) -> Value {
    json!({"serverId":server,"resource":resource,"resourceId":surface,
        "operationId":operation,"recordKind":"browser-state"})
}

fn active_entry(history: &Value) -> Option<&Value> {
    let index = history["currentIndex"].as_u64()? as usize;
    history["entries"].as_array()?.get(index)
}

fn key_code(key: &str) -> Option<u16> {
    Some(match key {
        "Backspace" => 8,
        "Tab" => 9,
        "Enter" => 13,
        "Escape" => 27,
        " " => 32,
        "PageUp" => 33,
        "PageDown" => 34,
        "End" => 35,
        "Home" => 36,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "Delete" => 46,
        _ => return None,
    })
}
