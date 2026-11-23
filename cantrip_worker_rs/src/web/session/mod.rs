//! Interactive research sessions and their chat-scoped ownership.
mod page;
mod visible;
pub(super) use visible::Visible;
#[cfg(test)]
pub(crate) use visible::test_visible;

use super::{Scope, Service, normalize, opaque, render, scope};
use anyhow::{Context, Result, bail, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    time::{Instant, timeout},
};
use url::Url;

const TTL: Duration = Duration::from_secs(15 * 60);
const NAVIGATION: Duration = Duration::from_secs(30);
const OPERATION: Duration = Duration::from_secs(25);

pub(crate) const TOOLS: [(&str, &str); 6] = [
    ("web.session.open", "web_session_open"),
    ("web.session.snapshot", "web_session_snapshot"),
    ("web.session.click", "web_session_click"),
    ("web.session.type", "web_session_type"),
    ("web.session.pointer", "web_session_pointer"),
    ("web.session.close", "web_session_close"),
];

#[derive(Default)]
pub(super) struct Sessions {
    records: Mutex<HashMap<String, Arc<Session>>>,
}

struct Session {
    scope: Scope,
    mailbox: mpsc::Sender<Command>,
    busy: Arc<Semaphore>,
}

struct Command {
    request: Request,
    lane: watch::Receiver<bool>,
    reply: oneshot::Sender<Result<Value>>,
    _permit: OwnedSemaphorePermit,
}

enum Request {
    Navigate(Url),
    Snapshot(usize),
    Click(String),
    Type(String, Value, bool),
    Close,
}

impl Service {
    pub(crate) fn has_sessions(&self) -> bool {
        self.renderer.is_some() || self.has_visible_browsers()
    }

    pub(crate) async fn session(
        self: &Arc<Self>,
        operation: &str,
        binding: &Value,
        args: Option<&Value>,
        lane: watch::Receiver<bool>,
    ) -> Result<Value> {
        ensure!(
            self.has_sessions(),
            "The managed browser session runtime is unavailable."
        );
        ensure!(
            binding["contextKind"] == "project" && binding["permissionProfileId"] != ":read-only",
            "This MCP binding does not allow browser sessions."
        );
        ensure!(
            !*lane.borrow(),
            "Browser operation stopped with its agent turn."
        );
        let (operation, tool) = TOOLS
            .iter()
            .find(|(name, _)| *name == operation)
            .copied()
            .context("This web session operation is unavailable.")?;
        let args =
            mcp_host::parse(&format!("mcpStdioInput/{tool}"), args).map_err(response_error)?;
        let scope = scope(binding)?;
        let id = args["sessionId"].as_str();
        if let Some(id) = id {
            if let Some(result) = self
                .session_on_visible(&scope, id, operation, &args, lane.clone())
                .await?
            {
                return Ok(result);
            }
        }
        let mutating = operation != "web.session.snapshot";
        let (id, summary, data) = match operation {
            "web.session.open" => {
                ensure!(
                    args.get("browserTarget").is_none(),
                    "Opening a session on a visible Browser target is unavailable on this worker."
                );
                let target = normalize(Url::parse(&args["url"].as_js_string().unwrap().lossy())?)?;
                if let Some(id) = id {
                    let data = self
                        .sessions
                        .call(scope, id, Request::Navigate(target), lane)
                        .await?;
                    (id.to_owned(), "Navigated web session", data)
                } else {
                    let (id, data) = self.open_session(scope, target, lane).await?;
                    (id, "Opened web session", data)
                }
            }
            "web.session.snapshot" => {
                let id = id.unwrap();
                let data = self
                    .sessions
                    .call(
                        scope,
                        id,
                        Request::Snapshot(args["maxChars"].as_u64().unwrap() as usize),
                        lane,
                    )
                    .await?;
                let summary = format!(
                    "Read generation {} of web session {id}.",
                    data["generation"].as_u64().unwrap()
                );
                return output(tool, summary, false, data);
            }
            "web.session.click" => {
                let id = id.unwrap();
                let request = Request::Click(args["elementRef"].as_str().unwrap().into());
                (
                    id.into(),
                    "Clicked an element in web session",
                    self.sessions.call(scope, id, request, lane).await?,
                )
            }
            "web.session.type" => {
                let id = id.unwrap();
                let request = Request::Type(
                    args["elementRef"].as_str().unwrap().into(),
                    args["text"].clone(),
                    args["submit"] == true,
                );
                (
                    id.into(),
                    "Typed into an element in web session",
                    self.sessions.call(scope, id, request, lane).await?,
                )
            }
            "web.session.close" => {
                let id = id.unwrap();
                let data = self.sessions.call(scope, id, Request::Close, lane).await?;
                (id.into(), "Closed web session", data)
            }
            "web.session.pointer" => {
                bail!("Pointer gestures require an exact open Browser target.")
            }
            _ => unreachable!("operation has a validated tool"),
        };
        output(tool, format!("{summary} {id}."), mutating, data)
    }

