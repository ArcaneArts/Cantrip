use super::{
    Conflict, Repository, center, invariant, now, placement,
    queries::{self, run},
};
use crate::{
    database::Executor,
    wire::{JsString, Value, value::json},
};
use anyhow::{Context, Result};

fn definition(resource: &Value) -> Option<&'static Value> {
    queries::manifest()
        .definitions
        .iter()
        .find(|d| d["id"] == resource["definitionId"])
}
fn tab_kind(resource: &Value) -> Option<&'static str> {
    if resource["kind"] == "builtin" {
        Some("builtin")
    } else {
        definition(resource).and_then(|d| d["tabKind"].as_str())
    }
}
fn tab_id(resource: &Value) -> &Value {
    &resource[if resource["kind"] == "builtin" {
        "definitionId"
    } else {
        "resourceId"
    }]
}
fn prefixed(prefix: &str, text: &Value) -> Result<Value> {
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    units.extend(
        text.as_js_string()
            .context("Surface resource identity")?
            .units(),
    );
    Ok(Value::String(JsString::new(units)))
}
fn view_id(project: &str, resource: &Value) -> Result<Value> {
    if resource["kind"] == "builtin" {
        return prefixed(
            &format!(
                "builtin:{}:",
                crate::workspace_layouts::component(&json!(project))?
            ),
            &resource["definitionId"],
        );
    }
    let kind = tab_kind(resource).ok_or_else(|| {
        anyhow::anyhow!(
            "Surface definition {} is not entity-backed.",
            resource["definitionId"].as_js_string().unwrap().lossy()
        )
    })?;
    let prefix = match kind {
        "chat" => "chat:",
        "terminal" => "terminal:",
        "explorer" => "explorer:",
        "browser" => "browser:",
        "code" => "code:",
        _ => "view:",
    };
    prefixed(prefix, &resource["resourceId"])
}
async fn resolve(executor: Executor<'_, '_>, project: &str, resource: &Value) -> Result<bool> {
    let mut fields = json!({"project":project});
    Ok(
        crate::workspace_layouts::resolve_on(executor, &mut fields, resource)
            .await?
            .is_some(),
    )
}
async fn last_member_position(executor: Executor<'_, '_>, pane: &Value) -> Result<i64> {
    Ok(
        run(executor, "last_member_position", &[pane.clone(), json!(1)])
            .await?
            .first()
            .map(|r| r.get::<i32>(0))
            .transpose()?
            .map_or(0, |p| i64::from(p) + 1),
    )
}
async fn attach(
    executor: Executor<'_, '_>,
    project: &str,
    input: &Value,
    view: &Value,
) -> Result<Value> {
    let resource = &input["surfaceRef"];
    let kind = tab_kind(resource).context("Entity-backed surface kind")?;
    let id = tab_id(resource);
    let (pane, position, created_center) =
        if let Some(explicit) = input.get("targetPaneId").filter(|v| !v.is_null()) {
            let rows = run(
                executor,
                "attach_pane",
                &[explicit.clone(), json!(project), json!(1)],
            )
            .await?;
            let row = rows.first().ok_or_else(|| {
                invariant("The destination pane does not belong to this project.")
            })?;
            placement::supports(
                kind,
                id,
                &row.get::<String>(1)?,
                Some(&resource["definitionId"]),
            )?;
            (
                explicit.clone(),
                last_member_position(executor, explicit).await?,
                false,
            )
        } else {
            let region = if let Some(region) = input.get("targetRegion").filter(|v| !v.is_null()) {
                region.as_str().context("Surface target region")?.to_owned()
            } else {
                let definition = definition(resource).ok_or_else(|| {
                    invariant(&format!(
                        "Surface definition {} is unavailable.",
                        resource["definitionId"].as_js_string().unwrap().lossy()
                    ))
                })?;
                let rows = run(executor, "placement_profile", &[json!(project), json!(1)]).await?;
                let profile = rows
                    .first()
                    .map(|r| r.get::<Option<String>>(0))
                    .transpose()?
                    .flatten()
                    .unwrap_or_else(|| "hybrid".into());
                definition["profiles"]
                    .get(&profile)
                    .unwrap_or(&definition["profiles"]["hybrid"])
                    .as_str()
                    .context("Surface profile placement")?
                    .to_owned()
            };
            placement::supports(kind, id, &region, Some(&resource["definitionId"]))?;
            let panes = placement::region_panes(executor, project, &region).await?;
            placement::assert_dock(&panes, &region)?;
            if (region == "right" || region == "bottom") && !panes.is_empty() {
                (
                    panes[0].id.clone(),
                    last_member_position(executor, &panes[0].id).await?,
                    false,
                )
            } else {
                let pane = json!(uuid::Uuid::new_v4().to_string());
                run(
                    executor,
                    "insert_pane",
                    &[
                        pane.clone(),
                        json!(project),
                        json!(region),
                        json!(panes.last().map_or(0, |p| i64::from(p.position) + 1)),
                        view.clone(),
                    ],
                )
                .await?;
                (pane, 0, region == "center")
            }
        };
    run(
        executor,
        "insert_member",
        &[
            view.clone(),
            pane.clone(),
            json!(project),
            json!(kind),
            id.clone(),
            json!(position),
        ],
    )
    .await?;
    if created_center {
        center::append(executor, project, &pane).await?;
    }
    Ok(pane)
}
impl Repository {
    pub async fn open(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
        let resource = &input["surfaceRef"];
        if resource["kind"] == "builtin" && resource["definitionId"] == "project.overview" {
            return Err(invariant("Overview is a project page, not a tab."));
        }
        let Some(current) = self.get(owner, project).await? else {
            return Ok(None);
        };
        let view = view_id(project, resource)?;
        let kind = tab_kind(resource)
            .ok_or_else(|| invariant("The surface definition is not currently entity-backed."))?;
        for pane in current["panes"].as_array().unwrap() {
            if let Some(member) = pane["members"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["tabKey"] == view)
            {
                if member["tabKind"] != kind
                    || member["tabId"] != *tab_id(resource)
                    || resource["kind"] == "entity"
                        && !resolve(Executor::Database(&self.database), project, resource).await?
                {
                    return Err(invariant(
                        "The open view does not match the requested surface resource.",
                    ));
                }
                return Ok(Some(
                    json!({"disposition":"focused","viewId":view,"paneId":pane["id"],"layout":current}),
                ));
            }
        }
        let (owner_id, project_id, input_copy, view_copy) = (
            owner.to_owned(),
            project.to_owned(),
            input.clone(),
            view.clone(),
        );
        let pane = self
            .database
            .transaction(|tx| {
                Box::pin(async move {
                    let executor = Executor::Transaction(tx);
                    if run(
                        executor,
                        "claim",
                        &[
                            now(),
                            json!(project_id),
                            json!(owner_id),
                            input_copy["revision"].clone(),
                        ],
                    )
                    .await?
                    .is_empty()
                    {
                        return Err(Conflict.into());
                    }
                    let resource = &input_copy["surfaceRef"];
                    if resource["kind"] == "builtin" {
                        run(
                            executor,
                            "builtin_create",
                            &[json!(project_id), resource["definitionId"].clone()],
                        )
                        .await?;
                    } else if !resolve(executor, &project_id, resource).await? {
                        return Err(invariant(
                            "The surface resource is unavailable in this project.",
                        ));
                    }
                    attach(executor, &project_id, &input_copy, &view_copy).await
                })
            })
            .await?;
        let layout = self.get(owner, project).await?.ok_or_else(|| {
            invariant("The project disappeared while its surface view was opening.")
        })?;
        Ok(Some(
            json!({"disposition":"opened","viewId":view,"paneId":pane,"layout":layout}),
        ))
    }
    pub async fn close(&self, owner: &str, project: &str, input: &Value) -> Result<Option<Value>> {
        let Some(current) = self.get(owner, project).await? else {
            return Ok(None);
        };
        let view = &input["viewId"];
        if !current["panes"].as_array().unwrap().iter().any(|p| {
            p["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["tabKey"] == *view)
        }) {
            return Ok(Some(
                json!({"disposition":"already-closed","viewId":view,"layout":current}),
            ));
        }
        let (owner_id, project_id, input_copy) =
            (owner.to_owned(), project.to_owned(), input.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let executor = Executor::Transaction(tx);
                    if run(
                        executor,
                        "claim",
                        &[
                            now(),
                            json!(project_id),
                            json!(owner_id),
                            input_copy["revision"].clone(),
                        ],
                    )
                    .await?
                    .is_empty()
                    {
                        return Err(Conflict.into());
                    }
                    if !placement::detach(executor, &project_id, &input_copy["viewId"]).await? {
                        return Err(Conflict.into());
                    }
                    Ok(())
                })
            })
            .await?;
        let layout = self.get(owner, project).await?.ok_or_else(|| {
            invariant("The project disappeared while its surface view was closing.")
        })?;
        Ok(Some(
            json!({"disposition":"closed","viewId":view,"layout":layout}),
        ))
    }
}
