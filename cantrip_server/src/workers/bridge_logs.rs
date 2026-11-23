use super::{CommandError, Pending, WorkerBridge};
use crate::{
    operations::logging::{self, LogCall},
    wire::{Value, value::json},
};

#[derive(Clone, Copy)]
pub(super) enum FinishLog {
    Response,
    EventHandler,
    Timeout,
    Dispatch,
}
#[derive(Clone, Copy)]
pub(super) enum ConnectionLog {
    Connected,
    Recovered(f64),
    Replaced,
    IdentityChanged,
    Interrupted,
    Revoked(u16),
    Offline(f64),
}
impl WorkerBridge {
    pub(super) fn connection_log(&self, worker: &str, kind: ConnectionLog) {
        let (level, message, event, status, reason, duration) = match kind {
            ConnectionLog::Connected => (
                "info",
                "Worker connected",
                "worker.connection.connected",
                "online",
                None,
                None,
            ),
            ConnectionLog::Recovered(duration) => (
                "info",
                "Worker reconnected",
                "worker.connection.recovered",
                "online",
                None,
                Some(duration),
            ),
            ConnectionLog::Replaced => (
                "warn",
                "Worker connection replaced",
                "worker.connection.replaced",
                "replaced",
                None,
                None,
            ),
            ConnectionLog::IdentityChanged => (
                "warn",
                "Worker continuity identity changed",
                "worker.connection.identity-changed",
                "replaced",
                Some("continuity-identity-changed"),
                None,
            ),
            ConnectionLog::Interrupted => (
                "warn",
                "Worker connection interrupted",
                "worker.connection.interrupted",
                "reconnecting",
                Some("socket-disconnected"),
                None,
            ),
            ConnectionLog::Revoked(code) => (
                "warn",
                "Worker disconnected by server",
                "worker.connection.revoked",
                "offline",
                Some(if code == 1008 {
                    "credential-revoked"
                } else {
                    "server-disconnect"
                }),
                None,
            ),
            ConnectionLog::Offline(duration) => (
                "warn",
                "Worker reconnect grace expired",
                "worker.connection.offline",
                "offline",
                Some("reconnect-grace-expired"),
                Some(duration),
            ),
        };
        let mut context = json!({"event":event,"subsystem":"worker-connection","workerId":worker,"status":status});
        if let Some(reason) = reason {
            context["reasonCode"] = json!(reason);
        }
        if let Some(duration) = duration {
            context["durationMs"] = json!(duration);
        }
        (self.logger)(LogCall::event(level, message, context));
    }
    pub(super) fn invalid_control(&self, worker: &str) {
        (self.logger)(LogCall::repeated(
            format!("worker-envelope-invalid:{worker}").into(),
            "warn",
            "Worker sent an invalid control envelope",
            json!({"event":"worker.transport.invalid-envelope","subsystem":"worker-transport","reasonCode":"invalid-envelope","status":"rejected","workerId":worker}),
            None,
        ));
    }
    pub(super) fn command_offline(&self, worker: &str, command: &Value) {
        let operation = command.get("type");
        let mut context = json!({"event":"worker.command.rejected","subsystem":"worker-command","reasonCode":"worker-offline","status":"rejected","workerId":worker});
        if let Some(operation) = operation {
            context["operation"] = operation.clone();
        }
        let worker = json!(worker);
        let operation = operation.cloned().unwrap_or_else(|| json!("undefined"));
        (self.logger)(LogCall::repeated(
            logging::key("worker-command-offline:", &[&worker, &operation]),
            "warn",
            "Worker command could not be dispatched",
            context,
            None,
        ));
    }
    pub(super) fn command_dispatched(&self, pending: &Pending) {
        (self.logger)(LogCall::event(
            "debug",
            "Worker command dispatched",
            json!({"event":"worker.command.dispatched","subsystem":"worker-command","operation":pending.command,"requestId":pending.request_id,"status":"dispatched","workerId":pending.worker}),
        ));
    }
    pub(super) fn command_finished(
        &self,
        pending: &Pending,
        result: &Result<Option<Value>, CommandError>,
        kind: FinishLog,
    ) {
        let duration = pending
            .response_duration
            .lock()
            .unwrap()
            .unwrap_or_else(|| ((self.clock)() - pending.started_at).max(0.0));
        let (level, message, event, reason, status) = match kind {
            FinishLog::Response if result.is_ok() => (
                "debug",
                "Worker command completed",
                "worker.command.completed",
                None,
                "completed",
            ),
            FinishLog::Response => (
                "warn",
                "Worker command failed",
                "worker.command.failed",
                Some(
                    result
                        .as_ref()
                        .unwrap_err()
                        .code
                        .as_deref()
                        .unwrap_or("worker-reported-failure"),
                ),
                "failed",
            ),
            FinishLog::EventHandler => (
                "warn",
                "Worker command event handling failed",
                "worker.command.event-handler-failed",
                Some("event-handler-failed"),
                "failed",
            ),
            FinishLog::Timeout => (
                "warn",
                "Worker command timed out",
                "worker.command.timed-out",
                Some("timeout"),
                "failed",
            ),
            FinishLog::Dispatch => (
                "error",
                "Worker command dispatch failed",
                "worker.command.dispatch-failed",
                Some("socket-send-failed"),
                "failed",
            ),
        };
        let mut context = json!({"event":event,"subsystem":"worker-command","operation":pending.command,"requestId":pending.request_id,"status":status,"durationMs":duration,"workerId":pending.worker});
        if let Some(reason) = reason {
            context["reasonCode"] = json!(reason);
        }
        (self.logger)(LogCall::event(level, message, context));
    }
    pub(super) fn commands_abandoned(&self, worker: &str, count: usize) {
        if count > 0 {
            (self.logger)(LogCall::event(
                "warn",
                "Worker commands abandoned",
                json!({"event":"worker.command.abandoned","subsystem":"worker-command","reasonCode":"worker-offline","status":"failed","counts":json!({"requests":count}),"workerId":worker}),
            ));
        }
    }
    pub(super) fn shutdown_log(&self, counts: Option<(usize, usize)>) {
        let mut context = json!({"event":if counts.is_some(){"worker.bridge.shutdown-started"}else{"worker.bridge.shutdown-completed"},"subsystem":"worker-connection","status":if counts.is_some(){"stopping"}else{"stopped"}});
        if let Some((connected, pending)) = counts {
            context["counts"] = json!({"connectedWorkers":connected,"pendingRequests":pending});
        }
        (self.logger)(LogCall::event(
            "info",
            if counts.is_some() {
                "Worker bridge shutting down"
            } else {
                "Worker bridge stopped"
            },
            context,
        ));
    }
}