    async fn open_session(
        self: &Arc<Self>,
        scope: Scope,
        target: Url,
        lane: watch::Receiver<bool>,
    ) -> Result<(String, Value)> {
        let id = opaque("wss")?;
        let (mailbox, commands) = mpsc::channel(1);
        let handle = Arc::new(Session {
            scope,
            mailbox,
            busy: Arc::new(Semaphore::new(1)),
        });
        self.sessions
            .records
            .lock()
            .unwrap()
            .insert(id.clone(), handle);
        let (opened, wait) = oneshot::channel();
        let owner = self.clone();
        let session_id = id.clone();
        tokio::spawn(async move {
            owner
                .clone()
                .drive_session(&session_id, target, lane, opened, commands)
                .await;
            owner.sessions.records.lock().unwrap().remove(&session_id);
        });
        let data = wait
            .await
            .context("The web session is unavailable for this task.")??;
        Ok((id, data))
    }

    async fn drive_session(
        self: Arc<Self>,
        id: &str,
        target: Url,
        mut lane: watch::Receiver<bool>,
        opened: oneshot::Sender<Result<Value>>,
        commands: mpsc::Receiver<Command>,
    ) {
        let mut opened = Some(opened);
        let result = self
            .clone()
            .run_session(id, target, &mut lane, &mut opened, commands)
            .await;
        if let Some(opened) = opened {
            let _ = opened
                .send(result.and_then(|()| bail!("The web session is unavailable for this task.")));
        }
    }

    async fn run_session(
        self: Arc<Self>,
        id: &str,
        target: Url,
        lane: &mut watch::Receiver<bool>,
        opened: &mut Option<oneshot::Sender<Result<Value>>>,
        commands: mpsc::Receiver<Command>,
    ) -> Result<()> {
        let manager = self
            .renderer
            .as_ref()
            .context("The managed browser session runtime is unavailable.")?;
        let mut stopped = manager.stopped();
        let _pending = self
            .render_requests
            .try_acquire()
            .context("Managed browser context queue is full.")?;
        let _slot = tokio::select! {
            biased;
            _ = revoked(lane) => bail!("Browser operation stopped with its agent turn."),
            _ = revoked(&mut stopped) => bail!("Managed Chromium is shutting down."),
            _ = opened.as_mut().unwrap().closed() => return Ok(()),
            slot = self.render_slots.acquire() => slot?,
        };
        let (browser_proxy, address) = super::proxy::Proxy::start(self.clone()).await?;
        let mut close = None;
        let result = manager.with_browser(address, true, async |browser| {
            let (page, policy, mut events) = render::prepare(browser, self.clone(), true).await?;
            let input = async {
                let state = tokio::select! {
                    biased;
                    _ = revoked(lane) => bail!("Browser operation stopped with its agent turn."),
                    _ = opened.as_mut().unwrap().closed() => return Ok(None),
                    result = timeout(NAVIGATION, render::navigate(&page, &policy, &target)) => {
                        result.context("Web session navigation timed out.")??;
                        page::state(&page, id, 1).await?
                    }
                };
                if opened.take().unwrap().send(Ok(state)).is_err() {
                    return Ok(None);
                }
                operate(id, &page, &policy, commands).await
            };
            close = tokio::select! {
                biased;
                _ = revoked(&mut stopped) => None,
                result = input => result?,
                result = render::serve(policy.clone(), &mut events) => {
                    result?;
                    None
                }
            };
            Ok(())
        }).await;
        drop(browser_proxy);
        if let Some(reply) = close {
            let _ = reply.send(result.map(|()| json!({"sessionId":id,"closed":true})));
            return Ok(());
        }
        result
    }
}

