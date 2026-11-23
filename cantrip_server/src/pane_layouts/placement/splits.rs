use super::*;

pub(in crate::pane_layouts) async fn split_member(
    executor: Executor<'_, '_>,
    project: &str,
    input: &Value,
) -> Result<()> {
    let key = &input["tabKey"];
    let (member, source) = selected(
        executor,
        project,
        key,
        "The split tab does not belong to this project.",
    )
    .await?;
    let destination = target(executor, project, &input["targetPaneId"])
        .await?
        .filter(|p| p.region == "center")
        .ok_or_else(|| invariant("A center split must target a center pane in this project."))?;
    supports(&member.kind, &member.id, "center", None)?;
    let root = center::read(executor, project).await?;
    if root.is_null() {
        return Err(invariant("The center layout root is missing."));
    }
    center::exact(executor, project, &root).await?;
    let source_members = members(executor, &source.id).await?;
    if source.id == destination.id && source_members.len() == 1 {
        return Err(invariant("A pane's final tab cannot split that same pane."));
    }
    run(executor, "delete_member", std::slice::from_ref(key)).await?;
    let remaining = source_members
        .into_iter()
        .filter(|m| m.key != *key)
        .collect::<Vec<_>>();
    if remaining.is_empty() {
        run(executor, "delete_pane", std::slice::from_ref(&source.id)).await?;
        if source.region == "center" {
            center::remove(executor, project, &source.id).await?;
        } else {
            group_positions(
                executor,
                &ids(&region_panes(executor, project, &source.region).await?),
            )
            .await?;
        }
    } else {
        repair_source(executor, &source, &remaining, key, true).await?;
    }
    let pane = json!(uuid::Uuid::new_v4().to_string());
    let panes = region_panes(executor, project, "center").await?;
    run(
        executor,
        "insert_pane",
        &[
            pane.clone(),
            json!(project),
            json!("center"),
            json!(panes.last().map_or(0, |p| i64::from(p.position) + 1)),
            key.clone(),
        ],
    )
    .await?;
    member.copy_to(executor, &pane, &json!(0)).await?;
    let root = center::read(executor, project).await?;
    if root.is_null() {
        return Err(invariant(
            "The split target disappeared from the center layout.",
        ));
    }
    let leaf = json!({"kind":"pane","paneId":pane});
    let old = json!({"kind":"pane","paneId":input["targetPaneId"]});
    let new_first = input["edge"] == "left" || input["edge"] == "top";
    let horizontal = input["edge"] == "left" || input["edge"] == "right";
    let split = json!({"kind":"split","id":uuid::Uuid::new_v4().to_string(),"direction":if horizontal{"horizontal"}else{"vertical"},"fraction":input["fraction"],"first":if new_first{leaf.clone()}else{old.clone()},"second":if new_first{old}else{leaf}});
    let (next, replaced) = center::replace(&root, &input["targetPaneId"], &split);
    if !replaced {
        return Err(invariant(
            "The split target is missing from the center layout.",
        ));
    }
    center::persist(executor, project, &next).await
}
