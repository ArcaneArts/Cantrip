//! Native replacements for Cantrip's sequence-editor.cjs/message-editor.cjs.
//! The old todo/message data is read unchanged; the old scripts are never run.
use super::process;
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_wire::{Value, parse_json_text};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

pub fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<bool> {
    let mut args = arguments.into_iter().skip(1);
    let Some(command) = args.next() else {
        return Ok(false);
    };
    if command != "--git-sequence-editor" && command != "--git-message-editor" {
        return Ok(false);
    }
    let target = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("Missing Git editor target"))?,
    );
    if command == "--git-sequence-editor" {
        std::fs::copy(
            std::env::var_os("CANTRIP_REBASE_TODO")
                .ok_or_else(|| anyhow::anyhow!("Missing Cantrip rebase todo"))?,
            target,
        )?;
        return Ok(true);
    }
    let current = String::from_utf8_lossy(&std::fs::read(&target)?).into_owned();
    if current.contains("# This is a combination of") {
        return Ok(true);
    }
    let done = match std::env::var_os("CANTRIP_REBASE_DONE").map(std::fs::read) {
        Some(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => return Ok(true),
    };
    let done = process::trim(&done);
    let mut last = done
        .split('\n')
        .next_back()
        .unwrap_or("")
        .split_whitespace();
    if last.next() != Some("reword") {
        return Ok(true);
    }
    let Some(revision) = last.next() else {
        return Ok(true);
    };
    let source = std::env::var_os("CANTRIP_REWORD_MESSAGES")
        .ok_or_else(|| anyhow::anyhow!("Missing Cantrip reword messages"))?;
    let data = std::fs::read(source)?;
    let messages = parse_json_text(&String::from_utf8_lossy(&data))
        .map_err(|e| anyhow::anyhow!("{}", e.lossy()))?;
    let value = messages
        .as_object()
        .into_iter()
        .flatten()
        .find(|(hash, _)| {
            let hash = hash.lossy();
            hash.starts_with(revision) || revision.starts_with(hash.as_ref())
        })
        .map(|(_, value)| value)
        .ok_or_else(|| anyhow::anyhow!("Missing Cantrip reword message"))?;
    let text = cantrip_wire::coercion::string(value)
        .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?;
    std::fs::write(target, format!("{}\n", text.lossy()))?;
    Ok(true)
}
pub(super) fn interactive(context: &Value) -> bool {
    context["type"] == "rebase"
        && context["checkpointRef"]
            .as_js_string()
            .is_some_and(|v| v.lossy().contains("/rewrite-"))
}
async fn root(cwd: &Path, context: &Value, scope: &Scope) -> Result<PathBuf> {
    let checkpoint = context["checkpointRef"].as_js_string().ok_or_else(|| {
        anyhow::anyhow!("The interactive rebase is missing its recovery reference.")
    })?;
    let checkpoint = checkpoint.lossy();
    let key = checkpoint.split('/').next_back().unwrap_or("");
    if !key.strip_prefix("rewrite-").is_some_and(|v| {
        !v.is_empty()
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    }) {
        bail!("The interactive rebase recovery metadata is invalid.");
    }
    let common = process::text(cwd, &["rev-parse", "--git-common-dir"], scope).await?;
    Ok(cantrip_config::resolve(cwd, Path::new(&common))
        .join("cantrip")
        .join("rebases")
        .join(key))
}
fn quote(path: &Path) -> String {
    format!("'{}'", paths::text(path).lossy().replace('\'', "'\\''"))
}
pub(super) async fn environment(
    cwd: &Path,
    context: &Value,
    scope: &Scope,
) -> Result<Vec<(OsString, OsString)>> {
    if !interactive(context) {
        return Ok(vec![
            ("GIT_EDITOR".into(), "true".into()),
            ("GIT_SEQUENCE_EDITOR".into(), "true".into()),
        ]);
    }
    let root = root(cwd, context, scope).await?;
    environment_at(cwd, &root, scope).await
}
async fn environment_at(
    cwd: &Path,
    root: &Path,
    scope: &Scope,
) -> Result<Vec<(OsString, OsString)>> {
    let done = process::text(
        cwd,
        &["rev-parse", "--git-path", "rebase-merge/done"],
        scope,
    )
    .await?;
    let executable = quote(&std::env::current_exe()?);
    Ok(vec![
        (
            "CANTRIP_REBASE_TODO".into(),
            root.join("todo").into_os_string(),
        ),
        (
            "CANTRIP_REWORD_MESSAGES".into(),
            root.join("reword-messages.json").into_os_string(),
        ),
        (
            "CANTRIP_REBASE_DONE".into(),
            cantrip_config::resolve(cwd, Path::new(&done)).into_os_string(),
        ),
        (
            "GIT_SEQUENCE_EDITOR".into(),
            format!("{executable} --git-sequence-editor").into(),
        ),
        (
            "GIT_EDITOR".into(),
            format!("{executable} --git-message-editor").into(),
        ),
        ("LC_ALL".into(), "C".into()),
    ])
}
pub(super) async fn prepare(
    cwd: &Path,
    action: &Value,
    context: &Value,
    storage: Option<&Path>,
    scope: &Scope,
) -> Result<Vec<(OsString, OsString)>> {
    let root = match storage {
        Some(root) => root.to_owned(),
        None => root(cwd, context, scope).await?,
    };
    tokio::fs::create_dir_all(&root).await?;
    let todo = action["todo"].as_array().unwrap();
    let text = todo
        .iter()
        .map(|item| {
            format!(
                "{} {}",
                item["action"].as_str().unwrap(),
                item["revision"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let messages = Value::object(todo.iter().filter(|item| item["action"] == "reword").map(
        |item| {
            (
                item["revision"].as_js_string().unwrap().clone(),
                item["message"].clone(),
            )
        },
    ));
    let todo_path = root.join("todo");
    let messages_path = root.join("reword-messages.json");
    let (a, b) = tokio::join!(
        tokio::fs::write(todo_path, text),
        tokio::fs::write(messages_path, messages.stringify())
    );
    a?;
    b?;
    scope.check()?;
    environment_at(cwd, &root, scope).await
}
pub(super) async fn cleanup(cwd: &Path, context: &Value, scope: &Scope) -> Result<()> {
    if interactive(context) {
        let root = root(cwd, context, scope).await?;
        match tokio::fs::remove_dir_all(&root).await {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
                match tokio::fs::remove_file(root).await {
                    Ok(()) => (),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
