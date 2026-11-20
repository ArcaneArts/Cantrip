//! One authenticated native preview lifetime per Chat.
mod activity;
mod agent;
mod approvals;
mod guest;
mod input;
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
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::time::Instant;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

const SESSION_LIMIT: usize = 32;
const OPEN: &str = "computer-use.preview.open";
const STOP: &str = "computer-use.preview.stop";
const REVOKE: &str = "computer-use.preview.revoke";
const OPERATION: &str = "computer-use.operation";
const ANSWER: &str = "computer-use.approval.respond";
pub use agent::{HostAction, HostDesktop, HostEvaluation, HostSnapshot};
pub(super) use native::{release, run};

pub(crate) fn supports(method: &str) -> bool {
    matches!(method, OPEN | STOP | REVOKE | OPERATION | ANSWER)
}

#[derive(Clone)]
pub struct Previews(Arc<Manager>);

struct Manager {
    leases: Mutex<HashMap<JsString, Arc<Lease>>>,
    encryption: Arc<Service>,
    outgoing: Arc<Outbound>,
    approvals: approvals::Approvals,
    guests: guest::Guests,
    requests: mpsc::Sender<DesktopRequest>,
    retirements: mpsc::UnboundedSender<Arc<native::Attachment>>,
}

pub(super) struct Retirements {
    manager: Weak<Manager>,
    pub(super) releases: mpsc::UnboundedReceiver<Arc<native::Attachment>>,
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
    attachment: Arc<native::Attachment>,
    guest: Mutex<Option<Arc<guest::Group>>>,
}

pub(super) struct Request {
    attachment: Arc<native::Attachment>,
    epoch: u64,
    signal: Signal,
    allow_cantrip_app: bool,
    action: Value,
    deadline: Option<Instant>,
    reply: oneshot::Sender<Result<native::ResultData>>,
}

impl Request {
    pub(super) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(super) fn expired(self) {
        let _ = self.reply.send(Err(native::cancelled("not-sent")));
    }
}

