//! Authoritative chat locks and runtime retirement fences used by writers.
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::{Result, bail};

#[derive(Debug)]
pub struct NativeCommandError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: u16,
}
impl NativeCommandError {
    pub(super) fn conflict(code: &'static str) -> Self {
        Self {
            code,
            message: code,
            status: 409,
        }
    }
}
impl std::fmt::Display for NativeCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for NativeCommandError {}

pub async fn lock_chat(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<()> {
    tx.query("WITH locked_project AS MATERIALIZED (SELECT projects.id FROM projects INNER JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM locked_project INNER JOIN chats ON chats.project_id=locked_project.id WHERE chats.id=$2 FOR UPDATE OF chats", &[&owner,&chat]).await?;
    if tx
        .query(
            "SELECT id FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE",
            &[&chat, &owner],
        )
        .await?
        .is_empty()
    {
        return Err(NativeCommandError {
            code: "chat-not-found",
            message: "Chat not found.",
            status: 404,
        }
        .into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum Access {
    Write,
    Attach,
}
pub async fn assert_runtime_writable(
    tx: &Transaction<'_>,
    chat: &str,
    generation: Option<&str>,
    epoch: Option<&str>,
    access: Access,
) -> Result<()> {
    let generation = generation.filter(|v| !v.is_empty());
    let epoch = epoch.filter(|v| !v.is_empty());
    let mut current_attachment = false;
    if matches!(access, Access::Attach)
        && let Some(generation) = generation
    {
        let rows = tx
            .query(
                "SELECT state::text FROM native_settings_states WHERE chat_id=$1",
                &[&chat],
            )
            .await?;
        if let Some(row) = rows.first() {
            let state: Value = serde_json::from_str(&row.get::<String>(0)?)?;
            let binding = super::context::property(Some(&state), "binding")?;
            current_attachment =
                binding.and_then(|v| v.get("runtimeGeneration")) == Some(&json!(generation));
        }
    }
    let rows=tx.query("SELECT phase FROM native_runtime_handoffs WHERE chat_id=$1 AND ((NOT $4::boolean AND phase IN ('preparing','prepared','committed')) OR ($2::text IS NOT NULL AND retired_runtime_generations @> jsonb_build_array($2::text)) OR ($2::text IS NOT NULL AND $3::text IS NOT NULL AND retired_native_epochs @> jsonb_build_array(jsonb_build_object('runtimeGeneration',$2::text,'nativeEpoch',$3::text))) OR ($2::text IS NOT NULL AND phase IN ('committed','completed') AND source->>'runtimeGeneration'=$2)) LIMIT 1", &[&chat,&generation,&epoch,&current_attachment]).await?;
    if let Some(row) = rows.first() {
        let phase = row.get::<String>(0)?;
        bail!(NativeCommandError::conflict(
            if ["preparing", "prepared", "committed"].contains(&phase.as_str()) {
                "native-runtime-handoff-pending"
            } else {
                "native-runtime-retired"
            }
        ));
    }
    Ok(())
}
