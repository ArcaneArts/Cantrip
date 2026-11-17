use crate::{
    filesystem::{Scope, paths},
    github::process,
};
use anyhow::Result;
use cantrip_wire::{JsString, Value};
use std::path::{Path, PathBuf};
pub(super) async fn run(
    path: &Path,
    arguments: &[&str],
    maximum: usize,
    scope: &Scope,
) -> Result<JsString> {
    let mut args = vec!["-C".into(), paths::text(path)];
    args.extend(arguments.iter().map(|v| JsString::from(*v)));
    Ok(JsString::from(process::run_program("git", &args, maximum, scope).await?).trim())
}
pub(super) async fn commit(path: &Path, revision: &str, scope: &Scope) -> Option<JsString> {
    run(
        path,
        &["rev-parse", "--verify", &format!("{revision}^{{commit}}")],
        1024 * 1024,
        scope,
    )
    .await
    .ok()
    .map(|v| v.lowercase())
}
pub(super) async fn directory(path: &Path, kind: &str, scope: &Scope) -> Result<PathBuf> {
    let value = paths::native(&run(path, &["rev-parse", kind], 1024 * 1024, scope).await?);
    Ok(paths::canonical(&if paths::absolute(&value) {
        value
    } else {
        paths::resolve(&path.join(value))?
    })
    .await?)
}
pub(super) async fn attach_unborn(path: &Path, scope: &Scope) -> Result<Option<JsString>> {
    let head = async {
        run(
            path,
            &["remote", "set-head", "origin", "--auto"],
            1024 * 1024,
            scope,
        )
        .await?;
        run(
            path,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                "refs/remotes/origin/HEAD",
            ],
            1024 * 1024,
            scope,
        )
        .await
    }
    .await;
    let Ok(head) = head else { return Ok(None) };
    let text = head.lossy();
    let Some(branch) = text
        .strip_prefix("origin/")
        .filter(|branch| !branch.is_empty())
    else {
        return Ok(None);
    };
    let Some(revision) = commit(path, &text, scope).await else {
        return Ok(None);
    };
    run(
        path,
        &["checkout", "-B", branch, &text],
        32 * 1024 * 1024,
        scope,
    )
    .await?;
    run(
        path,
        &["branch", "--set-upstream-to", &text, branch],
        1024 * 1024,
        scope,
    )
    .await?;
    Ok(Some(revision))
}
pub(super) async fn policy(path: &Path) -> Value {
    let result = async {
        let file = path.join(".cantrip/project.json");
        let metadata = tokio::fs::symlink_metadata(&file).await?;
        anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 65536,
            "Ignored policy"
        );
        let bytes = tokio::fs::read(file).await?;
        let value = cantrip_wire::parse_json_text(&String::from_utf8_lossy(&bytes))
            .map_err(crate::error::WireError)?;
        cantrip_crypto::checked("worktreePolicySchema", &value["worktreePolicy"])
    }
    .await;
    result.unwrap_or(Value::Null)
}
pub(super) fn managed_origin_matches(origin: &JsString, name: &JsString) -> bool {
    // Existing managed-replica behavior strips a case-sensitive suffix first.
    let mut units = origin.units().to_vec();
    if units.ends_with(&[46, 103, 105, 116]) {
        units.truncate(units.len() - 4)
    }
    let normalized = JsString::new(
        units
            .into_iter()
            .map(|u| if u == 92 { 47 } else { u })
            .collect(),
    )
    .lowercase();
    let expected = name.lowercase();
    [47, 58].iter().any(|separator| {
        normalized
            .units()
            .ends_with(&[&[*separator][..], expected.units()].concat())
    })
}
