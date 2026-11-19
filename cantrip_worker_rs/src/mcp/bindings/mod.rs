//! Worker-owned loopback broker. A host credential identifies a prepared
//! session. Only the current admitted lane can authorize an operation.
mod http;
mod server;
mod store;

pub use server::{Server, WorkerToken};

use anyhow::{Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_protocol::{date_iso_milliseconds, mcp_host, response::response_error};
use cantrip_wire::{JsString, Value, value::json};
use server::Capabilities;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::AtomicUsize},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, watch},
    task::JoinHandle,
    time::Instant,
};

pub type Identity = Arc<dyn Fn() -> Result<(JsString, JsString)> + Send + Sync>;
const DEFAULT_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAXIMUM_OPERATIONS: usize = 4;

#[derive(Clone)]
pub struct Attachment {
    pub connection: Value,
    pub connection_path: PathBuf,
    profile: &'static str,
    tools: Vec<JsString>,
}

impl Attachment {
    /// Entry for the native Codex managed MCP overlay.
    pub fn codex_configuration(&self, executable: &Path) -> Result<Value> {
        let executable = std::path::absolute(executable)?;
        let command = executable
            .to_str()
            .ok_or_else(|| anyhow!("MCP executable path is not Unicode."))?;
        let connection = self
            .connection_path
            .to_str()
            .ok_or_else(|| anyhow!("MCP connection path is not Unicode."))?;
        Ok(json!({
            "command": command,
            "args": vec!["mcp", "--connection", connection],
            "env": json!({
                "CANTRIP_MCP_PROFILE": self.profile,
                "CANTRIP_MCP_CONNECTION_GENERATION": self.connection["bindingId"]
            }),
            "enabled": true,
            "required": true,
            "tool_timeout_sec": 0,
            "enabled_tools": self.tools,
        }))
    }
}

struct Active {
    binding: Value,
    stale: Mutex<Option<JsString>>,
}

struct Entry {
    attachment: Attachment,
    identity: (JsString, JsString),
    claims: Value,
    issued_at: String,
    expires_at: i64,
    capabilities: Capabilities,
    legacy_root: Option<Value>,
    active: Option<Arc<Active>>,
    requests: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Entries {
    by_id: HashMap<JsString, Entry>,
    closed: bool,
}

struct Negotiated {
    identity: (JsString, JsString),
    capabilities: Capabilities,
    until: Instant,
}

struct Inner {
    data: PathBuf,
    endpoint: String,
    worker: JsString,
    identity: Identity,
    server: Server,
    web: Arc<crate::web::Service>,
    entries: Mutex<Entries>,
    negotiated: AsyncMutex<Option<Negotiated>>,
}

pub struct Broker {
    inner: Arc<Inner>,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<Result<()>>>,
}

pub struct Activation {
    inner: Arc<Inner>,
    binding_id: JsString,
    active: Arc<Active>,
}

impl Activation {
    pub fn release(self) -> bool {
        self.deactivate()
    }

    fn deactivate(&self) -> bool {
        let mut entries = self.inner.entries.lock().unwrap();
        let Some(entry) = entries.by_id.get_mut(&self.binding_id) else {
            return false;
        };
        if entry
            .active
            .as_ref()
            .is_none_or(|active| !Arc::ptr_eq(active, &self.active))
        {
            return false;
        }
        entry.active = None;
        true
    }
}

impl Drop for Activation {
    fn drop(&mut self) {
        self.deactivate();
    }
}

impl Broker {
    pub async fn start(
        data: &Path,
        worker: JsString,
        identity: Identity,
        server: Server,
    ) -> Result<Self> {
        Self::start_with_web(data, worker, identity, server, None).await
    }

    pub(crate) async fn start_with_web(
        data: &Path,
        worker: JsString,
        identity: Identity,
        server: Server,
        renderer: Option<Arc<crate::managed_chromium::Manager>>,
    ) -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let inner = Arc::new(Inner {
            data: std::path::absolute(data)?,
            endpoint,
            worker,
            identity,
            server,
            web: Arc::new(crate::web::Service::new(renderer)),
            entries: Mutex::new(Entries::default()),
            negotiated: AsyncMutex::new(None),
        });
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(http::serve(listener, inner.clone(), stopped));
        Ok(Self {
            inner,
            stop,
            task: Some(task),
        })
    }

