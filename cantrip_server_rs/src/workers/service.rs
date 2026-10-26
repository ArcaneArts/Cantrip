use super::{bridge::WorkerBridge, limits::SlidingWindow, repository::WorkerRepository};
use crate::{
    config::{DeploymentMode, ServerConfig},
    database::Database,
    wire::Value,
};
use anyhow::{Context, Result};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock, atomic::AtomicUsize},
    time::Duration,
};
use tokio::{
    sync::{Semaphore, broadcast, watch},
    task::AbortHandle,
};

#[derive(Clone, Debug)]
pub struct Invalidation {
    pub owner: String,
    pub resource: &'static str,
    pub entity: String,
}
pub struct RequestLimiters {
    api: SlidingWindow,
    pairing: SlidingWindow,
    websocket: SlidingWindow,
    upload: SlidingWindow,
}
pub struct WorkerService {
    pub repository: WorkerRepository,
    pub bridge: Arc<WorkerBridge>,
    pub invalidations: broadcast::Sender<Invalidation>,
    pub revoked: RwLock<HashSet<String>>,
    pub handshakes: Arc<Semaphore>,
    pub buffered_authentication_bytes: &'static AtomicUsize,
    pub control_generation: String,
    pub shutdown: watch::Sender<bool>,
    presence: Mutex<HashMap<String, String>>,
    offline: Mutex<HashMap<String, AbortHandle>>,
    limits: Mutex<RequestLimiters>,
}
impl WorkerService {
    pub fn new(database: Arc<Database>, config: &ServerConfig) -> Arc<Self> {
        Arc::new(Self {
            repository: WorkerRepository::new(database),
            bridge: WorkerBridge::new(Duration::from_secs(15)),
            invalidations: broadcast::channel(4096).0,
            revoked: RwLock::new(HashSet::new()),
            handshakes: Arc::new(Semaphore::new(32)),
            buffered_authentication_bytes: {
                static BYTES: AtomicUsize = AtomicUsize::new(0);
                &BYTES
            },
            control_generation: uuid::Uuid::new_v4().to_string(),
            shutdown: watch::channel(false).0,
            presence: Mutex::new(HashMap::new()),
            offline: Mutex::new(HashMap::new()),
            limits: Mutex::new(RequestLimiters {
                api: SlidingWindow::new(config.api_rate_limit_per_minute as usize),
                pairing: SlidingWindow::new(config.pairing_rate_limit_per_minute as usize),
                websocket: SlidingWindow::new(config.websocket_handshake_rate_per_minute as usize),
                upload: SlidingWindow::new(config.upload_rate_limit_per_minute as usize),
            }),
        })
    }
    pub fn invalidate(&self, owner: &str, resource: &'static str, id: &str) {
        let _ = self.invalidations.send(Invalidation {
            owner: owner.into(),
            resource,
            entity: id.into(),
        });
    }
    pub fn forget_presence(&self, id: &str) {
        self.presence.lock().unwrap().remove(id);
    }
    pub fn publish_presence(&self, owner: &str, worker: &serde_json::Value) {
        let id = worker["workerId"].as_str().expect("stored worker identity");
        let fingerprint = presence_fingerprint(worker);
        let mut presence = self.presence.lock().unwrap();
        if presence.get(id) == Some(&fingerprint) {
            return;
        }
        presence.insert(id.into(), fingerprint);
        drop(presence);
        self.invalidate(owner, "worker", id);
    }
    pub fn schedule_offline(self: &Arc<Self>, owner: &str, id: &str) {
        let mut timers = self.offline.lock().unwrap();
        if let Some(previous) = timers.remove(id) {
            previous.abort();
        }
        let service = Arc::downgrade(self);
        let owner = owner.to_owned();
        let id = id.to_owned();
        let key = id.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30050)).await;
            if let Some(service) = service.upgrade() {
                service.offline.lock().unwrap().remove(&id);
                service.forget_presence(&id);
                service.invalidate(&owner, "worker-availability", &id);
            }
        });
        timers.insert(key, task.abort_handle());
    }
    pub fn mark_revoked(&self, id: &str) {
        self.revoked.write().unwrap().insert(id.into());
    }
    pub fn limit(
        &self,
        config: &ServerConfig,
        owner: Option<&str>,
        ip: &str,
        method: &str,
        route: &str,
        websocket: bool,
    ) -> Option<(&'static str, u64)> {
        if method == "OPTIONS"
            || (route.starts_with("/api/internal/workers/")
                && route != "/api/internal/workers/enroll")
            || ["/api/auth/login", "/api/auth/register"].contains(&route)
        {
            return None;
        }
        let key = owner.map_or_else(|| format!("ip:{ip}"), |owner| format!("owner:{owner}"));
        let mut limits = self.limits.lock().unwrap();
        let (category, limiter) = if (route == "/api/workers/enrollment-codes" && method == "POST")
            || route == "/api/internal/workers/enroll"
            || route.ends_with("/credentials/rotate")
        {
            ("pairing", &mut limits.pairing)
        } else if route == "/api/chats/:chatId/attachments" && method == "POST" {
            ("upload", &mut limits.upload)
        } else if websocket {
            ("websocket-handshake", &mut limits.websocket)
        } else {
            if config.deployment_mode == DeploymentMode::Local {
                return None;
            }
            ("api", &mut limits.api)
        };
        let key = if category == "api" {
            format!("{key}:{method}:{route}")
        } else {
            key
        };
        limiter
            .consume(&key, crate::auth::now().timestamp_millis())
            .map(|retry| (category, retry))
    }
    pub async fn computer_use_effects(&self, owner: &str) -> Result<serde_json::Value> {
        let rows=self.repository.database.query("SELECT computer_use_enabled,computer_use_effects,computer_use_effects_revision FROM user_settings WHERE user_id=$1 LIMIT 1",&[&owner]).await?;
        let row = rows
            .first()
            .context("Loading user settings did not complete.")?;
        let configuration = row.get::<serde_json::Value>(1)?;
        Ok(
            json!({"revision":row.get::<i32>(2)?,"configuration":if row.get::<bool>(0)?&&!configuration.is_null(){configuration}else{json!({"effect":"off","parameters":{}})}}),
        )
    }
    pub fn close(&self) {
        self.shutdown.send_replace(true);
        for (_, timer) in self.offline.lock().unwrap().drain() {
            timer.abort();
        }
        self.bridge.close();
    }
}
pub fn presence_fingerprint(worker: &serde_json::Value) -> String {
    let encryption = &worker["encryption"];
    let mut grants = encryption["grants"]
        .as_array()
        .map_or(Vec::new(), |grants| {
            grants
                .iter()
                .map(|grant| json!([grant["component"], grant["keyRevision"]]))
                .collect::<Vec<_>>()
        });
    grants.sort_by(|a, b| {
        a[0].as_str()
            .cmp(&b[0].as_str())
            .then_with(|| a[1].as_i64().cmp(&b[1].as_i64()))
    });
    let material = Value::from_serialize(&json!([
        encryption["supported"],
        encryption["state"],
        encryption["principalId"],
        encryption["error"],
        grants
    ]))
    .stringify();
    let mut fields = [
        "workerId",
        "name",
        "platform",
        "architecture",
        "codexVersion",
        "codexRuntime",
        "remoteSurfaces",
        "directBroker",
        "projectReplicas",
        "managedFolders",
        "standaloneChat",
        "chatRelocation",
        "externalCodexHistory",
        "codegraph",
        "webRuntimes",
    ]
    .iter()
    .map(|key| Value::from_serialize(&worker[*key]))
    .collect::<Vec<_>>();
    fields.push(Value::String(material.into()));
    fields.push(Value::from_serialize(&worker["startedAt"]));
    fields.push(Value::from_serialize(&worker["online"]));
    Value::Array(fields).stringify()
}
