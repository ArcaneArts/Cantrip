use super::*;

pub(in crate::pane_layouts) async fn move_member(
    executor: Executor<'_, '_>,
    project: &str,
    input: &Value,
) -> Result<()> {
    let key = &input["tabKey"];
    let (member, source) = selected(
        executor,
        project,
        key,
        "The moved tab does not belong to this project.",
    )
    .await?;
    let source_panes = region_panes(executor, project, &source.region).await?;
    let source_members = members(executor, &source.id).await?;
    let target_id = &input["targetPaneId"];
    if !target_id.is_null() && input.get("targetRegion").is_some() {
        return Err(invariant(
            "Specify either a target pane or a target region, not both.",
        ));
    }
    let mut region = input
        .get("targetRegion")
        .and_then(Value::as_str)
        .unwrap_or(&source.region)
        .to_owned();
    let mut target_panes = None;
    let mut destination = None;
    if !target_id.is_null() {
        let pane = target(executor, project, target_id)
            .await?
            .ok_or_else(|| invariant("The destination pane does not belong to this project."))?;
        region = pane.region.clone();
        destination = Some(pane);
    } else if region != source.region {
        target_panes = Some(region_panes(executor, project, &region).await?);
    }
    let target_panes = target_panes.as_deref().unwrap_or(&source_panes);
    if target_id.is_null() {
        assert_dock(target_panes, &region)?;
        if dock(&region) {
            destination = target_panes.first().map(|p| Pane {
                id: p.id.clone(),
                region: p.region.clone(),
                position: p.position,
                anchor: p.anchor.clone(),
            });
        }
    }
    supports(&member.kind, &member.id, &region, None)?;
    if destination.as_ref().is_some_and(|p| p.id == source.id) {
        return member_positions(
            executor,
            &source.id,
            &moved(keys(&source_members), key, &input["targetMemberPosition"]),
        )
        .await;
    }
    if destination.is_none()
        && dock(&region)
        && region != source.region
        && target_panes.is_empty()
        && source_members.len() == 1
    {
        run(
            executor,
            "pane_region",
            &[json!(region), json!(0), now(), source.id.clone()],
        )
        .await?;
        if source.region == "center" {
            center::remove(executor, project, &source.id).await?;
        }
        return group_positions(
            executor,
            &source_panes
                .iter()
                .filter(|p| p.id != source.id)
                .map(|p| p.id.clone())
                .collect::<Vec<_>>(),
        )
        .await;
    }
    if destination.is_none() && region == source.region && source_members.len() == 1 {
        let next = moved(ids(&source_panes), &source.id, &input["targetPanePosition"]);
        if region == "center" {
            let root = center::read(executor, project).await?;
            if root.is_null() {
                return Err(invariant("The center layout root is missing."));
            }
            return center::persist(executor, project, &center::reorder(&root, &next)?).await;
        }
        return group_positions(executor, &next).await;
    }
    let remaining = source_members
        .into_iter()
        .filter(|m| m.key != *key)
        .collect::<Vec<_>>();
    run(executor, "delete_member", std::slice::from_ref(key)).await?;
    let mut next_source = ids(&source_panes);
    if remaining.is_empty() {
        run(executor, "delete_pane", std::slice::from_ref(&source.id)).await?;
        if source.region == "center" {
            center::remove(executor, project, &source.id).await?;
        }
        next_source.retain(|id| id != &source.id);
    } else {
        repair_source(executor, &source, &remaining, key, false).await?;
    }
    if let Some(destination) = destination {
        let target_members = run(
            executor,
            "remaining_member_keys",
            std::slice::from_ref(&destination.id),
        )
        .await?
        .iter()
        .map(|r| r.get::<String>(0).map(|s| json!(s)))
        .collect::<Result<Vec<_>>>()?;
        member
            .copy_to(executor, &destination.id, &input["targetMemberPosition"])
            .await?;
        member_positions(
            executor,
            &destination.id,
            &inserted(target_members, key.clone(), &input["targetMemberPosition"]),
        )
        .await?;
        if remaining.is_empty() {
            group_positions(executor, &next_source).await?;
        }
    } else {
        let pane = json!(uuid::Uuid::new_v4().to_string());
        let at = input.get("targetPanePosition").cloned().unwrap_or(json!(0));
        run(
            executor,
            "insert_pane",
            &[
                pane.clone(),
                json!(project),
                json!(region),
                at.clone(),
                key.clone(),
            ],
        )
        .await?;
        member.copy_to(executor, &pane, &json!(0)).await?;
        if region == "center" {
            center::append(executor, project, &pane).await?;
        }
        if region != source.region {
            group_positions(executor, &next_source).await?;
        }
        let target_ids = if region == source.region {
            next_source
        } else {
            ids(target_panes)
        };
        let next = inserted(target_ids, pane, &at);
        if region == "center" {
            let root = center::read(executor, project).await?;
            if root.is_null() {
                return Err(invariant("The center layout root is missing."));
            }
            center::persist(executor, project, &center::reorder(&root, &next)?).await?;
        } else {
            group_positions(executor, &next).await?;
        }
    }
    Ok(())
}
