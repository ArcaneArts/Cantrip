use crate::{
    agent_interactions::Repository,
    native_commands::settings_persistence::text,
    wire::{Value, coercion::truthy},
};
use anyhow::{Result, bail};
use futures::FutureExt;
pub(super) async fn apply(
    repo: &Repository<'_, '_>,
    owner: &str,
    worker: &Value,
    context: &Value,
    event: &Value,
) -> Result<()> {
    let chat = &context["chatId"];
    let lane = &context["executionLaneId"];
    if event["type"] == "computer-use.approval.request" {
        let request = &event["request"];
        let p = &request["provenance"];
        if p["owner"] != "computer-use"
            || p["chatId"] != *chat
            || p["workerId"] != *worker
            || p["executionLaneId"] != *lane
            || request["projectId"] != context["projectId"]
            || !truthy(p.get("threadId"))
            || !truthy(p.get("turnId"))
        {
            bail!("Invalid agent computer-use approval request.");
        }
        repo.record(request, true).boxed().await?;
    } else {
        if event["chatId"] != *chat {
            bail!("Invalid agent computer-use approval terminal event.");
        }
        let existing = repo
            .get_by_key(owner, &text(&event["requestKey"])?)
            .boxed()
            .await?;
        let p = existing.as_ref().map(|v| &v["provenance"]);
        if p.is_none_or(|p| {
            p["owner"] != "computer-use"
                || p["chatId"] != *chat
                || p["workerId"] != *worker
                || p["executionLaneId"] != *lane
                || !truthy(p.get("threadId"))
                || !truthy(p.get("turnId"))
        }) {
            bail!("Invalid agent computer-use approval terminal event.");
        }
        repo.terminalize(
            &text(&event["requestKey"])?,
            &text(chat)?,
            &text(worker)?,
            &text(&event["status"])?,
            None,
        )
        .boxed()
        .await?;
    }
    Ok(())
}
