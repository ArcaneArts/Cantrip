//! Protected WebDAV control plane. Paths and credentials stay at the endpoints.
pub mod repository;
use crate::{
    database::Database,
    live::LiveService,
    tunnels,
    wire::{Value, value::json},
    workers::{
        bridge::WorkerBridge,
        command_bus::{CommandFailure, LimitedCommandBus},
    },
};
use anyhow::{Context, Result};
use indexmap::IndexMap;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const MOUNT_LEASE_MS: i64 = 12 * 60 * 60_000;
#[derive(Debug)]
pub struct OperationError {
    pub message: String,
    pub code: String,
    pub stage: &'static str,
    pub worker_request_id: Option<String>,
}
impl std::fmt::Display for OperationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for OperationError {}
impl OperationError {
    pub fn new(message: &str, code: &str, stage: &'static str) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            stage,
            worker_request_id: None,
        }
    }
    pub fn stale(message: &str) -> Self {
        Self::new(
            message,
            "project-share-state-stale",
            "share-state-validation",
        )
    }
}
#[derive(Clone)]
struct ActiveShare {
    worker: String,
}
pub struct Service {
    repository: tunnels::Repository,
    commands: Arc<LimitedCommandBus>,
    bridge: Arc<WorkerBridge>,
    live: Arc<LiveService>,
    worker_links: Arc<crate::worker_links::service::Service>,
    active: Mutex<IndexMap<String, ActiveShare>>,
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        bridge: Arc<WorkerBridge>,
        live: Arc<LiveService>,
        worker_links: Arc<crate::worker_links::service::Service>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: tunnels::Repository::new(database),
            commands,
            bridge,
            live,
            worker_links,
            active: Mutex::new(IndexMap::new()),
        })
    }
    async fn close_worker(&self, id: &str, worker: &str) {
        if self.bridge.is_connected(worker) {
            let _ = self
                .commands
                .request(
                    worker,
                    json!({"type":"project.share.close","shareId":id}),
                    Some(Duration::from_secs(5)),
                    None,
                )
                .await;
        }
    }
    fn changed(&self, owner: &str, id: &str, project: &Value) {
        tunnels::publish(
            &self.live,
            &json!({"attachmentId":id,"ownerId":owner,"projectId":project,"tunnelId":id}),
        );
    }
    pub async fn open(&self, input: &Value) -> Result<Value> {
        let started = crate::auth::now().timestamp_millis();
        let owner = input["ownerId"].as_str().context("Share owner")?;
        let id = input["tunnelId"].as_str().context("Share tunnel")?;
        let worker = input["workerId"].as_str().context("Share worker")?;
        if !self.bridge.is_connected(worker) {
            return Err(OperationError::new(
                "The project worker is offline.",
                "worker-offline",
                "worker-connectivity",
            )
            .into());
        }
        let resource = input
            .get("managedResourceId")
            .filter(|v| !v.is_null())
            .unwrap_or(&input["projectId"]);
        anyhow::ensure!(
            crate::wire::coercion::truthy(Some(resource)),
            "A protected file share requires an owning resource."
        );
        let managed = json!({"kind":"project-share","id":resource});
        let existing = self.repository.get_managed(owner, &managed).await?;
        if existing.as_ref().is_some_and(|e| e["id"] != id) {
            return Err(OperationError::stale("Project share tunnel identity is stale.").into());
        }
        let record = &input["protectedRecord"];
        let stale = match &existing {
            None => record["revision"] != 1 || record["operationId"] != id,
            Some(existing) => {
                existing["protectedRecord"].is_null()
                    || record["revision"].as_f64()
                        != existing["protectedRecord"]["revision"]
                            .as_f64()
                            .map(|r| r + 1.0)
                    || record["operationId"] == existing["protectedRecord"]["operationId"]
            }
        };
        if stale {
            return Err(OperationError::stale("Project share protected content is stale.").into());
        }
        if let Some(existing) = &existing {
            self.close_worker(
                existing["id"].as_str().context("Existing share identity")?,
                existing["destination"]["workerId"]
                    .as_str()
                    .context("Existing share worker")?,
            )
            .await;
        }
        let raw = self.commands.request(worker, json!({"type":"project.share.open","shareId":id,"protectedRecord":record,"standaloneRoot":input.get("standaloneRoot").cloned().unwrap_or(Value::Null)}), Some(Duration::from_secs(30)), None).await.map_err(|failure| {
            let error = match &failure { CommandFailure::Bridge(error) => Some(error), _ => None };
            let code = error.and_then(|e| e.code.as_deref()).unwrap_or("worker-share-open-failed");
            let mut failure = OperationError::new(if code=="project-source-unavailable" {"Project source is unavailable."} else {"The worker could not open the protected project share."}, code, "worker-share-open");
            failure.worker_request_id = error.and_then(|e| e.request_id.clone()); failure
        })?;
        let result = crate::wire::parse("workerProjectShareOpenResultSchema", raw.as_ref())
            .map_err(|_| {
                OperationError::new(
                    "The worker returned an invalid project share response.",
                    "worker-response-invalid",
                    "worker-response-validation",
                )
            })?;
        if result["shareId"] != id {
            return Err(OperationError::new(
                "The worker opened an unexpected project share.",
                "worker-response-mismatch",
                "worker-response-validation",
            )
            .into());
        }
        let registered: Result<Value> = async {
            let tunnel = self.repository.register_managed(owner, &json!({"name":"Project files","description":"Secure WebDAV access to this project's files.","projectId":input["projectId"],"origin":"project-share","management":"managed-ephemeral","protocolHint":"webdav","source":json!({"kind":"desktop-loopback"}),"destination":json!({"kind":"worker-adapter","workerId":worker,"adapter":"project-share","resourceId":id}),"managedBy":managed,"desiredState":"started","status":"starting"}),Some(&json!({"id":id,"protectedRecord":record}))).await?.context("Could not register the project share tunnel.")?;
            let id = tunnel["id"].as_str().context("Registered share identity")?;
            self.active.lock().unwrap().insert(id.into(), ActiveShare { worker: worker.into() });
            self.changed(owner,id,&input["projectId"]);
            crate::operations::logging::server().event("info", &"Protected project share ready".into(), Some(&json!({"event":"project_share.open.completed","subsystem":"project-share","operation":"open","status":"completed","attachmentId":id,"projectId":input["projectId"],"tunnelId":id,"workerId":worker,"durationMs":crate::auth::now().timestamp_millis()-started})))?;
            Ok(json!({"attachmentId":id,"projectId":input["projectId"],"protocol":"webdav","tunnelId":id,"expiresAt":crate::auth::iso(crate::auth::now()+chrono::Duration::milliseconds(MOUNT_LEASE_MS)),"mountLeaseMs":MOUNT_LEASE_MS}))
        }.await;
        match registered {
            Ok(value) => Ok(value),
            Err(error) => {
                self.close_worker(id, worker).await;
                if error.is::<OperationError>() {
                    Err(error)
                } else {
                    Err(OperationError::new(
                        "Winterhold could not register the protected project share tunnel.",
                        "tunnel-registration-failed",
                        "tunnel-registration",
                    )
                    .into())
                }
            }
        }
    }
    pub async fn revoke_attachment(&self, owner: &str, id: &str) -> Result<bool> {
        let Some(tunnel) = self.repository.get(owner, id).await?.filter(|t| {
            t["origin"] == "project-share" && t["managedBy"]["kind"] == "project-share"
        }) else {
            return Ok(false);
        };
        self.worker_links
            .revoke_resource(owner, "tunnel", id, "resource-deleted")
            .await;
        self.close_worker(
            id,
            tunnel["destination"]["workerId"]
                .as_str()
                .context("Share worker")?,
        )
        .await;
        let removed = self
            .repository
            .remove_managed(owner, &tunnel["managedBy"])
            .await?;
        self.active.lock().unwrap().shift_remove(id);
        if removed {
            self.changed(owner, id, &tunnel["projectId"]);
        }
        Ok(removed)
    }
    pub async fn revoke_managed_resource(&self, owner: &str, resource: &str) -> Result<bool> {
        let managed = json!({"kind":"project-share","id":resource});
        let Some(tunnel) = self.repository.get_managed(owner, &managed).await? else {
            return Ok(false);
        };
        let id = tunnel["id"].as_str().context("Share identity")?;
        self.worker_links
            .revoke_resource(owner, "tunnel", id, "resource-deleted")
            .await;
        self.close_worker(
            id,
            tunnel["destination"]["workerId"]
                .as_str()
                .context("Share worker")?,
        )
        .await;
        let removed = self.repository.remove_managed(owner, &managed).await?;
        self.active.lock().unwrap().shift_remove(id);
        Ok(removed)
    }
    pub async fn close(&self) {
        let active = self
            .active
            .lock()
            .unwrap()
            .iter()
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect::<Vec<_>>();
        futures::future::join_all(
            active
                .iter()
                .map(|(id, s)| self.close_worker(id, &s.worker)),
        )
        .await;
        self.active.lock().unwrap().clear();
    }
}
