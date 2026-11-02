//! User selection and Task recovery share the same durable placement transition.
use super::{Repository, catalog::raw, execution_lanes::LaneError, summary::wire_summary};
use crate::{projects::targets::TargetRepository, wire::Value};
use anyhow::{Context, Result};

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Chat worktree identity")?
        .lossy()
        .into_owned())
}
fn conflict(message: impl Into<String>) -> anyhow::Error {
    LaneError::Conflict(message.into()).into()
}
const RECOVERY_CHANGED: &str = "The Task placement changed during recovery. Please retry.";

impl Repository {
    pub async fn update_worktree(
        &self,
        owner: &str,
        chat_id: &str,
        input: &Value,
        expected: Option<&Value>,
    ) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT to_jsonb(c)::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 LIMIT 1", &[&owner, &chat_id]).await?;
        let Some(chat) = rows.first().map(raw).transpose()? else {
            return Ok(None);
        };
        if expected.is_some_and(|expected| {
            chat.get("active_worktree_id") != Some(expected)
                || chat["worktree_mode"] != input["mode"]
        }) {
            return Err(conflict(RECOVERY_CHANGED));
        }
        let project = text(&chat["project_id"])?;
        anyhow::ensure!(
            !project.is_empty(),
            "Project Chat operation received a standalone Chat."
        );
        let Some(target) = TargetRepository::new(self.database.clone())
            .worktree_context(owner, &project, &text(&input["worktreeId"])?)
            .await?
        else {
            return Ok(None);
        };
        if target["worktree"]["lifecycleState"] != "ready" {
            return Ok(None);
        }
        let changing = chat["active_worktree_id"] != target["worktree"]["id"];
        if changing
            && !chat["active_worker_id"].is_null()
            && chat["active_worker_id"] != target["workerId"]
        {
            return Err(conflict(
                "Moving a chat to another worker requires a durable relocation.",
            ));
        }
        if changing
            && matches!(
                chat["status"].as_str(),
                Some("running" | "waiting-for-approval")
            )
        {
            return Err(conflict(
                "Wait for the active chat turn before switching worktrees.",
            ));
        }
        if changing {
            let tree = text(&target["worktree"]["id"])?;
            let chat_parameters: crate::database::Parameters<'_> = &[&chat_id];
            let tree_parameters: crate::database::Parameters<'_> = &[&tree];
            let (active, reservations, consoles) = tokio::try_join!(
                self.database.query("SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND state='active'", chat_parameters),
                self.database.query("SELECT chat_id FROM chat_execution_lanes WHERE worktree_id=$1 AND exclusive=true AND state<>'released'", tree_parameters),
                self.database.query("SELECT status FROM terminals WHERE linked_chat_id=$1", chat_parameters),
            )?;
            if !active.is_empty() {
                return Err(conflict(
                    "Finish the active chat execution before switching worktrees.",
                ));
            }
            for row in reservations {
                let reserved_by = row.get::<String>(0)?;
                if reserved_by != chat_id {
                    return Err(conflict(format!(
                        "Worktree is exclusively leased to chat {reserved_by}."
                    )));
                }
            }
            for row in consoles {
                if row.get::<String>(0)? == "running" {
                    return Err(conflict(
                        "Stop the linked Codex console before switching worktrees.",
                    ));
                }
            }
        }
        let chat_id = chat_id.to_owned();
        let mode = text(&input["mode"])?;
        let expected = expected.cloned();
        self.database.transaction(|tx| Box::pin(async move {
            let tree = text(&target["worktree"]["id"])?;
            let worker = text(&target["workerId"])?;
            tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,worker_id,worktree_id) WHERE worktree_id IS NOT NULL DO NOTHING", &[&uuid::Uuid::new_v4().to_string(), &chat_id, &worker, &tree]).await?;
            let runtime = tx.query("SELECT to_jsonb(r)::text FROM chat_runtime_sessions r WHERE chat_id=$1 AND worker_id=$2 AND worktree_id=$3 LIMIT 1", &[&chat_id, &worker, &tree]).await?;
            let runtime = raw(runtime.first().context("Database returned no row after selecting a worktree runtime.")?)?;
            let runtime_id = text(&runtime["id"])?;
            let thread = runtime["codex_thread_id"].as_str();
            let lanes = tx.query("SELECT id FROM chat_execution_lanes WHERE chat_id=$1 AND worktree_id=$2 AND state<>'released' ORDER BY created_at DESC LIMIT 1", &[&chat_id, &tree]).await?;
            if let Some(lane) = lanes.first() {
                tx.query("UPDATE chat_execution_lanes SET runtime_session_id=$1,codex_thread_id=$2,updated_at=$3 WHERE id=$4", &[&runtime_id, &thread, &crate::auth::now(), &lane.get::<String>(0)?]).await?;
            } else {
                let exclusive = target["worktree"]["isPrimary"] != true;
                let head = target["worktree"]["head"].as_str();
                tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id,codex_thread_id) VALUES($1,$2,$3,$4,'user',$5,'Selected by user','suspended',$6,$7,$8)", &[&uuid::Uuid::new_v4().to_string(), &chat_id, &tree, &worker, &exclusive, &head, &runtime_id, &thread]).await?;
            }
            if changing {
                tx.query("UPDATE terminals SET active_worker_id=$1,worktree_id=$2,updated_at=$3 WHERE linked_chat_id=$4", &[&worker, &tree, &crate::auth::now(), &chat_id]).await?;
            }
            let at = crate::auth::now();
            let recovering = expected.is_some();
            let rows = if let Some(expected) = expected {
                // Compare every value Source captured before worker recovery.
                // A failed CAS rolls back the new lane, runtime and console move.
                let expected = text(&expected)?;
                let revision = i32::try_from(chat["placement_revision"].as_i64().context("Chat placement revision")?)?;
                let previous_mode = chat["worktree_mode"].as_str();
                let paused = chat["automation_paused"].as_bool().context("Chat automation paused")?;
                let status = text(&chat["status"])?;
                tx.query("UPDATE chats SET active_worker_id=$1,active_worktree_id=$2,placement_revision=placement_revision+$3,worktree_mode=$4,updated_at=$5 WHERE id=$6 AND active_worktree_id=$7 AND placement_revision=$8 AND worktree_mode IS NOT DISTINCT FROM $9::text AND automation_paused=$10 AND status=$11 RETURNING to_jsonb(chats)::text", &[&worker, &tree, &i32::from(changing), &mode, &at, &chat_id, &expected, &revision, &previous_mode, &paused, &status]).await?
            } else {
                tx.query("UPDATE chats SET active_worker_id=$1,active_worktree_id=$2,placement_revision=placement_revision+$3,worktree_mode=$4,updated_at=$5 WHERE id=$6 RETURNING to_jsonb(chats)::text", &[&worker, &tree, &i32::from(changing), &mode, &at, &chat_id]).await?
            };
            if rows.is_empty() && recovering { return Err(conflict(RECOVERY_CHANGED)) }
            rows.first().map(|row| wire_summary(&raw(row)?)).transpose()
        })).await
    }
}
