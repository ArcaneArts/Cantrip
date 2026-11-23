//! Existing GithubClient.inspectCheckout semantics. Unlike workspace discovery,
//! attaching an existing folder permits a linked Git worktree and preserves its
//! common-directory identity even when GitHub lookup is unavailable.
use super::{Scope, paths};
use anyhow::Result;
use cantrip_wire::{JsString, Value, coercion, value::json};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, path::Path, sync::OnceLock};

pub fn fingerprint(common: &Path) -> String {
    Sha256::digest(paths::text(common).lossy().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn strip_git(value: &JsString) -> JsString {
    let units = value.units();
    if units.len() >= 4
        && units[units.len() - 4..]
            .iter()
            .copied()
            .map(|u| {
                if u < 128 {
                    (u as u8).to_ascii_lowercase() as u16
                } else {
                    u
                }
            })
            .eq(".git".encode_utf16())
    {
        JsString::new(units[..units.len() - 4].to_vec())
    } else {
        value.clone()
    }
}
pub fn github_repository_from_remote(value: &JsString) -> Option<JsString> {
    static SCP: OnceLock<regress::Regex> = OnceLock::new();
    let value = value.trim();
    if let Some(found) = SCP
        .get_or_init(|| {
            regress::Regex::with_flags(r"^git@github\.com:([^/]+)/(.+)$", "iu").unwrap()
        })
        .find_from_utf16(value.units(), 0)
        .next()
    {
        let owner = &value.units()[found.group(1)?];
        let repository = strip_git(&JsString::new(value.units()[found.group(2)?].to_vec()));
        return Some(JsString::new([owner, &[47], repository.units()].concat()).lowercase());
    }
    let url = url::Url::parse(&value.lossy()).ok()?;
    if !url.host_str()?.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let path = strip_git(&JsString::from(url.path().trim_matches('/')));
    let parts = path.units().split(|u| *u == 47).collect::<Vec<_>>();
    (parts.len() == 2).then(|| path.lowercase())
}
async fn git(scope: &Scope, cwd: &Path, args: &[&str]) -> Result<JsString> {
    let mut arguments = vec![OsString::from("-C"), cwd.as_os_str().to_owned()];
    arguments.extend(args.iter().map(OsString::from));
    Ok(JsString::from(
        scope
            .run("git".as_ref(), &arguments, 1024 * 1024, 10_000)
            .await?,
    )
    .trim())
}
async fn github(scope: &Scope, name: &JsString) -> Result<Value> {
    let parts = name.units().split(|u| *u == 47).collect::<Vec<_>>();
    anyhow::ensure!(
        parts.len() == 2
            && parts.iter().all(|p| !p.is_empty()
                && *p != [46]
                && *p != [46, 46]
                && p.iter().all(|u| *u < 128
                    && ((*u as u8).is_ascii_alphanumeric() || [95, 46, 45].contains(u)))),
        "Invalid GitHub repository name"
    );
    let stdout = scope
        .run_with_timeout(
            "gh".as_ref(),
            &["api".into(), format!("repos/{}", name.lossy()).into()],
            32 * 1024 * 1024,
            None,
        )
        .await?;
    let value = cantrip_wire::parse_json_text(&stdout)
        .map_err(|_| anyhow::anyhow!("GitHub repository response is invalid"))?;
    let string = |field| match value.get(field) {
        Some(value) => coercion::string(value)
            .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value")),
        None => Ok(JsString::from("undefined")),
    };
    let repository = cantrip_crypto::checked(
        "projectGithubConversionRepositorySchema",
        &json!({"repositoryId":string("id")?,"nameWithOwner":string("full_name")?,"url":string("html_url")?}),
    )?;
    anyhow::ensure!(
        repository["nameWithOwner"]
            .as_js_string()
            .unwrap()
            .lowercase()
            == *name,
        "GitHub repository identity changed"
    );
    Ok(repository)
}
pub async fn inspect_checkout(cwd: &Path, scope: &Scope) -> Result<Value> {
    let inspected = async {
        let top = paths::canonical(&paths::native(
            &git(scope, cwd, &["rev-parse", "--show-toplevel"]).await?,
        ))
        .await?;
        if !paths::equal(&top, cwd) {
            return Ok(json!({"github":Value::Null,"repositoryFingerprint":Value::Null}));
        }
        let common = paths::native(&git(scope, cwd, &["rev-parse", "--git-common-dir"]).await?);
        let common = paths::canonical(&if paths::absolute(&common) {
            common
        } else {
            cwd.join(common)
        })
        .await?;
        let fingerprint = fingerprint(&common);
        let name = git(scope, cwd, &["config", "--get", "remote.origin.url"])
            .await
            .ok()
            .and_then(|value| github_repository_from_remote(&value));
        let repository = match name {
            Some(name) => github(scope, &name).await.ok().unwrap_or(Value::Null),
            None => Value::Null,
        };
        Ok::<_, anyhow::Error>(json!({"github":repository,"repositoryFingerprint":fingerprint}))
    }
    .await;
    scope.check()?;
    Ok(inspected
        .unwrap_or_else(|_| json!({"github":Value::Null,"repositoryFingerprint":Value::Null})))
}
