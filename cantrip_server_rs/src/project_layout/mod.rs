//! Transactional pane placement shared by persisted project resources.
mod center;
mod detach;
use crate::{
    database::{Database, Transaction},
    wire::Value,
};
use anyhow::{Context, Result, ensure};
pub use detach::{detach_resource, detach_terminal};

pub async fn next_position(database: &Database, project: &str) -> Result<i64> {
    let read = async |table: &str, extra: &str| -> Result<i64> {
        let rows=database.query(&format!("SELECT position FROM {table} WHERE project_id=$1{extra} ORDER BY position DESC LIMIT 1"),&[&project]).await?;
        rows.first()
            .map(|row| row.get::<i32>(0))
            .transpose()
            .map(|v| i64::from(v.unwrap_or(-1)))
    };
    let (chat, terminal, explorer, code, browser, view) = tokio::try_join!(
        read("chats", " AND archived_at IS NULL"),
        read("terminals", ""),
        read("explorers", ""),
        read("code_tabs", ""),
        read("browsers", ""),
        read("project_views", "")
    )?;
    Ok([chat, terminal, explorer, code, browser, view]
        .into_iter()
        .max()
        .unwrap()
        + 1)
}
fn supports(kind: &str, region: &str) -> Result<()> {
    ensure!(
        ["center", "right", "bottom"].contains(&region),
        "project.{kind} does not support the {region} region."
    );
    Ok(())
}
async fn member_position(tx: &Transaction<'_>, group: &str) -> Result<i64> {
    let rows=tx.query("SELECT position FROM tab_group_members WHERE group_id=$1 ORDER BY position DESC LIMIT 1",&[&group]).await?;
    Ok(rows
        .first()
        .map(|row| row.get::<i32>(0))
        .transpose()?
        .map(i64::from)
        .unwrap_or(-1)
        + 1)
}
pub async fn attach_terminal(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    input: &Value,
) -> Result<()> {
    attach_resource(tx, project, id, "terminal", input).await
}
pub async fn attach_resource(
    tx: &Transaction<'_>,
    project: &str,
    id: &str,
    kind: &str,
    input: &Value,
) -> Result<()> {
    let at = crate::auth::now();
    tx.query(
        "UPDATE projects SET tab_layout_revision=tab_layout_revision+1,updated_at=$1 WHERE id=$2",
        &[&at, &project],
    )
    .await?;
    let tab_key = format!("{kind}:{id}");
    let explicit = input
        .get("paneId")
        .filter(|v| !v.is_null())
        .or_else(|| input.get("tabGroupId"));
    let (group, position, center_created) = if let Some(group) =
        explicit.and_then(Value::as_str).filter(|v| !v.is_empty())
    {
        let rows = tx
            .query(
                "SELECT id,region FROM tab_groups WHERE id=$1 AND project_id=$2 LIMIT 1",
                &[&group, &project],
            )
            .await?;
        let pane = rows
            .first()
            .context("The destination pane does not belong to this project.")?;
        supports(kind, &pane.get::<String>(1)?)?;
        (group.to_owned(), member_position(tx, group).await?, false)
    } else {
        let region = if let Some(region) = input.get("targetRegion").and_then(Value::as_str) {
            region.to_owned()
        } else {
            let rows=tx.query("SELECT u.workspace_layout_profile FROM projects p INNER JOIN user_settings u ON u.user_id=p.owner_id WHERE p.id=$1 LIMIT 1",&[&project]).await?;
            if rows
                .first()
                .map(|row| row.get::<Option<String>>(0))
                .transpose()?
                .flatten()
                .as_deref()
                == Some("agent")
            {
                "center".into()
            } else {
                if kind == "browser" { "right" } else { "bottom" }.into()
            }
        };
        supports(kind, &region)?;
        let panes=tx.query("SELECT id,position FROM tab_groups WHERE project_id=$1 AND region=$2 ORDER BY position ASC,id ASC",&[&project,&region]).await?;
        let dock = region == "right" || region == "bottom";
        ensure!(
            !dock || panes.len() <= 1,
            "The {region} dock contains more than one pane."
        );
        if dock && !panes.is_empty() {
            let id = panes[0].get::<String>(0)?;
            let position = member_position(tx, &id).await?;
            (id, position, false)
        } else {
            let group = uuid::Uuid::new_v4().to_string();
            let position = panes
                .last()
                .map(|row| row.get::<i32>(1))
                .transpose()?
                .map(i64::from)
                .unwrap_or(-1)
                + 1;
            tx.query("INSERT INTO tab_groups (id,project_id,region,position,anchor_tab_key) VALUES ($1,$2,$3,$4::bigint::integer,$5)",&[&group,&project,&region,&position,&tab_key]).await?;
            (group, 0, region == "center")
        }
    };
    tx.query("INSERT INTO tab_group_members (tab_key,group_id,project_id,tab_kind,tab_id,position) VALUES ($1,$2,$3,$4,$5,$6::bigint::integer)",&[&tab_key,&group,&project,&kind,&id,&position]).await?;
    if center_created {
        center::append(tx, project, &group).await?;
    }
    Ok(())
}