impl Sessions {
    async fn call(
        &self,
        scope: Scope,
        id: &str,
        request: Request,
        lane: watch::Receiver<bool>,
    ) -> Result<Value> {
        let handle = self
            .records
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .filter(|record| record.scope == scope)
            .context("The web session is unavailable for this task.")?;
        let permit = handle
            .busy
            .clone()
            .try_acquire_owned()
            .context("The web session is busy with another operation.")?;
        let (reply, wait) = oneshot::channel();
        handle
            .mailbox
            .send(Command {
                request,
                lane,
                reply,
                _permit: permit,
            })
            .await
            .map_err(|_| anyhow::anyhow!("The web session is unavailable for this task."))?;
        wait.await
            .context("The web session is unavailable for this task.")?
    }
}

async fn operate(
    id: &str,
    page: &cantrip_browser::Page,
    policy: &render::Policy,
    mut commands: mpsc::Receiver<Command>,
) -> Result<Option<oneshot::Sender<Result<Value>>>> {
    let mut state = page::State::default();
    let mut lifecycle = page.subscribe();
    let mut expires = Instant::now() + TTL;
    loop {
        let mut command = tokio::select! {
            command = commands.recv() => match command {
                Some(command) => command, None => return Ok(None),
            },
            event = lifecycle.next() => { event?; continue; },
            _ = tokio::time::sleep_until(expires) => return Ok(None),
        };
        if *command.lane.borrow() {
            let _ = command.reply.send(Err(anyhow::anyhow!(
                "Browser operation stopped with its agent turn."
            )));
            continue;
        }
        if matches!(command.request, Request::Close) {
            return Ok(Some(command.reply));
        }
        let deadline = if matches!(command.request, Request::Navigate(_)) {
            NAVIGATION
        } else {
            OPERATION
        };
        let outcome = tokio::select! {
            biased;
            _ = revoked(&mut command.lane) => {
                let _ = command.reply.send(Err(anyhow::anyhow!("Browser operation stopped with its agent turn.")));
                // Isolate a possibly interrupted pointer or keyboard sequence.
                return Ok(None);
            }
            result = timeout(deadline, state.execute(page, policy, id, command.request)) => {
                result.context("Web session operation timed out.")
            }
        };
        match outcome {
            Ok(result) => {
                let _ = command.reply.send(result);
            }
            Err(error) => {
                let _ = command.reply.send(Err(error));
                return Ok(None);
            }
        }
        expires = Instant::now() + TTL;
    }
}

async fn revoked(lane: &mut watch::Receiver<bool>) {
    let _ = lane.wait_for(|retired| *retired).await;
}

fn output(tool: &str, summary: String, mutated: bool, data: Value) -> Result<Value> {
    mcp_host::parse(
        &format!("mcpStdioOutput/{tool}"),
        Some(&json!({
            "summary":summary,"target":Value::Null,"worktreeId":Value::Null,
            "continuationScheduled":false,"mutated":mutated,"data":data,
        })),
    )
    .map_err(response_error)
}
