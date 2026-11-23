//! Worker-owned, protected project and standalone Chat network shares.
mod digest;
mod filesystem;
mod rooted;
mod server;

use crate::{
    encryption::Service,
    filesystem::{chat_scratch, paths},
    http::checked,
    logging::Logs,
    protected_content::open_tunnel_record,
    routing,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use server::Listener;
use std::{
    collections::HashMap,
    io::ErrorKind,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};
use tokio::{fs, sync::Mutex};
use zeroize::Zeroizing;

const OPEN: &str = "project.share.open";
const CLOSE: &str = "project.share.close";
const MAX_SHARES: usize = 8;

#[derive(Debug)]
pub(crate) struct SourceUnavailable;

impl std::fmt::Display for SourceUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Project source is unavailable.")
    }
}

impl std::error::Error for SourceUnavailable {}

pub(crate) struct Manager {
    encryption: Arc<Service>,
    scratch: Arc<chat_scratch::Manager>,
    logs: Arc<Logs>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    shares: HashMap<JsString, Share>,
    closed: bool,
}

struct Share {
    root: PathBuf,
    binding: Binding,
    listener: Listener,
}

#[derive(PartialEq, Eq)]
struct Binding {
    base: String,
    username: String,
    password: Zeroizing<String>,
    realm: String,
}

impl Binding {
    fn from_record(destination: &Value) -> Result<Self> {
        let read = |field: &str| {
            destination[field]
                .as_str()
                .map(str::to_owned)
                .context("Invalid protected share binding.")
        };
        Ok(Self {
            base: read("publicBasePath")?,
            username: read("username")?,
            password: Zeroizing::new(read("password")?),
            realm: read("realm")?,
        })
    }
}

impl Manager {
    pub(crate) fn new(
        encryption: Arc<Service>,
        scratch: Arc<chat_scratch::Manager>,
        logs: Arc<Logs>,
    ) -> Self {
        Self {
            encryption,
            scratch,
            logs,
            state: Mutex::default(),
        }
    }

    pub(crate) fn supports(kind: &str) -> bool {
        matches!(kind, OPEN | CLOSE)
    }

    pub(crate) async fn execute(&self, command: &Value) -> Result<Value> {
        let kind = command["type"]
            .as_str()
            .context("Missing share command type")?;
        let result = async {
            let id = command["shareId"]
                .as_js_string()
                .context("Missing share identity")?;
            if kind == CLOSE {
                self.close(id).await;
                return Ok(json!({"accepted":true}));
            }
            let record = &command["protectedRecord"];
            let content = open_tunnel_record(&self.encryption, &command["shareId"], record)?;
            let destination = &content["destination"];
            ensure!(
                destination["workerId"].as_js_string() == Some(self.encryption.worker_id())
                    && destination["resourceId"] == command["shareId"]
                    && (record["revision"] != 1 || record["operationId"] == command["shareId"]),
                "Protected project share content belongs to another endpoint."
            );
            let standalone = &command["standaloneRoot"];
            let root = match destination["kind"].as_str() {
                Some("worker-project-share") if standalone.is_null() => project_root(destination)?,
                Some("worker-chat-share") => {
                    ensure!(
                        !standalone.is_null()
                            && standalone["chatId"] == destination["chatId"]
                            && standalone["rootId"] == destination["rootId"],
                        "Protected Chat share content belongs to another scratch root."
                    );
                    self.scratch.resolve_path(standalone).await?
                }
                _ => bail!("Protected project share content belongs to another endpoint."),
            };
            self.open(id, root, Binding::from_record(destination)?)
                .await?;
            checked(
                "workerProjectShareOpenResultSchema",
                &json!({"accepted":true,"shareId":id}),
            )
        }
        .await;
        result.map_err(|error| routing::protect_error(kind, error))
    }

    pub(crate) async fn endpoint(&self, id: &JsString, destination: &Value) -> Result<SocketAddr> {
        let binding = Binding::from_record(destination)?;
        if destination["kind"] == "worker-project-share" {
            return self.open(id, project_root(destination)?, binding).await;
        }
        let state = self.state.lock().await;
        let share = state
            .shares
            .get(id)
            .filter(|share| share.listener.running() && share.binding == binding)
            .context("The protected Chat share was not prepared for this connection.")?;
        Ok(SocketAddr::from((Ipv4Addr::LOCALHOST, share.listener.port)))
    }

    async fn open(&self, id: &JsString, root: PathBuf, binding: Binding) -> Result<SocketAddr> {
        let mut state = self.state.lock().await;
        ensure!(!state.closed, "The worker share service is stopping.");
        let root = paths::canonical(&root).await.map_err(source_error)?;
        ensure!(
            fs::metadata(&root).await.map_err(source_error)?.is_dir(),
            "Project share root must be a directory."
        );
        if let Some(existing) = state.shares.get(id) {
            ensure!(
                paths::equal(&existing.root, &root) && existing.binding == binding,
                "Project share identity is already bound to another root or public endpoint."
            );
            if existing.listener.running() {
                return Ok(SocketAddr::from((
                    Ipv4Addr::LOCALHOST,
                    existing.listener.port,
                )));
            }
        } else {
            ensure!(
                state.shares.len() < MAX_SHARES,
                "Worker project share limit of {MAX_SHARES} sessions reached."
            );
        }
        let listener = Listener::bind(root.clone(), &binding).await?;
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, listener.port));
        state.shares.insert(
            id.clone(),
            Share {
                root,
                binding,
                listener,
            },
        );
        self.logs.event(
            "info",
            "Project share opened",
            json!({
                "event":"project-share.opened","subsystem":"project-share","operation":"open",
                "status":"completed","surfaceId":id,"counts":json!({"active":state.shares.len()}),
            }),
        );
        Ok(addr)
    }

    async fn close(&self, id: &JsString) {
        let mut state = self.state.lock().await;
        if let Some(share) = state.shares.remove(id) {
            share.listener.close().await;
            self.logs.event(
                "info",
                "Project share closed",
                json!({
                    "event":"project-share.closed","subsystem":"project-share","operation":"close",
                    "status":"completed","surfaceId":id,"counts":json!({"active":state.shares.len()}),
                }),
            );
        }
    }

    pub(crate) async fn shutdown(&self) {
        let shares = {
            let mut state = self.state.lock().await;
            state.closed = true;
            std::mem::take(&mut state.shares)
        };
        futures::future::join_all(shares.into_values().map(|share| share.listener.close())).await;
    }
}

fn project_root(destination: &Value) -> Result<PathBuf> {
    Ok(paths::native(
        destination["root"]
            .as_js_string()
            .context("Missing protected project share root.")?,
    ))
}

fn source_error(error: std::io::Error) -> anyhow::Error {
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => SourceUnavailable.into(),
        _ => error.into(),
    }
}
