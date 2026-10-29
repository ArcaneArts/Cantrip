use crate::{
    database::{
        Transaction,
        resource_layout_queries::{column, context as checked, sql},
    },
    wire::{Value, value::json},
};
use anyhow::{Result, ensure};

pub async fn detach_terminal(tx: &Transaction<'_>, project: &str, terminal: &str) -> Result<()> {
    detach_resource(tx, project, "terminal", terminal).await
}
pub async fn detach_resource(
    tx: &Transaction<'_>,
    project: &str,
    kind: &str,
    id: &str,
) -> Result<()> {
    let lock = checked(
        "layout_project_lock",
        tx.query(sql("layout_project_lock"), &[&project, &1_i64])
            .await,
        &[json!(project), json!(1)],
    )?;
    ensure!(!lock.is_empty(), "The project no longer exists.");
    let key = format!("{kind}:{id}");
    let rows = checked(
        "member_select",
        tx.query(sql("member_select"), &[&project, &key, &1_i64])
            .await,
        &[json!(project), json!(key), json!(1)],
    )?;
    let Some(selected) = rows.first() else {
        return Ok(());
    };
    let group = selected.get::<String>(column("group_id"))?;
    let region = selected.get::<String>(column("group_region"))?;
    let anchor = selected.get::<String>(column("group_anchor"))?;
    checked(
        "member_delete",
        tx.query("DELETE FROM tab_group_members WHERE tab_key=$1", &[&key])
            .await,
        &[json!(key)],
    )?;
    let remaining = checked(
        "members_remaining",
        tx.query(sql("members_remaining"), &[&group]).await,
        &[json!(group)],
    )?
    .iter()
    .map(|r| r.get::<String>(0))
    .collect::<Result<Vec<_>>>()?;
    if remaining.is_empty() {
        checked(
            "group_delete",
            tx.query("DELETE FROM tab_groups WHERE id=$1", &[&group])
                .await,
            &[json!(group)],
        )?;
        if region == "center" {
            super::center::remove(tx, project, &group).await?;
        }
        let groups = checked(
            "groups_remaining",
            tx.query(sql("groups_remaining"), &[&project, &region])
                .await,
            &[json!(project), json!(region)],
        )?;
        for (position, row) in groups.iter().enumerate() {
            let id = row.get::<String>(0)?;
            let at = crate::auth::now();
            checked(
                "group_position",
                tx.query(
                    "UPDATE tab_groups SET position=$1,updated_at=$2 WHERE id=$3",
                    &[&(position as i32), &at, &id],
                )
                .await,
                &[json!(position), json!(crate::auth::iso(at)), json!(id)],
            )?;
        }
    } else if anchor == key || remaining.len() == 1 {
        let at = crate::auth::now();
        if anchor == key && remaining.len() == 1 {
            checked("group_anchor_label",tx.query("UPDATE tab_groups SET protected_label=NULL,anchor_tab_key=$1,updated_at=$2 WHERE id=$3",&[&remaining[0],&at,&group]).await,&[Value::Null,json!(remaining[0]),json!(crate::auth::iso(at)),json!(group)])?;
        } else if anchor == key {
            checked(
                "group_anchor",
                tx.query(
                    "UPDATE tab_groups SET anchor_tab_key=$1,updated_at=$2 WHERE id=$3",
                    &[&remaining[0], &at, &group],
                )
                .await,
                &[
                    json!(remaining[0]),
                    json!(crate::auth::iso(at)),
                    json!(group),
                ],
            )?;
        } else {
            checked(
                "group_label",
                tx.query(
                    "UPDATE tab_groups SET protected_label=NULL,updated_at=$1 WHERE id=$2",
                    &[&at, &group],
                )
                .await,
                &[Value::Null, json!(crate::auth::iso(at)), json!(group)],
            )?;
        }
    }
    for (position, tab) in remaining.iter().enumerate() {
        let at = crate::auth::now();
        checked("member_position",tx.query(
            "UPDATE tab_group_members SET group_id=$1,position=$2,updated_at=$3 WHERE tab_key=$4",
            &[&group, &(position as i32), &at, &tab],
        )
        .await,&[json!(group),json!(position),json!(crate::auth::iso(at)),json!(tab)])?;
    }
    let at = crate::auth::now();
    checked("project_revision",tx.query(
        "UPDATE projects SET tab_layout_revision=tab_layout_revision+1,updated_at=$1 WHERE id=$2",
        &[&at, &project],
    )
    .await,&[json!(crate::auth::iso(at)),json!(project)])?;
    Ok(())
}
