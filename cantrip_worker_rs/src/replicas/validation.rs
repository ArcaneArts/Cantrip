use super::{
    Manager, git, placement,
    provision::{Refusal, refuse},
};
use crate::filesystem::{Scope, paths, repository, source_path};
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};
impl Manager {
    pub(super) async fn validate_direct(
        &self,
        path: &JsString,
        input: &Value,
        scope: &Scope,
    ) -> Result<PathBuf> {
        let requested = source_path::normalize(path, cfg!(windows)).map_err(|_| {
            refuse(
                "target-not-found",
                "The direct repository path is not a supported native path.",
                false,
            )
        })?;
        let target = paths::native(&requested);
        let result = async {
            let entry = tokio::fs::symlink_metadata(&target).await?;
            if !entry.is_dir() || placement::is_link(&target, &entry) {
                return Err(refuse(
                    "target-repository-mismatch",
                    "The direct repository path is not a canonical directory.",
                    false,
                ));
            }
            if !placement::same_path(&paths::text(&paths::canonical(&target).await?), &requested) {
                return Err(refuse(
                    "target-repository-mismatch",
                    "The direct repository path no longer has its canonical identity.",
                    false,
                ));
            }
            let top = paths::canonical(&paths::native(
                &git::run(
                    &target,
                    &["rev-parse", "--show-toplevel"],
                    1024 * 1024,
                    scope,
                )
                .await?,
            ))
            .await?;
            let bare = git::run(
                &target,
                &["rev-parse", "--is-bare-repository"],
                1024 * 1024,
                scope,
            )
            .await?;
            if !paths::equal(&top, &target) || bare.as_str() != Some("false") {
                return Err(refuse(
                    "target-repository-mismatch",
                    "The direct checkout is no longer an attachable Git repository.",
                    false,
                ));
            }
            if let Some(name) = input["nameWithOwner"]
                .as_js_string()
                .filter(|v| !v.is_empty())
            {
                let origin = git::run(
                    &target,
                    &["config", "--get", "remote.origin.url"],
                    1024 * 1024,
                    scope,
                )
                .await?;
                if repository::github_repository_from_remote(&origin).as_ref()
                    != Some(&name.lowercase())
                {
                    return Err(refuse(
                        "target-repository-mismatch",
                        "The direct checkout no longer matches this GitHub repository.",
                        false,
                    ));
                }
            }
            let directory = git::directory(&target, "--git-dir", scope).await?;
            let common = git::directory(&target, "--git-common-dir", scope).await?;
            if !paths::equal(&directory, &common) {
                return Err(refuse(
                    "target-not-primary-worktree",
                    "Only the direct repository's Primary worktree can be removed.",
                    false,
                ));
            }
            Ok(target.clone())
        }
        .await;
        result.map_err(|error| {
            if error.is::<Refusal>() {
                return error;
            }
            let missing = error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                || error
                    .downcast_ref::<crate::github::process::SpawnError>()
                    .is_some_and(|e| e.code == "ENOENT");
            if missing {
                refuse(
                    "target-not-found",
                    "The direct repository checkout no longer exists.",
                    false,
                )
            } else {
                refuse(
                    "target-repository-mismatch",
                    "The direct repository checkout could not be verified safely.",
                    false,
                )
            }
        })
    }
    pub(super) async fn verify_custom(
        &self,
        input: &Value,
        path: &Path,
        common: &Path,
    ) -> Result<()> {
        let fingerprint = repository::fingerprint(common);
        if input["repositoryFingerprint"] != fingerprint {
            return Err(refuse(
                "ownership-proof-missing",
                "The repository fingerprint no longer matches the persisted project replica.",
                false,
            ));
        }
        self.placement.verify_placement_ownership(&json!({
            "canonicalPath":paths::text(path),"gitCommonDir":paths::text(common),"linkPath":input["placement"]["linkPath"],
            "mode":input["placement"]["mode"],"ownership":input["placement"]["ownership"],
            "projectId":input["projectId"],"repositoryFingerprint":fingerprint,
        })).await
    }
}
