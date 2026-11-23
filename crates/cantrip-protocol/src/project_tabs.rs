//! Legacy pane contracts consumed when seeding device-workspace ownership.
use super::{Parsed, ValidationError, Value, coercion, value::json};
use std::collections::HashSet;

fn values<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if ![
        "workspace-pane-title",
        "project-tab-member",
        "project-pane",
        "project-tab-layout",
        "legacy-project-pane",
        "legacy-project-layout",
        "pane-move",
        "legacy-pane-move",
    ]
    .contains(&tag)
    {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    macro_rules! issue {
        ($suffix:expr, $message:expr $(,)?) => {{
            let mut at = path.to_vec();
            at.extend($suffix);
            result.issue(json!({"code":"custom"}), &at, $message.into(), false);
        }};
    }
    match tag {
        "workspace-pane-title" => {
            if value["classification"]["recordKind"] != "tab-group" {
                issue!(vec![], "Pane titles require tab-group classification.");
            }
        }
        "project-tab-member" => {
            let expected = match value["tabKind"].as_str() {
                Some("chat") => Some("chat"),
                Some("terminal") => Some("terminal"),
                Some("explorer") => Some("explorer"),
                Some("browser") => Some("browser"),
                Some("code") => Some("code-tab"),
                Some("builtin") => None,
                _ => Some("project-view"),
            };
            if value["titleProtection"].is_null() {
                if value["tabKind"] != "terminal" && value["tabKind"] != "builtin" {
                    issue!(
                        vec![json!("titleProtection")],
                        "Only Run configuration terminal tabs may omit a protected title.",
                    );
                }
            } else if expected
                .is_none_or(|kind| value["titleProtection"]["classification"]["recordKind"] != kind)
            {
                issue!(
                    vec![
                        json!("titleProtection"),
                        json!("classification"),
                        json!("recordKind"),
                    ],
                    "Tab-member title classification must match its surface kind.",
                );
            }
            if value["tabKind"] == "builtin" {
                if super::parse(
                    "projectBuiltinSurfaceDefinitionIdSchema",
                    value.get("tabId"),
                )
                .is_err()
                {
                    issue!(
                        vec![json!("tabId")],
                        "Built-in tab id must be a built-in surface definition.",
                    );
                }
                if !coercion::truthy(value.get("builtInState")) {
                    issue!(
                        vec![json!("builtInState")],
                        "Built-in tabs must include their persisted state.",
                    );
                } else if value["builtInState"]["definitionId"] != value["tabId"] {
                    issue!(
                        vec![json!("builtInState"), json!("definitionId")],
                        "Built-in tab state must match its definition id.",
                    );
                }
            } else if !value["builtInState"].is_null() {
                issue!(
                    vec![json!("builtInState")],
                    "Entity-backed tabs cannot include built-in state.",
                );
            }
        }
        "project-pane" | "legacy-project-pane" => {
            for (index, member) in values(&value, "members").iter().enumerate() {
                if member[if tag == "legacy-project-pane" {
                    "groupId"
                } else {
                    "paneId"
                }] != value["id"]
                {
                    issue!(
                        vec![json!("members"), json!(index), json!("paneId")],
                        "Pane members must reference their containing pane.",
                    );
                }
                if member["projectId"] != value["projectId"] {
                    issue!(
                        vec![json!("members"), json!(index), json!("projectId")],
                        "Pane members must belong to the pane project.",
                    );
                }
                if value.get("region").is_some()
                    && value["region"] != "right"
                    && value["region"] != "bottom"
                    && !member["dockPresentation"].is_null()
                {
                    issue!(
                        vec![json!("members"), json!(index), json!("dockPresentation")],
                        "Dock presentation is only valid in right or bottom panes.",
                    );
                }
            }
            if tag == "project-pane" {
                let direct = value.get("conversationView").filter(|v| !v.is_null());
                if values(&value, "members").is_empty() && direct.is_none() {
                    let mut at = path.to_vec();
                    at.push(json!("members"));
                    result.issue(
                        json!({"code":"too_small","origin":"array","minimum":1,"inclusive":true}),
                        &at,
                        "Too small: expected array to have >=1 items".into(),
                        false,
                    );
                }
                if let Some(view) = direct
                    && (value["region"] != "center"
                        || view["tabKind"] != "chat"
                        || view["paneId"] != value["id"]
                        || view["projectId"] != value["projectId"])
                {
                    issue!(
                        vec![json!("conversationView")],
                        "Conversation content must be an Agent view owned by this center pane."
                    );
                }
            }
            if coercion::truthy(value.get("titleProtection"))
                && value["titleProtection"]["classification"]["recordKind"] != "tab-group"
            {
                issue!(
                    vec![
                        json!("titleProtection"),
                        json!("classification"),
                        json!("recordKind"),
                    ],
                    "Tab-group title classification must be tab-group.",
                );
            }
            if values(&value, "members").len() == 1 && !value["titleProtection"].is_null() {
                issue!(
                    vec![json!("titleProtection")],
                    "A single-tab group derives its title from its member.",
                );
            }
        }
        "project-tab-layout" | "legacy-project-layout" => {
            let mut tabs = HashSet::new();
            for (pi, pane) in values(
                &value,
                if tag == "legacy-project-layout" {
                    "groups"
                } else {
                    "panes"
                },
            )
            .iter()
            .enumerate()
            {
                if pane["projectId"] != value["projectId"] {
                    issue!(
                        vec![json!("panes"), json!(pi), json!("projectId")],
                        "Panes must belong to the layout project.",
                    );
                }
                for (mi, member) in values(pane, "members")
                    .iter()
                    .chain(pane.get("conversationView").filter(|v| !v.is_null()))
                    .enumerate()
                {
                    if !tabs.insert(
                        member["tabKey"]
                            .as_js_string()
                            .ok_or(ValidationError::Operation)?
                            .clone(),
                    ) {
                        issue!(
                            vec![
                                json!("panes"),
                                json!(pi),
                                json!("members"),
                                json!(mi),
                                json!("tabKey"),
                            ],
                            "A surface view may be placed in at most one pane.",
                        );
                    }
                }
            }
            if let Some(root) = value.get("centerRoot") {
                let centers: Vec<_> = values(&value, "panes")
                    .iter()
                    .filter(|p| p["region"] == "center")
                    .map(|p| p["id"].clone())
                    .collect();
                if root.is_null() {
                    if !centers.is_empty() {
                        issue!(
                            vec![json!("centerRoot")],
                            "A center layout root is required when center panes exist.",
                        );
                    }
                } else {
                    let mut leaves = Vec::new();
                    let mut splits = Vec::new();
                    let mut pending = vec![(root, vec![json!("centerRoot")], 1)];
                    let mut count = 0;
                    while let Some((node, at, depth)) = pending.pop() {
                        count += 1;
                        if depth > 32 || count > 255 {
                            issue!(
                                at,
                                "The center layout exceeds its supported topology bounds.",
                            );
                            continue;
                        }
                        if node["kind"] == "pane" {
                            let mut leaf_path = at;
                            leaf_path.push(json!("paneId"));
                            if leaves.contains(&node["paneId"]) {
                                issue!(
                                    leaf_path.clone(),
                                    "A center pane may appear in the layout tree only once.",
                                );
                            }
                            leaves.push(node["paneId"].clone());
                            if !centers.contains(&node["paneId"]) {
                                issue!(
                                    leaf_path,
                                    "Center layout leaves must reference center panes.",
                                );
                            }
                        } else {
                            if splits.contains(&node["id"]) {
                                let mut split_path = at.clone();
                                split_path.push(json!("id"));
                                issue!(split_path, "Center split ids must be unique.");
                            }
                            splits.push(node["id"].clone());
                            let mut second = at.clone();
                            second.push(json!("second"));
                            let mut first = at;
                            first.push(json!("first"));
                            pending.push((&node["second"], second, depth + 1));
                            pending.push((&node["first"], first, depth + 1));
                        }
                    }
                    // JS Set iteration reports each missing center identity once.
                    let mut reported = Vec::new();
                    for pane in centers {
                        if !leaves.contains(&pane) && !reported.contains(&pane) {
                            issue!(
                                vec![json!("centerRoot")],
                                "Every center pane must appear in the layout tree.",
                            );
                            reported.push(pane);
                        }
                    }
                }
            }
        }
        "pane-move" => {
            if !value["targetPaneId"].is_null() && value.get("targetRegion").is_some() {
                issue!(
                    vec![json!("targetRegion")],
                    "Specify either a target pane or a target region, not both.",
                );
            }
            if value["targetPaneId"].is_null()
                && value.get("targetPanePosition").is_none()
                && value["targetRegion"] != "right"
                && value["targetRegion"] != "bottom"
            {
                issue!(
                    vec![json!("targetPanePosition")],
                    "A pane position is required when splitting a tab into a new pane.",
                );
            }
        }
        "legacy-pane-move" => {
            if value["targetGroupId"].is_null() && value.get("targetGroupPosition").is_none() {
                issue!(
                    vec![json!("targetGroupPosition")],
                    "A sidebar position is required when splitting a tab into a new group.",
                );
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}
