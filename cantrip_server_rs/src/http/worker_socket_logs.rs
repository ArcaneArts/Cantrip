//! Authentication decisions use the shared capture/minimization/noise policy.
use crate::{
    operations::logging::{self, LogCall, key},
    wire::value::json,
};

pub(super) enum Rejection {
    MissingWorker,
    InvalidGeneration,
    InvalidCredential,
    Revoked,
    OwnerMismatch,
}
pub(super) fn rejected(request: &str, worker: Option<&str>, rejection: Rejection) {
    let (prefix, message, reason) = match rejection {
        Rejection::MissingWorker => (
            Some("worker-connect-missing-id"),
            "Worker connection rejected",
            "worker-id-missing",
        ),
        Rejection::InvalidGeneration => (
            Some("worker-connect-invalid-generation:"),
            "Worker connection rejected",
            "connection-generation-invalid",
        ),
        Rejection::InvalidCredential => (
            Some("worker-connect-unauthorized:"),
            "Worker connection authentication failed",
            "invalid-credential",
        ),
        Rejection::Revoked => (
            None,
            "Revoked worker credential rejected",
            "credential-revoked",
        ),
        Rejection::OwnerMismatch => (None, "Worker identity mismatch rejected", "owner-mismatch"),
    };
    let mut context = json!({"event":"worker.authentication.rejected","subsystem":"worker-connection","operation":"connect","reasonCode":reason,"requestId":request,"status":"rejected"});
    if let Some(worker) = worker {
        context["workerId"] = json!(worker);
    }
    let call = match prefix {
        Some(prefix) => LogCall::repeated(
            worker.map_or_else(|| prefix.into(), |worker| key(prefix, &[&json!(worker)])),
            "warn",
            message,
            context,
            None,
        ),
        None => LogCall::event("warn", message, context),
    };
    logging::server()
        .dispatch(call)
        .expect("valid worker authentication record");
}
pub(super) fn authenticated(request: &str, worker: &str, generation: &str) {
    let call = LogCall::event(
        "info",
        "Worker command channel authenticated",
        json!({"event":"worker.authentication.completed","subsystem":"worker-connection","operation":"connect","requestId":request,"status":"authenticated","workerId":worker,"workerProcessGeneration":generation}),
    );
    logging::server()
        .dispatch(call)
        .expect("valid worker authentication record");
}
pub(super) fn claim_failed(request: &str, worker: &str, error: &anyhow::Error) {
    let call = LogCall::event(
        "error",
        "Could not claim worker connection",
        json!({"event":"worker.connection.claim-failed","subsystem":"worker-connection","operation":"connect","reasonCode":"coordination-unavailable","requestId":request,"status":"failed","workerId":worker,"error":logging::error_details(error)}),
    );
    logging::server()
        .dispatch(call)
        .expect("valid worker connection record");
}
