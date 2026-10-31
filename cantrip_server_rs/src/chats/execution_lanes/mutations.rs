use super::{LaneRepository, branch_leases, query, raw};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;

async fn finish(
    tx: &Transaction<'_>,
    chat: &str,
    lane: &str,
    status: &str,
    options: &Value,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<bool> {
    let ex = Executor::Transaction(tx);
    let previous=query(ex,"SELECT jsonb_build_object('lane',to_jsonb(l),'is_primary',w.is_primary)::text FROM chat_execution_lanes l LEFT JOIN project_worktrees w ON w.id=l.worktree_id WHERE l.id=$1 AND l.chat_id=$2 LIMIT 1",&[&lane,&chat],&[json!(lane),json!(chat)]).await?;
    let expected = options
        .get("expectedActivatedAt")
        .filter(|v| truthy(Some(v)))
        .map(super::text)
        .transpose()?;
    let predicate = if expected.is_some() {
        " AND activated_at=$4::text::timestamptz"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE chat_execution_lanes SET state='suspended',updated_at=$1 WHERE id=$2 AND chat_id=$3 AND state='active'{predicate} RETURNING id"
    );
    let suspended = if let Some(expected) = &expected {
        // Source constructs new Date before binding, including Invalid Date errors.
        let parsed = super::iso(&json!(expected))?;
        let expected = super::text(&parsed)?;
        query(
            ex,
            &sql,
            &[&now, &lane, &chat, &expected],
            &[
                json!(crate::auth::iso(now)),
                json!(lane),
                json!(chat),
                json!(expected),
            ],
        )
        .await?
    } else {
        query(
            ex,
            &sql,
            &[&now, &lane, &chat],
            &[json!(crate::auth::iso(now)), json!(lane), json!(chat)],
        )
        .await?
    };
    if !suspended.is_empty()
        && previous
            .first()
            .map(raw)
            .transpose()?
            .is_some_and(|v| truthy(v.get("is_primary")))
    {
        branch_leases::release(tx, lane).await?;
    }
    if suspended.is_empty() {
        return Ok(false);
    }
    let pause = truthy(options.get("pauseAutomation"));
    let pause_sql = if pause { ",automation_paused=true" } else { "" };
    let unread = if ["idle", "failed"].contains(&status) {
        ",has_unread_completion=true"
    } else {
        ""
    };
    let sql = format!("UPDATE chats SET status=$1,updated_at=$2{pause_sql}{unread} WHERE id=$3");
    query(
        ex,
        &sql,
        &[&status, &now, &chat],
        &[json!(status), json!(crate::auth::iso(now)), json!(chat)],
    )
    .await?;
    if pause {
        query(
            ex,
            "UPDATE managed_queue_states SET revision=revision+1 WHERE chat_id=$1",
            &[&chat],
            &[json!(chat)],
        )
        .await?;
    }
    Ok(true)
}
async fn update_runtime(
    tx: &Transaction<'_>,
    chat: &str,
    lane: &str,
    thread: Option<&str>,
    status: &str,
) -> Result<bool> {
    let ex = Executor::Transaction(tx);
    let now = crate::auth::now();
    let rows=query(ex,"UPDATE chat_execution_lanes SET codex_thread_id=$1,updated_at=$2 WHERE id=$3 AND chat_id=$4 RETURNING runtime_session_id",&[&thread,&now,&lane,&chat],&[json!(thread),json!(crate::auth::iso(now)),json!(lane),json!(chat)]).await?;
    let runtime = rows
        .first()
        .map(|row| row.get::<Option<String>>(0))
        .transpose()?
        .flatten()
        .filter(|s| !s.is_empty());
    let Some(runtime) = runtime else {
        return Ok(false);
    };
    let now = crate::auth::now();
    query(
        ex,
        "UPDATE chat_runtime_sessions SET codex_thread_id=$1,status=$2,updated_at=$3 WHERE id=$4",
        &[&thread, &status, &now, &runtime],
        &[
            json!(thread),
            json!(status),
            json!(crate::auth::iso(now)),
            json!(runtime),
        ],
    )
    .await?;
    Ok(true)
}
pub async fn finish_in_transaction(
    tx: &Transaction<'_>,
    chat: &str,
    lane: &str,
    status: &str,
    options: &Value,
) -> Result<bool> {
    let now = crate::auth::now();
    let (chat, lane, status, options) = (
        chat.to_owned(),
        lane.to_owned(),
        status.to_owned(),
        options.clone(),
    );
    super::savepoint(tx, |tx| {
        Box::pin(async move { finish(tx, &chat, &lane, &status, &options, now).await })
    })
    .await
}
pub async fn update_runtime_in_transaction(
    tx: &Transaction<'_>,
    chat: &str,
    lane: &str,
    thread: Option<&str>,
    status: &str,
) -> Result<bool> {
    let (chat, lane, thread, status) = (
        chat.to_owned(),
        lane.to_owned(),
        thread.map(str::to_owned),
        status.to_owned(),
    );
    super::savepoint(tx, |tx| {
        Box::pin(async move { update_runtime(tx, &chat, &lane, thread.as_deref(), &status).await })
    })
    .await
}
impl LaneRepository {
    pub async fn finish(
        &self,
        chat: &str,
        lane: &str,
        status: &str,
        options: &Value,
    ) -> Result<bool> {
        let now = crate::auth::now();
        let (chat, lane, status, options) = (
            chat.to_owned(),
            lane.to_owned(),
            status.to_owned(),
            options.clone(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move { finish(tx, &chat, &lane, &status, &options, now).await })
            })
            .await
    }
    pub async fn update_runtime(
        &self,
        chat: &str,
        lane: &str,
        thread: Option<&str>,
        status: &str,
    ) -> Result<bool> {
        let (chat, lane, thread, status) = (
            chat.to_owned(),
            lane.to_owned(),
            thread.map(str::to_owned),
            status.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    update_runtime(tx, &chat, &lane, thread.as_deref(), &status).await
                })
            })
            .await
    }
}
