use crate::auth::{
    audit::MutationAudit,
    service::{AuthService, Principal},
};
use axum::response::Response;
use std::sync::Arc;

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
pub(super) fn response(
    service: &Arc<AuthService>,
    principal: &Principal,
    request_id: &str,
    method: &str,
    pattern: &str,
    path: &str,
    response: Response,
) -> Response {
    if method == "OPTIONS" || !principal.authenticated() {
        return response;
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
        return response;
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
    let owner = principal.user.as_ref().map(|u| u.id.clone());
    let status = response.status().as_u16();
    let result = if status < 400 {
        "succeeded"
    } else if [401, 403].contains(&status) {
        "denied"
    } else {
        "failed"
    };
    let pending = service.mutation_audits.admit(MutationAudit {
        action,
        result,
        owner,
        session: principal.session_id.clone(),
        resource_type,
        resource,
        request_id: request_id.to_owned(),
    });
    let complete = move || pending.complete();
    if method == "HEAD" {
        super::on_response::finished_head(response, complete)
    } else {
        super::on_response::finished(response, complete)
    }
}
