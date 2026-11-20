use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, payload_digest, value::json};
use std::{
    fs::File,
    io::{ErrorKind, Read, Write},
    path::Path,
};

fn scope(command: &Value, binding: &(JsString, Value)) -> String {
    payload_digest(&json!([
        json!(binding.0),
        binding.1.clone(),
        command["chatId"].clone()
    ]))
}

pub(super) fn read(
    directory: &Path,
    command: &Value,
    binding: &(JsString, Value),
) -> Result<Option<Value>> {
    let file = match File::open(directory.join("state.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut text = String::new();
    file.take(64 * 1024).read_to_string(&mut text)?;
    let stored =
        parse_json_text(&text).map_err(|_| anyhow::anyhow!("Invalid relocation journal."))?;
    ensure!(
        stored["snapshotId"] == command["snapshotId"]
            && matches!(stored["status"].as_str(), Some("hydrating" | "hydrated"))
            && stored["threadId"]
                .as_js_string()
                .is_some_and(|id| !id.is_empty()),
        "Stored relocation hydration state is invalid."
    );
    ensure!(
        stored["transcriptSha256"] == command["transcriptSha256"],
        "This relocation snapshot id is already associated with a different transcript."
    );
    // The Node worker's original receipt has no scope field.
    if let Some(value) = stored.get("scope") {
        ensure!(
            value == &json!(scope(command, binding)),
            "This relocation snapshot belongs to another chat or worker binding."
        );
    }
    Ok(Some(stored))
}

pub(super) fn save(
    directory: &Path,
    command: &Value,
    binding: &(JsString, Value),
    status: &str,
    thread: &JsString,
) -> Result<()> {
    let value = json!({"snapshotId":command["snapshotId"],"status":status,"threadId":thread,
        "transcriptSha256":command["transcriptSha256"],"scope":scope(command, binding)});
    let mut pending = tempfile::Builder::new()
        .prefix(".state-")
        .tempfile_in(directory)?;
    writeln!(pending, "{}", value.stringify())?;
    pending.as_file().sync_all()?;
    pending
        .persist(directory.join("state.json"))
        .context("Could not publish the relocation receipt.")?;
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopens_legacy_receipt_and_guards_new_receipt_identity() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let snapshot = "17ec5609-0d7f-4985-a4cd-fb500340302b";
        let digest = "b".repeat(64);
        let command = json!({"snapshotId":snapshot,"transcriptSha256":digest,"chatId":"chat"});
        let binding = ("owner".into(), json!("server"));
        let file = directory.path().join("state.json");
        let legacy = json!({"snapshotId":snapshot,"status":"hydrating","threadId":"abandoned",
            "transcriptSha256":digest});
        std::fs::write(&file, legacy.stringify())?;
        assert_eq!(read(directory.path(), &command, &binding)?, Some(legacy));

        save(
            directory.path(),
            &command,
            &binding,
            "hydrated",
            &"verified".into(),
        )?;
        let saved = read(directory.path(), &command, &binding)?.context("Missing saved receipt")?;
        assert_eq!(saved["threadId"], "verified");
        assert_eq!(saved["status"], "hydrated");
        let other = ("other-owner".into(), json!("server"));
        assert!(read(directory.path(), &command, &other).is_err());
        let mut changed = command;
        changed["transcriptSha256"] = json!("a".repeat(64));
        assert!(read(directory.path(), &changed, &binding).is_err());
        Ok(())
    }
}
