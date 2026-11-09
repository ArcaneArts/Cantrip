//! Enrollment and credential decisions share capture, redaction and noise policy.
use crate::{
    operations::logging::{self, LogCall, key},
    wire::{Value, value::json},
};

fn emit(call: LogCall) {
    logging::server()
        .dispatch(call)
        .expect("valid worker lifecycle record");
}
pub(super) fn created(request: &str, id: &str, worker: Option<&str>, expires: i64) {
    emit(LogCall::event(
        "info",
        "Worker enrollment code created",
        json!({"event":"worker.enrollment.code_created","subsystem":"worker-auth","operation":"create-enrollment-code","status":"completed","requestId":request,"enrollmentCodeId":id,"workerId":worker,"expiresInSeconds":expires}),
    ));
}
pub(super) fn enrolled(
    request: &str,
    worker: &str,
    metadata: &serde_json::Value,
    replaced: Option<&str>,
) {
    let mut context = json!({"event":"worker.enrollment.completed","subsystem":"worker-auth","operation":"enroll","status":"completed","requestId":request,"workerId":worker});
    let mut undefined = vec![];
    for field in ["platform", "architecture"] {
        context[field] = metadata.get(field).map_or_else(
            || {
                undefined.push(field);
                Value::Null
            },
            Value::from_serialize,
        );
    }
    context["replacedWorkerId"] = replaced.map_or_else(
        || {
            undefined.push("replacedWorkerId");
            Value::Null
        },
        |id| json!(id),
    );
    logging::server()
        .event_with_undefined(
            "info",
            &"Worker enrollment completed".into(),
            Some(&context),
            &undefined,
        )
        .expect("valid enrollment record");
}
pub(super) fn rejected(request: &str, worker: &str) {
    emit(LogCall::repeated(
        key("worker-enrollment-rejected:", &[&json!(worker)]),
        "warn",
        "Worker enrollment rejected",
        json!({"event":"worker.enrollment.rejected","subsystem":"worker-auth","operation":"enroll","status":"rejected","reasonCode":"invalid_or_conflicting_enrollment","requestId":request,"workerId":worker}),
        Some(json!({"summaryEvery":5,"windowMs":300000})),
    ));
}
pub(super) fn rotated(request: &str, worker: &str, delivered: bool, previous: usize) {
    let context = json!({"event":"worker.credential.rotated","subsystem":"worker-auth","operation":"rotate","status":if delivered {"completed"} else {"degraded"},"reasonCode":if delivered {Value::Null} else {json!("worker_delivery_failed")},"requestId":request,"workerId":worker,"counts":json!({"previousCredentials":previous})});
    logging::server()
        .event_with_undefined(
            "info",
            &"Worker credential rotated".into(),
            Some(&context),
            if delivered { &["reasonCode"] } else { &[] },
        )
        .expect("valid credential rotation record");
}
pub(super) fn revoked(request: &str, worker: &str, credential: &str) {
    emit(LogCall::event(
        "info",
        "Worker credential revoked",
        json!({"event":"worker.credential.revoked","subsystem":"worker-auth","operation":"revoke","status":"completed","requestId":request,"workerId":worker,"credentialId":credential}),
    ));
}
