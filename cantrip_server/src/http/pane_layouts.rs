use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    pane_layouts::{self, Conflict, LegacyInvariant, Repository},
    wire::{self, ValidationError, Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

fn failure(cause: anyhow::Error, read: bool) -> Result<Response> {
    if cause.is::<Conflict>() {
        return Ok(error(409, cause.to_string()));
    }
    if cause.is::<LegacyInvariant>() {
        return Ok(error(if read { 409 } else { 400 }, cause.to_string()));
    }
    Err(cause)
}
fn layout_output(value: &Value, legacy: bool) -> Result<Response> {
    if legacy {
        output(
            200,
            "legacyProjectTabLayoutWireSummarySchema",
            &pane_layouts::legacy(value),
        )
    } else {
        output(200, "projectTabLayoutWireSummarySchema", value)
    }
}
fn action(pattern: &str) -> (&'static str, &'static str) {
    let legacy = pattern.contains("/tab-groups");
    if pattern.ends_with("/surface-launchers") {
        return ("pin", "projectSurfaceLauncherPinSchema");
    }
    if pattern.contains("/builtin-surfaces/") {
        return ("builtin", "worktreeSelectionSchema");
    }
    if pattern.ends_with("/member/open") {
        return ("open", "projectSurfaceViewOpenSchema");
    }
    if pattern.ends_with("/member/close") {
        return ("close", "projectSurfaceViewCloseSchema");
    }
    if pattern.ends_with("/member/split") {
        return ("split", "projectPaneMemberSplitSchema");
    }
    if pattern.ends_with("/member/presentation") {
        return ("dock", "projectDockPresentationUpdateSchema");
    }
    if pattern.ends_with("/member") {
        return (
            "move",
            if legacy {
                "tabGroupMemberMoveSchema"
            } else {
                "projectPaneMemberMoveSchema"
            },
        );
    }
    if pattern.contains("/splits/") {
        return ("resize", "projectCenterSplitResizeSchema");
    }
    if pattern.ends_with("/members/order") {
        return (
            "member-order",
            if legacy {
                "tabGroupMemberOrderSchema"
            } else {
                "projectPaneMemberOrderSchema"
            },
        );
    }
    if pattern.ends_with("/order") {
        return (
            if legacy { "legacy-order" } else { "pane-order" },
            if legacy {
                "tabGroupOrderSchema"
            } else {
                "projectPaneOrderSchema"
            },
        );
    }
    (
        "title",
        if legacy {
            "encryptedTabGroupUpdateSchema"
        } else {
            "encryptedProjectPaneUpdateSchema"
        },
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    matched: MatchedPath,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let pattern = matched.as_str().to_owned();
    let read = request.method() == Method::GET || request.method() == Method::HEAD;
    let legacy = pattern.contains("/tab-groups");
    let launcher = pattern.ends_with("/surface-launchers");
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let project = params["projectId"].clone();
    let event_owner = owner.clone();
    let event_project = project.clone();
    let result: Result<Response> = async {
        if read {
            let repository = Repository::new(service.repository.database.clone());
            let result = if launcher {
                repository.launchers(&owner, &project).await
            } else {
                repository.get(&owner, &project).await
            };
            return match result {
                Ok(Some(value)) if launcher => {
                    output(200, "projectSurfaceLauncherListSchema", &value)
                }
                Ok(Some(value)) => layout_output(&value, legacy),
                Ok(None) => Ok(error(404, "Project not found.")),
                Err(cause) => failure(cause, true),
            };
        }
        let (action, schema) = action(&pattern);
        let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let mut input = if action == "builtin" {
            // Source accumulates definition and body issues in this order.
            let definition = wire::parse(
                "projectBuiltinSurfaceDefinitionIdSchema",
                Some(&json!(params["definitionId"])),
            );
            let body = wire::parse(schema, raw.as_ref());
            match (definition, body) {
                (Ok(_), Ok(input)) => input,
                (definition, body) => {
                    let mut issues = Vec::new();
                    for result in [definition, body] {
                        if let Err(cause) = result {
                            match cause {
                                ValidationError::Invalid(mut invalid) => {
                                    issues.append(&mut invalid)
                                }
                                ValidationError::Operation => {
                                    anyhow::bail!("Pane request validation failed.")
                                }
                            }
                        }
                    }
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        json!({"error":"Invalid request body","issues":issues}),
                    ));
                }
            }
        } else {
            match parse(schema, raw.as_ref())? {
                Ok(input) => input,
                Err(response) => return Ok(response),
            }
        };
        if legacy && action == "legacy-order" {
            input["paneIds"] = input["groupIds"].clone();
        }
        if legacy && action == "move" {
            input["targetPaneId"] = input["targetGroupId"].clone();
            if let Some(position) = input.get("targetGroupPosition").cloned() {
                input["targetPanePosition"] = position;
            }
        }
        let subject = params
            .get("paneId")
            .or_else(|| params.get("groupId"))
            .or_else(|| params.get("splitId"))
            .or_else(|| params.get("definitionId"))
            .map_or(Value::Null, |s| json!(s));
        let execution = service.clone();
        service
            .worker_maintenance
            .owned(async move {
                let repository = Repository::new(execution.repository.database.clone());
                let result = match action {
                    "pin" => repository.pin(&owner, &project, &input).await,
                    "builtin" => {
                        repository
                            .builtin_worktree(&owner, &project, &subject, &input["worktreeId"])
                            .await
                    }
                    "open" => repository.open(&owner, &project, &input).await,
                    "close" => repository.close(&owner, &project, &input).await,
                    _ => {
                        repository
                            .mutate(&owner, &project, action, &subject, &input)
                            .await
                    }
                };
                match result {
                    Ok(Some(value)) if action == "pin" => {
                        output(200, "projectSurfaceLauncherSchema", &value)
                    }
                    Ok(Some(mut value)) if action == "open" || action == "close" => {
                        if legacy {
                            value["layout"] = pane_layouts::legacy(&value["layout"]);
                        }
                        output(
                            200,
                            match (action, legacy) {
                                ("open", false) => "projectSurfaceViewOpenResultSchema",
                                ("open", true) => "legacyProjectSurfaceViewOpenResultSchema",
                                (_, false) => "projectSurfaceViewCloseResultSchema",
                                (_, true) => "legacyProjectSurfaceViewCloseResultSchema",
                            },
                            &value,
                        )
                    }
                    Ok(Some(value)) => layout_output(&value, legacy),
                    Ok(None) => Ok(error(
                        404,
                        if action == "builtin" {
                            "Project or worktree not found."
                        } else {
                            "Project not found."
                        },
                    )),
                    Err(cause) => failure(cause, false),
                }
            })
            .await
    }
    .await;
    let response = result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause));
    if !read
        && !launcher
        && !pattern.contains("/builtin-surfaces/")
        && response.status().as_u16() < 400
    {
        let live = service.live.clone();
        super::on_response::completed(response, move || {
            for resource in ["project", "project-tab-layout"] {
                let _=live.publish_event(json!({"ownerId":event_owner,"scope":json!({"kind":"project","projectId":event_project}),"resource":resource,"action":"invalidated","entityId":event_project,"revision":Value::Null,"payload":Value::Null}));
            }
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/panes", get(handle))
        .route("/api/projects/{projectId}/panes/order", patch(handle))
        .route("/api/projects/{projectId}/panes/{paneId}", patch(handle))
        .route(
            "/api/projects/{projectId}/panes/{paneId}/members/order",
            patch(handle),
        )
        .route("/api/projects/{projectId}/panes/member", patch(handle))
        .route(
            "/api/projects/{projectId}/panes/member/split",
            patch(handle),
        )
        .route(
            "/api/projects/{projectId}/panes/splits/{splitId}",
            patch(handle),
        )
        .route(
            "/api/projects/{projectId}/panes/member/presentation",
            patch(handle),
        )
        .route("/api/projects/{projectId}/panes/member/open", post(handle))
        .route("/api/projects/{projectId}/panes/member/close", post(handle))
        .route(
            "/api/projects/{projectId}/surface-launchers",
            get(handle).patch(handle),
        )
        .route(
            "/api/projects/{projectId}/builtin-surfaces/{definitionId}/worktree",
            patch(handle),
        )
        .route("/api/projects/{projectId}/tab-groups", get(handle))
        .route("/api/projects/{projectId}/tab-groups/order", patch(handle))
        .route(
            "/api/projects/{projectId}/tab-groups/{groupId}",
            patch(handle),
        )
        .route(
            "/api/projects/{projectId}/tab-groups/{groupId}/members/order",
            patch(handle),
        )
        .route("/api/projects/{projectId}/tab-groups/member", patch(handle))
        .route(
            "/api/projects/{projectId}/tab-groups/member/open",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/tab-groups/member/close",
            post(handle),
        )
}