impl Previews {
    pub(super) fn new(
        data: PathBuf,
        encryption: Arc<Service>,
        outgoing: Arc<Outbound>,
        requests: mpsc::Sender<DesktopRequest>,
    ) -> (Self, Retirements) {
        let (retirements, releases) = mpsc::unbounded_channel();
        let manager = Arc::new(Manager {
            leases: Mutex::default(),
            encryption,
            approvals: approvals::Approvals::new(outgoing.clone()),
            guests: guest::Guests::new(data),
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

    pub(super) fn monitor(&self, mut stop: watch::Receiver<bool>) -> JoinHandle<()> {
        let previews = self.clone();
        let mut epoch = self.0.outgoing.stream_epoch();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.wait_for(|stopped| *stopped) => break,
                    changed = epoch.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let generation = *epoch.borrow_and_update();
                        previews.expire(generation);
                    }
                }
            }
            previews.remove_matching(|_| true);
            previews.0.guests.close().await;
        })
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
            Some(STOP) => self.stop(command, epoch, emit),
            Some(REVOKE) => self.revoke(command, epoch),
            Some(ANSWER) => self.answer(command, epoch),
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
            attachment: Arc::new(native::Attachment::new(authority, None)),
            guest: Mutex::default(),
        });
        let result = lease.public()?;
        leases.insert(lease.id.clone(), lease);
        Ok(result)
    }

    fn stop(
        &self,
        command: &Value,
        epoch: u64,
        emit: impl Fn(Value) -> Result<()>,
    ) -> Result<Value> {
        let started_at = chrono::Utc::now().timestamp_millis();
        self.identity(command)?;
        self.expire(epoch);
        let mut leases = self.0.leases.lock().unwrap();
        let id = command["leaseId"]
            .as_js_string()
            .context("Missing preview lease.")?;
        let Some(lease) = leases.get(id) else {
            return Ok(json!({"closed":true}));
        };
        ensure!(
            lease.authority["chatId"] == command["chatId"],
            "Computer use belongs to another execution context."
        );
        let lease = leases.remove(id).unwrap();
        let mut audit = activity::Audit::new(started_at);
        audit.before = native::activity_session(&lease, None);
        self.retire(lease.clone());
        drop(leases);
        let publication = audit
            .event(
                &self.0.encryption,
                &lease,
                &json!("preview.stop"),
                &command["operationId"],
                false,
            )
            .and_then(emit);
        if publication.is_err() {
            return Ok(json!({"closed":true,"activityPublicationFailed":true}));
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
        self.0.approvals.revoke(&lease.id);
        if lease.authority["osPlacement"].is_null() {
            let _ = self.0.retirements.send(lease.attachment.clone());
        } else {
            self.0.guests.release(lease);
        }
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
        self.resolve_binding(id, authority, epoch)
    }

    fn resolve_binding(&self, id: &JsString, authority: &Value, epoch: u64) -> Result<Arc<Lease>> {
        self.authorize(authority)?;
        let mut leases = self.0.leases.lock().unwrap();
        let lease = leases
            .get(id)
            .cloned()
            .context("Computer-use preview authority expired.")?;
        ensure!(
            lease.epoch == epoch && lease.authority["chatId"] == authority["chatId"],
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

    fn answer(&self, command: &Value, epoch: u64) -> Result<Value> {
        let authority = &command["previewAuthority"];
        ensure!(
            command["agentAuthority"].is_null()
                && command["executionLaneId"].is_null()
                && !authority.is_null()
                && command["ownerId"] == authority["ownerId"]
                && command["chatId"] == authority["chatId"],
            "Computer use belongs to another execution context."
        );
        let key = command["requestKey"]
            .as_js_string()
            .context("Missing computer-use approval key.")?;
        let id = self.0.approvals.lease_for(key)?;
        let lease = self.resolve_binding(&id, authority, epoch)?;
        self.0
            .approvals
            .answer(&self.0.encryption, &lease, key, &command["response"])
    }

    async fn operation(
        &self,
        command: &Value,
        epoch: u64,
        emit: impl Fn(Value) -> Result<()> + Send,
    ) -> Result<Value> {
        let mut audit = activity::Audit::new(chrono::Utc::now().timestamp_millis());
        let lease = self.resolve(command, epoch)?;
        let request = &command["request"];
        let content = protected::Content::new(&self.0.encryption, &lease, request);
        let response = async {
            let action = content.open()?;
            audit.action(&lease, &action);
            lease.signal.check()?;
            let placement = self.0.guests.placement(&lease.authority)?;
            self.0.approvals.authorize(
                &self.0.encryption,
                &lease,
                &action,
                &request["operationId"],
                &emit,
            )?;
            let (reply, result) = oneshot::channel();
            let request = Request {
                attachment: lease.attachment.clone(),
                epoch: lease.epoch,
                signal: lease.signal.clone(),
                allow_cantrip_app: true,
                deadline: (action["operation"] != "input.perform")
                    .then(|| Instant::now() + DEADLINE),
                action,
                reply,
            };
            if let Some(execution) = placement {
                self.0.guests.dispatch(&lease, request, &execution).await?;
            } else {
                self.0
                    .requests
                    .try_send(DesktopRequest::ComputerUse(request))
                    .map_err(|_| native::reject("capacity", "Computer-use preview is busy."))?;
            }
            result.await.context("The native desktop helper stopped.")?
        }
        .await;
        audit.result(&response);
        let delivery = content.respond(
            response,
            |active_required| {
                if active_required {
                    lease.signal.check()?;
                }
                ensure!(
                    self.0.outgoing.stream_current(epoch),
                    "Computer-use preview authority expired."
                );
                self.authorize(&lease.authority)
            },
            &emit,
        );
        let publication = audit
            .event(
                &self.0.encryption,
                &lease,
                &request["operation"],
                &request["operationId"],
                delivery.is_err(),
            )
            .and_then(emit);
        ensure!(
            publication.is_ok(),
            "Protected computer-use activity could not be published."
        );
        delivery
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