    /// Called by managed preparation with the resolved chat placement. Scope
    /// and permission data comes from the worker owner, never the MCP child.
    pub async fn prepare(
        &self,
        mut claims: Value,
        legacy_root: Option<Value>,
    ) -> Result<Attachment> {
        let binding = (self.inner.identity)()?;
        if !claims.is_object()
            || claims["ownerId"].as_js_string() != Some(&binding.0)
            || claims["workerId"].as_js_string() != Some(&self.inner.worker)
        {
            bail!("Cantrip MCP binding belongs to a different worker or owner.");
        }
        let legacy_root = legacy_root
            .map(|root| crate::http::checked("repositoryRoutingHandleSchema", &root))
            .transpose()?;
        let capabilities = self.inner.capabilities(&binding).await;
        if (self.inner.identity)()? != binding {
            bail!("The worker binding changed during MCP preparation.");
        }
        let standalone = claims["contextKind"] == "standalone";
        let profile = if standalone { "standalone-web" } else { "ide" };
        let requested = claims["allowedOperations"]
            .as_array()
            .ok_or_else(|| anyhow!("Cantrip MCP binding requires a list of allowed operations."))?;
        let (operations, tools): (Vec<_>, Vec<JsString>) = [
            (
                "context.get",
                "context_get",
                !standalone && capabilities.context,
            ),
            ("tool.help", "tool_help", true),
            ("web.read", "web_read", true),
        ]
        .into_iter()
        .filter(|(operation, _, supported)| {
            *supported && requested.iter().any(|op| op == *operation)
        })
        .map(|(operation, tool, _)| (operation, tool.into()))
        .unzip();
        claims["allowedOperations"] = json!(operations);
        let now = now();
        let expires_at = now + DEFAULT_TTL.as_millis() as i64;
        let issued_at = timestamp(now)?;
        let expires = timestamp(expires_at)?;
        let binding_id = uuid::Uuid::new_v4().to_string();
        let claims =
            mcp_host::parse("mcpHostSessionClaims", Some(&claims)).map_err(response_error)?;

        let mut entries = self.inner.entries.lock().unwrap();
        if entries.closed {
            bail!("Cantrip MCP broker is not running.");
        }
        let previous = entries
            .by_id
            .iter()
            .find(|(_, entry)| entry.claims["chatId"] == claims["chatId"])
            .map(|(key, _)| key.clone());
        if let Some(key) = previous {
            let entry = entries.by_id.get_mut(&key).unwrap();
            if entry.identity == binding
                && entry.expires_at > now
                && store::same_scope(&entry.claims, &claims)
            {
                if entry.active.is_none() {
                    let mut attachment = entry.attachment.clone();
                    attachment.tools = tools;
                    store::publish(&attachment)?;
                    entry.attachment = attachment;
                    entry.claims = claims;
                    entry.capabilities = capabilities;
                    entry.legacy_root = legacy_root;
                } else {
                    store::publish(&entry.attachment)?;
                }
                return Ok(entry.attachment.clone());
            }
            self.inner.remove(&mut entries, &key)?;
        }
        let mut random = [0u8; 32];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow!("Could not generate a Cantrip MCP credential."))?;
        let document = json!({
            "protocolVersion": 1,
            "endpoint": self.inner.endpoint,
            "bindingId": binding_id,
            "credential": URL_SAFE_NO_PAD.encode(random),
            "expiresAt": expires,
        });
        let attachment = Attachment {
            connection: document,
            connection_path: store::connection_path(&self.inner.data, &binding_id),
            profile,
            tools,
        };
        store::publish(&attachment)?;
        entries.by_id.insert(
            binding_id.into(),
            Entry {
                attachment: attachment.clone(),
                identity: binding,
                claims,
                issued_at,
                expires_at,
                capabilities,
                legacy_root,
                active: None,
                requests: Arc::new(AtomicUsize::new(0)),
            },
        );
        Ok(attachment)
    }

    /// Activation supplies the exact admitted placement and current lane.
    pub fn activate(&self, admission: &Value) -> Result<Option<Activation>> {
        let identity = (self.inner.identity)()?;
        let mut entries = self.inner.entries.lock().unwrap();
        let Some((binding_id, entry)) = entries.by_id.iter_mut().find(|(_, entry)| {
            entry.identity == identity
                && entry.expires_at > now()
                && store::same_scope(&entry.claims, admission)
                && ["worktreeId", "rootKind", "permissionProfileId"]
                    .iter()
                    .all(|field| entry.claims[*field] == admission[*field])
        }) else {
            return Ok(None);
        };
        let mut binding = entry.claims.clone();
        binding["bindingId"] = json!(binding_id);
        binding["issuedAt"] = json!(entry.issued_at);
        binding["expiresAt"] = entry.attachment.connection["expiresAt"].clone();
        binding["executionLaneId"] = admission["executionLaneId"].clone();
        let binding =
            mcp_host::parse("cantripMcpBindingSchema", Some(&binding)).map_err(response_error)?;
        let active = Arc::new(Active {
            binding,
            stale: Mutex::new(None),
        });
        entry.active = Some(active.clone());
        Ok(Some(Activation {
            inner: self.inner.clone(),
            binding_id: binding_id.clone(),
            active,
        }))
    }

    pub fn revoke(&self, binding_id: &JsString) -> Result<bool> {
        let mut entries = self.inner.entries.lock().unwrap();
        self.inner.remove(&mut entries, binding_id)
    }

    pub(crate) fn revoke_owned(
        &self,
        identity: (&JsString, &JsString),
        matches: impl Fn(&Value) -> bool,
    ) -> Result<()> {
        let mut entries = self.inner.entries.lock().unwrap();
        let keys = entries
            .by_id
            .iter()
            .filter(|(_, entry)| {
                (&entry.identity.0, &entry.identity.1) == identity && matches(&entry.claims)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let mut result = Ok(());
        for key in keys {
            let removed = self.inner.remove(&mut entries, &key).map(|_| ());
            result = result.and(removed);
        }
        result
    }

    pub async fn close(mut self) -> Result<()> {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            task.await??;
        }
        Ok(())
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

impl Inner {
    async fn capabilities(&self, identity: &(JsString, JsString)) -> Capabilities {
        let mut cached = self.negotiated.lock().await;
        if let Some(cached) = cached.as_ref()
            && &cached.identity == identity
            && cached.until > Instant::now()
        {
            return cached.capabilities.clone();
        }
        let capabilities = self
            .server
            .capabilities(&self.worker)
            .await
            .unwrap_or(Capabilities {
                version: 1,
                context: true,
            });
        *cached = Some(Negotiated {
            identity: identity.clone(),
            capabilities: capabilities.clone(),
            until: Instant::now() + Duration::from_secs(60),
        });
        capabilities
    }

    fn remove(&self, entries: &mut Entries, key: &JsString) -> Result<bool> {
        let Some(entry) = entries.by_id.remove(key) else {
            return Ok(false);
        };
        store::remove(&entry)?;
        Ok(true)
    }

    fn sweep(&self) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let timestamp = now();
        let expired = entries
            .by_id
            .iter()
            .filter_map(|(key, entry)| (entry.expires_at <= timestamp).then_some(key.clone()))
            .collect::<Vec<_>>();
        for key in expired {
            self.remove(&mut entries, &key)?;
        }
        Ok(())
    }

    fn shutdown(&self) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        entries.closed = true;
        let mut outcome = Ok(());
        for entry in entries.by_id.drain().map(|(_, entry)| entry) {
            if let Err(error) = store::remove(&entry) {
                outcome = Err(error);
            }
        }
        outcome
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn timestamp(value: i64) -> Result<String> {
    date_iso_milliseconds(value).ok_or_else(|| anyhow!("Cantrip MCP binding time is invalid."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn expired_attachment_rejects_the_authenticated_host_and_retires_the_file() -> Result<()>
    {
        let data = tempfile::tempdir()?;
        let identity = (JsString::from("owner"), JsString::from("server"));
        let server = Server::new(
            "http://127.0.0.1:1",
            Arc::new(|| bail!("No request expected")),
        )?;
        let broker = Broker::start(
            data.path(),
            "worker".into(),
            Arc::new({
                let identity = identity.clone();
                move || Ok(identity.clone())
            }),
            server,
        )
        .await?;
        *broker.inner.negotiated.lock().await = Some(Negotiated {
            identity,
            capabilities: Capabilities {
                version: 2,
                context: true,
            },
            until: Instant::now() + Duration::from_secs(60),
        });
        let attachment = broker.prepare(json!({
            "contextKind": "standalone", "ownerId": "owner", "workerId": "worker",
            "chatId": "chat", "scratchRootId": "scratch", "projectId": Value::Null,
            "worktreeId": Value::Null, "rootKind": Value::Null, "permissionProfileId": ":workspace",
            "allowedOperations": vec!["context.get", "tool.help"],
        }), None).await?;
        let id = attachment.connection["bindingId"].as_js_string().unwrap();
        let url = format!("{}/v1/bindings/{}", broker.inner.endpoint, id.lossy());
        let client = reqwest::Client::builder().no_proxy().build()?;
        let handshake = || {
            client
                .get(&url)
                .bearer_auth(attachment.connection["credential"].as_str().unwrap())
                .send()
        };
        assert_eq!(handshake().await?.status(), 200);
        broker
            .inner
            .entries
            .lock()
            .unwrap()
            .by_id
            .get_mut(id)
            .unwrap()
            .expires_at = now();
        assert_eq!(handshake().await?.status(), 401);
        assert_eq!(
            std::fs::metadata(&attachment.connection_path)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
        broker.close().await
    }
}
