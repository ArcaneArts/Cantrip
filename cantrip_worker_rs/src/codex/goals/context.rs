//! Materialize the finalized Task context under the selected Codex profile.
use crate::native_items::concat;
use anyhow::{Context, Result, bail};
use cantrip_history::files::{ensure_directory, write_immutable};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

pub(super) fn materialize(
    home: &Path,
    chat: &Value,
    source_thread: &Value,
    objective: &JsString,
    content: &JsString,
) -> Result<JsString> {
    let digest =
        Sha256::digest(json!([chat.clone(), source_thread.clone(), json!(content)]).stringify());
    let digest: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory = home.join("attachments").join(format!("task-goal-{digest}"));
    let file = directory.join("implementation-plan.md");
    ensure_directory(&directory)?;
    let bytes = content.lossy();
    if !write_immutable(&file, &bytes)? && fs::read(&file)? != bytes.as_bytes() {
        bail!("The saved Task implementation context has changed.");
    }
    let path = file
        .to_str()
        .context("Invalid native Goal attachment path.")?;
    let quoted = json!(path).stringify();
    let reference: JsString = format!(
        "Read the complete approved Task implementation plan at {quoted} before making changes and after context compaction. Finish and validate every acceptance criterion, not just the first milestone."
    ).into();
    let direction = concat(&[objective.trim(), "\n\n".into(), reference.clone()]);
    let count = |text: &JsString| std::char::decode_utf16(text.units().iter().copied()).count();
    if count(&direction) <= 4000 {
        Ok(direction)
    } else if count(&reference) <= 4000 {
        Ok(reference)
    } else {
        bail!("The Task plan reference exceeds the native Goal objective limit.")
    }
}
