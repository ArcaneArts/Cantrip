//! Authoritative chat locks and runtime retirement fences used by writers.
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::{Result, bail};

#[derive(Debug)]
pub struct NativeCommandError {
    pub code: String,
    pub message: String,
    pub status: u16,
}
impl NativeCommandError {
    pub fn new(code: impl Into<String>, message: Option<&str>, status: u16) -> Self {
        let code = code.into();
        Self {
            message: message.map(str::to_owned).unwrap_or_else(|| code.clone()),
            code,
            status,
        }
    }
    pub(super) fn conflict(code: &'static str) -> Self {
        Self::new(code, None, 409)
    }
}
impl std::fmt::Display for NativeCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
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
        return Err(NativeCommandError::new("chat-not-found", Some("Chat not found."), 404).into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum Access {
    Write,
    Attach,
    Control,
    Queue,
}
pub async fn assert_runtime_writable(
    tx: &Transaction<'_>,
    chat: &str,
    generation: Option<&str>,
    epoch: Option<&str>,
    access: Access,
) -> Result<()> {
    assert_runtime_writable_for_dispatch(tx, chat, generation, epoch, access, None).await
}
pub async fn assert_runtime_writable_for_dispatch(
    tx: &Transaction<'_>,
    chat: &str,
    generation: Option<&str>,
    epoch: Option<&str>,
    access: Access,
    accepted_source: Option<(&str, &str)>,
) -> Result<()> {
    let generation = generation.filter(|v| !v.is_empty());
    let epoch = epoch.filter(|v| !v.is_empty());
    // Queue metadata never forwards native input. Controls and attachments may
    // target only the canonical binding. Retirement fences remain unconditional.
    let mut allow_pending = matches!(access, Access::Queue);
    if matches!(access, Access::Attach | Access::Control)
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
            allow_pending =
                binding.and_then(|v| v.get("runtimeGeneration")) == Some(&json!(generation));
        }
    }
    // Only an exact, already-admitted source may start through a queued handoff.
    // Canonical controls and queue edits cannot grant another execution slot.
    let (operation, operation_generation) = accepted_source
        .map_or((None, None), |(operation, generation)| {
            (Some(operation), Some(generation))
        });
    let rows=tx.query("SELECT phase FROM native_runtime_handoffs WHERE chat_id=$1 AND ((NOT $4::boolean AND phase IN ('preparing','prepared','committed') AND NOT COALESCE((phase='preparing' AND queued_source->>'withdrawn'='false' AND queued_source->>'operationId'=$5::text AND queued_source->>'operationGeneration'=$6::text),false)) OR ($2::text IS NOT NULL AND retired_runtime_generations @> jsonb_build_array($2::text)) OR ($2::text IS NOT NULL AND $3::text IS NOT NULL AND retired_native_epochs @> jsonb_build_array(jsonb_build_object('runtimeGeneration',$2::text,'nativeEpoch',$3::text))) OR ($2::text IS NOT NULL AND phase IN ('committed','completed') AND source->>'runtimeGeneration'=$2)) LIMIT 1", &[&chat,&generation,&epoch,&allow_pending,&operation,&operation_generation]).await?;
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
