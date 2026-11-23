//! Own mutation audits from response admission through body completion and write.
use super::repository::{AuditRecord, AuthRepository};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

pub(crate) struct MutationAudit {
    pub action: &'static str,
    pub result: &'static str,
    pub owner: Option<String>,
    pub session: Option<String>,
    pub resource_type: &'static str,
    pub resource: Option<String>,
    pub request_id: String,
}

pub struct AuditService {
    repository: AuthRepository,
    active: AtomicUsize,
    drained: Notify,
}

pub(crate) struct PendingAudit {
    service: Arc<AuditService>,
    record: MutationAudit,
}

impl Drop for PendingAudit {
    fn drop(&mut self) {
        if self.service.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.service.drained.notify_waiters();
        }
    }
}

impl AuditService {
    pub fn new(repository: AuthRepository) -> Arc<Self> {
        Arc::new(Self {
            repository,
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }

    pub(crate) fn admit(self: &Arc<Self>, record: MutationAudit) -> PendingAudit {
        self.active.fetch_add(1, Ordering::AcqRel);
        PendingAudit {
            service: self.clone(),
            record,
        }
    }

    pub async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
    }
}

impl PendingAudit {
    pub(crate) fn complete(self) {
        tokio::spawn(async move {
            // Retain the admission guard even if its response/caller disappears.
            let pending = self;
            let record = &pending.record;
            let owner = record.owner.as_deref();
            if pending
                .service
                .repository
                .audit(AuditRecord {
                    action: record.action,
                    result: record.result,
                    owner,
                    actor: owner,
                    session: record.session.as_deref(),
                    resource_type: record.resource_type,
                    resource: record.resource.as_deref(),
                    request_id: &record.request_id,
                })
                .await
                .is_err()
            {
                eprintln!(
                    "{}",
                    serde_json::json!({"event":"security.audit-write-failed","requestId":record.request_id})
                );
            }
        });
    }
}
