use crate::auth::{
    repository::AuditRecord,
    service::{AuthService, Principal},
};
use serde_json::json;

fn descriptor(method: &str, route: &str) -> Option<(&'static str, &'static str)> {
    if route.starts_with("/api/encryption") && method != "GET" {
        return Some(("encryption.registry-changed", "encryption-registry"));
    }
    if route.starts_with("/api/admin/license-whitelist") && method != "GET" {
        return Some(("account-license.configuration-changed", "account-license"));
    }
    if method == "GET" && route == "/api/projects/:projectId/chats" {
        return Some(("project.accessed", "project"));
    }
    if method == "POST" && route == "/api/workers/enrollment-codes" {
        return Some(("worker.pairing-code-created", "worker"));
    }
    if method == "POST" && route == "/api/run-configuration-runtimes/operations" {
        return Some((
            "run.configuration.lifecycle-requested",
            "run-configuration-runtime",
        ));
    }
    if route.starts_with("/api/workers/") && method != "GET" {
        return Some(("worker.configuration-changed", "worker"));
    }
    if (route.starts_with("/api/settings/providers") || route.contains("/mcp-servers"))
        && method != "GET"
    {
        return Some(("secret.configuration-changed", "secret"));
    }
    if route.contains("/git/") && method != "GET" {
        return Some(("git.operation-requested", "project"));
    }
    if route.contains("/replica") && method != "GET" {
        return Some(("project-replica.configuration-changed", "project-replica"));
    }
    if route.starts_with("/api/projects") && method != "GET" {
        return Some(("project.configuration-changed", "project"));
    }
    None
}
pub(super) async fn mutation(
    service: &AuthService,
    principal: &Principal,
    request_id: &str,
    method: &str,
    pattern: &str,
    path: &str,
    status: u16,
) {
    if method == "OPTIONS" || !principal.authenticated() {
        return;
    }
    let route = pattern
        .split('/')
        .map(|s| {
            s.strip_prefix('{')
                .and_then(|s| s.strip_suffix('}'))
                .map_or_else(|| s.to_owned(), |s| format!(":{s}"))
        })
        .collect::<Vec<_>>()
        .join("/");
    let Some((action, resource_type)) = descriptor(method, &route) else {
        return;
    };
    let parameters = pattern
        .split('/')
        .zip(path.split('/'))
        .filter_map(|(key, value)| {
            key.strip_prefix('{')
                .and_then(|k| k.strip_suffix('}'))
                .map(|k| (k, value))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let resource = [
        "grantId",
        "principalId",
        "credentialId",
        "workerId",
        "providerId",
        "policyId",
        "serverId",
        "projectReplicaId",
        "replicaId",
        "projectId",
    ]
    .into_iter()
    .find_map(|key| {
        parameters.get(key).filter(|v| !v.is_empty()).and_then(|v| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8()
                .ok()
                .map(|v| v.into_owned())
        })
    });
    let owner = principal.user.as_ref().map(|u| u.id.as_str());
    let result = if status < 400 {
        "succeeded"
    } else if [401, 403].contains(&status) {
        "denied"
    } else {
        "failed"
    };
    if service
        .repository
        .audit(AuditRecord {
            action,
            result,
            owner,
            actor: owner,
            session: principal.session_id.as_deref(),
            resource_type,
            resource: resource.as_deref(),
            request_id,
        })
        .await
        .is_err()
    {
        eprintln!(
            "{}",
            json!({"event":"security.audit-write-failed","requestId":request_id})
        );
    }
}
