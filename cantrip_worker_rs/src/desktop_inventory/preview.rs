//! One authenticated native preview lifetime per Chat.
mod native;
mod protected;

use super::{DEADLINE, Request as DesktopRequest, retire};
use crate::{
    connection::Outbound,
    encryption::Service,
    http::checked,
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

const SESSION_LIMIT: usize = 32;
const OPEN: &str = "computer-use.preview.open";
const STOP: &str = "computer-use.preview.stop";
const REVOKE: &str = "computer-use.preview.revoke";
const OPERATION: &str = "computer-use.operation";
pub(super) use native::{release, run};

pub(crate) fn supports(method: &str) -> bool {
    matches!(method, OPEN | STOP | REVOKE | OPERATION)
}

#[derive(Clone)]
pub(crate) struct Previews(Arc<Manager>);

struct Manager {
    leases: Mutex<HashMap<JsString, Arc<Lease>>>,
    encryption: Arc<Service>,
    outgoing: Arc<Outbound>,
    requests: mpsc::Sender<DesktopRequest>,
    retirements: mpsc::UnboundedSender<Arc<Lease>>,
}

pub(super) struct Retirements {
    manager: Weak<Manager>,
    pub(super) releases: mpsc::UnboundedReceiver<Arc<Lease>>,
}

impl Retirements {
    pub(super) fn expire(&self, epoch: u64) {
        if let Some(manager) = self.manager.upgrade() {
            Previews(manager).expire(epoch);
        }
    }
}

pub(super) struct Lease {
    id: JsString,
    authority: Value,
    domain: Value,
    epoch: u64,
    abort: Abort,
    signal: Signal,
    session: Mutex<Option<native::Session>>,
}

pub(super) struct Request {
    lease: Arc<Lease>,
    action: Value,
    deadline: Instant,
    reply: oneshot::Sender<Result<native::ResultData>>,
}

impl Request {
    pub(super) fn epoch(&self) -> u64 {
        self.lease.epoch
    }

    pub(super) fn expired(self) {
        let _ = self.reply.send(Err(native::reject(
            "cancelled",
            "Computer-use preview authority expired.",
        )));
    }
}

impl Previews {
    pub(super) fn new(
        encryption: Arc<Service>,
        outgoing: Arc<Outbound>,
        requests: mpsc::Sender<DesktopRequest>,
    ) -> (Self, Retirements) {
        let (retirements, releases) = mpsc::unbounded_channel();
        let manager = Arc::new(Manager {
            leases: Mutex::default(),
            encryption,
            outgoing,
            requests,
            retirements,
        });
        let retirements = Retirements {
            manager: Arc::downgrade(&manager),
            releases,
        };
        (Self(manager), retirements)
    }

    pub(crate) async fn execute(
        &self,
        command: &Value,
        epoch: u64,
        emit: impl Fn(Value) -> Result<()> + Send,
    ) -> Result<Value> {
        ensure!(
            self.0.outgoing.stream_current(epoch),
            "Computer-use preview authority expired."
        );
        match command["type"].as_str() {
            Some(OPEN) => self.open(&command["authority"], &command["contentDomain"], epoch),
            Some(STOP) => self.stop(command, epoch),
            Some(REVOKE) => self.revoke(command, epoch),
            Some(OPERATION) => self.operation(command, epoch, emit).await,
            _ => bail!("Unknown computer-use preview command."),
        }
    }

    fn open(&self, authority: &Value, domain: &Value, epoch: u64) -> Result<Value> {
        self.authorize(authority)?;
        self.expire(epoch);
        let mut leases = self.0.leases.lock().unwrap();
        if let Some(current) = leases
            .values()
            .find(|lease| lease.authority["chatId"] == authority["chatId"])
            .cloned()
        {
            ensure!(
                current.domain == *domain
                    && current.authority["generation"].as_u64() <= authority["generation"].as_u64(),
                "Computer use belongs to another execution context."
            );
            if current.authority == *authority {
                return current.public();
            }
            ensure!(
                current.authority["generation"] != authority["generation"],
                "Computer use belongs to another execution context."
            );
            leases.remove(&current.id);
            self.retire(current);
        }
        ensure!(
            leases.len() < SESSION_LIMIT,
            "Computer-use preview capacity reached."
        );
        let (abort, signal) = Abort::new();
        let lease = Arc::new(Lease {
            id: uuid::Uuid::new_v4().to_string().into(),
            authority: authority.clone(),
            domain: domain.clone(),
            epoch,
            abort,
            signal,
            session: Mutex::default(),
        });
        let result = lease.public()?;
        leases.insert(lease.id.clone(), lease);
        Ok(result)
    }

    fn stop(&self, command: &Value, epoch: u64) -> Result<Value> {
        self.identity(command)?;
        self.expire(epoch);
        let mut leases = self.0.leases.lock().unwrap();
        let id = command["leaseId"]
            .as_js_string()
            .context("Missing preview lease.")?;
        if let Some(lease) = leases.get(id) {
            ensure!(
                lease.authority["chatId"] == command["chatId"],
                "Computer use belongs to another execution context."
            );
            self.retire(leases.remove(id).unwrap());
        }
        Ok(json!({"closed":true}))
    }

    fn revoke(&self, command: &Value, epoch: u64) -> Result<Value> {
        self.identity(command)?;
        self.expire(epoch);
        let scope = &command["scope"];
        self.remove_matching(|lease| match scope["kind"].as_str() {
            Some("chat") => lease.authority["chatId"] == scope["chatId"],
            Some("project") => lease.authority["projectId"] == scope["projectId"],
            Some("inherited-default") => {
                lease.authority["contextKind"] == scope["contextKind"]
                    && lease.authority["profile"]["usesDefault"] == true
            }
            _ => false,
        });
        Ok(json!({"closed":true}))
    }

    pub(crate) fn cancel_chat(&self, chat: &Value) {
        self.remove_matching(|lease| lease.authority["chatId"] == *chat);
    }

    pub(super) fn expire(&self, epoch: u64) {
        self.remove_matching(|lease| lease.epoch != epoch);
    }

    fn remove_matching(&self, matches: impl Fn(&Lease) -> bool) {
        self.0.leases.lock().unwrap().retain(|_, lease| {
            if matches(lease) {
                self.retire(lease.clone());
                false
            } else {
                true
            }
        });
    }

    fn retire(&self, lease: Arc<Lease>) {
        lease
            .abort
            .abort(anyhow::anyhow!("Computer-use preview authority expired."));
        let _ = self.0.retirements.send(lease);
    }

    fn identity(&self, identity: &Value) -> Result<()> {
        let (owner, server) = self.0.encryption.bound_identity()?;
        ensure!(
            identity["ownerId"].as_js_string() == Some(&owner) && identity["serverId"] == server,
            "Computer use belongs to another execution context."
        );
        Ok(())
    }

    fn authorize(&self, authority: &Value) -> Result<()> {
        self.identity(authority)?;
        ensure!(
            authority["workerId"].as_js_string() == Some(self.0.encryption.worker_id()),
            "Computer use belongs to another execution context."
        );
        Ok(())
    }

    fn resolve(&self, command: &Value, epoch: u64) -> Result<Arc<Lease>> {
        let bound = &command["preview"];
        let request = &command["request"];
        let authority = &bound["authority"];
        self.authorize(authority)?;
        ensure!(
            command["serverId"] == authority["serverId"]
                && command["chatId"] == authority["chatId"]
                && command["executionLaneId"].is_null()
                && bound["leaseId"] == request["previewLeaseId"],
            "Computer use belongs to another execution context."
        );
        let id = bound["leaseId"]
            .as_js_string()
            .context("Missing preview lease.")?;
        let mut leases = self.0.leases.lock().unwrap();
        let lease = leases
            .get(id)
            .cloned()
            .context("Computer-use preview authority expired.")?;
        ensure!(
            lease.epoch == epoch && lease.authority["chatId"] == command["chatId"],
            "Computer-use preview authority expired."
        );
        if lease.authority != *authority {
            if authority["generation"].as_u64() >= lease.authority["generation"].as_u64() {
                leases.remove(id);
                self.retire(lease);
            }
            bail!("Computer use belongs to another execution context.");
        }
        Ok(lease)
    }

    async fn operation(
        &self,
        command: &Value,
        epoch: u64,
        emit: impl Fn(Value) -> Result<()> + Send,
    ) -> Result<Value> {
        let lease = self.resolve(command, epoch)?;
        let request = &command["request"];
        let content = protected::Content::new(&self.0.encryption, &lease, request);
        let response = async {
            let action = content.open()?;
            lease.signal.check()?;
            let operation = action["operation"].as_str().unwrap();
            native::authorize(&lease, operation)?;
            let (reply, result) = oneshot::channel();
            self.0
                .requests
                .try_send(DesktopRequest::Preview(Request {
                    lease: lease.clone(),
                    action,
                    deadline: Instant::now() + DEADLINE,
                    reply,
                }))
                .map_err(|_| native::reject("capacity", "Computer-use preview is busy."))?;
            result.await.context("The native desktop helper stopped.")?
        }
        .await;
        content.respond(
            response,
            || {
                lease.signal.check()?;
                ensure!(
                    self.0.outgoing.stream_current(epoch),
                    "Computer-use preview authority expired."
                );
                self.authorize(&lease.authority)
            },
            emit,
        )
    }
}

impl Lease {
    fn public(&self) -> Result<Value> {
        checked(
            "cuaPreviewLeaseSchema",
            &json!({
                "leaseId":self.id,"workerId":self.authority["workerId"],"chatId":self.authority["chatId"],
                "contentDomain":self.domain,"generation":self.authority["generation"],
            }),
        )
    }
}
