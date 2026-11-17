use super::{Manager, Progress, blocked, clone, git, placement, placement_failure, stage};
use crate::filesystem::{Scope, explorer::io_error, paths, repository, source_path, storage};
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};
const MIB: usize = 1024 * 1024;
#[derive(Debug)]
pub(super) struct Refusal {
    pub(super) code: &'static str,
    pub(super) message: JsString,
    pub(super) retryable: bool,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for Refusal {}
pub(super) fn refuse(
    code: &'static str,
    message: impl Into<JsString>,
    retryable: bool,
) -> anyhow::Error {
    Refusal {
        code,
        message: message.into(),
        retryable,
    }
    .into()
}
pub(super) fn text(prefix: &str, suffix: &JsString) -> JsString {
    JsString::new(
        prefix
            .encode_utf16()
            .chain(suffix.units().iter().copied())
            .collect(),
    )
}
fn generic(error: anyhow::Error, code: &'static str, message: &'static str) -> anyhow::Error {
    if error.is::<Refusal>() || error.is::<placement::PlacementError>() {
        error
    } else {
        refuse(code, message, false)
    }
}
struct Direct {
    common: PathBuf,
    fingerprint: String,
    ownership: Value,
}
impl Manager {
    pub(super) async fn provision(
        &self,
        input: &Value,
        identity: Option<&[JsString]>,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        match self.provision_inner(input, identity, scope, progress).await {
            Ok(result) => Ok(result),
            Err(error) => {
                if let Some(refusal) = error.downcast_ref::<Refusal>() {
                    blocked(
                        input,
                        refusal.code,
                        refusal.message.clone(),
                        refusal.retryable,
                    )
                } else if let Some(result) = placement_failure(input, &error) {
                    result
                } else {
                    Err(error)
                }
            }
        }
    }
    async fn provision_inner(
        &self,
        input: &Value,
        identity: Option<&[JsString]>,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        let placement = &input["placement"];
        stage(
            progress,
            if placement["mode"] == "managed" {
                "validating"
            } else {
                "validating-placement"
            },
            10,
        );
        if identity.is_none() && placement["mode"] != "direct" {
            return Err(refuse(
                "policy-denied",
                "Local Git sources can only attach an existing checkout at an explicit worker path.",
                false,
            ));
        }
        if identity.is_none() && input["expectedRevision"].is_null() {
            return Err(refuse(
                "target-revision-mismatch",
                "Local Git source attachment requires a current project revision for compatibility verification.",
                false,
            ));
        }
        let managed = if placement["mode"] == "direct" {
            paths::native(placement["path"].as_js_string().unwrap())
        } else if input["workspaceStorage"]["kind"] == "managed" {
            let identity = identity.unwrap();
            storage::ensure_workspace_directory(
                &self.directory,
                &input["workspaceStorage"],
                &["repositories".into(), identity[0].clone()],
            )
            .await?
            .join(paths::native(&identity[1]))
        } else {
            self.managed_target(&input["workspaceStorage"], identity.unwrap())?
        };
        let prepared = self
            .placement
            .prepare(&json!({
                "jobId":input["jobId"],"managedTarget":paths::text(&managed),
                "placement":placement,"projectId":input["projectId"],
            }))
            .await?;
        let target = paths::native(prepared["targetPath"].as_js_string().unwrap());
        let mut materialization = if prepared["exists"] == true {
            "reused"
        } else {
            "cloned"
        };
        let mut ownership = json!("cantrip");
        let mut direct = None;
        if prepared["exists"] == true && prepared["mode"] == "direct" {
            stage(progress, "inspecting-existing-checkout", 35);
            let inspected = self
                .inspect_direct(input, &target, scope)
                .await
                .map_err(|error| {
                    generic(
                        error,
                        "target-repository-mismatch",
                        "The requested target is not an attachable Git checkout.",
                    )
                })?;
            ownership = inspected.ownership.clone();
            materialization = if ownership == "cantrip" {
                "reused"
            } else {
                "attached"
            };
            direct = Some(inspected);
        } else if prepared["exists"] == true {
            self.reuse_managed(input, &target, scope, progress).await?;
        } else if identity.is_none() {
            return Err(refuse(
                "target-not-found",
                "The local Git checkout does not exist. Cantrip will not clone a local-only project.",
                false,
            ));
        } else {
            stage(progress, "materializing", 30);
            if let Err(error) = self
                .materialize(input, &prepared, &target, scope, progress)
                .await
            {
                if error.is::<Refusal>() {
                    return Err(error);
                }
                let _ = self.cleanup(input, &prepared).await;
                if error.is::<placement::PlacementError>() {
                    return Err(error);
                }
                let (code, message) =
                    clone::clone_failure(&crate::error::message(&error), cfg!(windows));
                return Err(refuse(
                    code,
                    if prepared["mode"] == "direct" && code == "remote-unavailable" {
                        "Could not clone the repository into the requested worker placement.".into()
                    } else {
                        message
                    },
                    true,
                ));
            }
        }
        stage(progress, "verifying", 90);
        let canonical = source_path::canonical(&paths::text(&target)).await?;
        let revision = git::commit(&canonical, "HEAD", scope).await;
        let branch = git::run(&canonical, &["branch", "--show-current"], MIB, scope).await?;
        let common = match &direct {
            Some(value) => value.common.clone(),
            None => git::directory(&canonical, "--git-common-dir", scope).await?,
        };
        let fingerprint = direct
            .as_ref()
            .map(|v| v.fingerprint.clone())
            .unwrap_or_else(|| repository::fingerprint(&common));
        if prepared["mode"] == "direct" {
            let result=async {
                if let Some(name)=input["nameWithOwner"].as_js_string() {
                    let origin=git::run(&canonical,&["config","--get","remote.origin.url"],MIB,scope).await?;
                    if repository::github_repository_from_remote(&origin).as_ref()!=Some(&name.lowercase()) {
                        return Err(refuse("target-repository-mismatch","The materialized checkout belongs to a different GitHub repository.",false))
                    }
                }
                let top=paths::canonical(&paths::native(&git::run(&canonical,&["rev-parse","--show-toplevel"],MIB,scope).await?)).await?;
                let git_dir=git::directory(&canonical,"--git-dir",scope).await?;
                if top!=canonical||git_dir!=common {
                    return Err(refuse("target-not-primary-worktree","The materialized checkout is not the repository's Primary worktree.",false))
                }
                if materialization=="cloned" {
                    ownership=self.placement.classify_existing(&json!({
                        "canonicalPath":paths::text(&canonical),"gitCommonDir":paths::text(&common),
                        "projectId":input["projectId"],"repositoryFingerprint":fingerprint,
                    })).await?;
                    if ownership!="cantrip" {
                        return Err(super::placement::PlacementError {code:"ownership-proof-missing",
                            message:"The cloned checkout is missing its Cantrip ownership proof.",retryable:false}.into())
                    }
                }
                self.placement.record(&json!({
                    "canonicalPath":paths::text(&canonical),"createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
                    "linkPath":Value::Null,"mode":"direct","ownership":ownership,"projectId":input["projectId"],
                    "repositoryFingerprint":fingerprint,"requestedPath":prepared["requestedPath"],
                })).await
            }.await;
            result.map_err(|error| {
                generic(
                    error,
                    "target-repository-mismatch",
                    "The materialized checkout could not be verified safely.",
                )
            })?;
        }
        if prepared["mode"] == "managed-link" {
            self.placement.materialize_managed_link(&json!({
                "canonicalPath":paths::text(&canonical),"linkPath":prepared["linkPath"],"projectId":input["projectId"],
                "repositoryFingerprint":fingerprint,"requestedPath":prepared["requestedPath"],
            })).await.map_err(|error|generic(error,"link-unsupported","The managed repository link could not be created safely."))?;
        }
        let display = prepared
            .get("requestedPath")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| input["nameWithOwner"].clone());
        cantrip_crypto::checked(
            "projectReplicaProvisionResultSchema",
            &json!({
                "status":"ready","jobId":input["jobId"],"attempt":input["attempt"],
                "path":paths::text(&canonical),"displayPath":display,"repositoryFingerprint":fingerprint,
                "resolvedRevision":revision,"branch":if branch.is_empty(){Value::Null}else{json!(branch)},
                "reused":materialization!="cloned","placement":json!({
                    "mode":prepared["mode"],"materialization":materialization,"ownership":ownership,
                    "canonicalPath":paths::text(&canonical),"requestedPath":prepared["requestedPath"],"linkPath":prepared["linkPath"],
                }),"worktreePolicy":git::policy(&canonical).await,
            }),
        )
    }
    async fn inspect_direct(&self, input: &Value, target: &Path, scope: &Scope) -> Result<Direct> {
        let top = paths::canonical(&paths::native(
            &git::run(target, &["rev-parse", "--show-toplevel"], MIB, scope).await?,
        ))
        .await?;
        if top != target {
            return Err(refuse(
                "target-repository-mismatch",
                "The requested target is not the root of its Git checkout.",
                false,
            ));
        }
        if git::run(target, &["rev-parse", "--is-bare-repository"], MIB, scope)
            .await?
            .as_str()
            != Some("false")
        {
            return Err(refuse(
                "target-repository-mismatch",
                "Bare Git repositories cannot be attached as a project checkout.",
                false,
            ));
        }
        if let Some(name) = input["nameWithOwner"].as_js_string() {
            let origin = git::run(
                target,
                &["config", "--get", "remote.origin.url"],
                MIB,
                scope,
            )
            .await?;
            if repository::github_repository_from_remote(&origin).as_ref()
                != Some(&name.lowercase())
            {
                return Err(refuse(
                    "target-repository-mismatch",
                    "The requested checkout belongs to a different GitHub repository.",
                    false,
                ));
            }
        }
        let git_dir = git::directory(target, "--git-dir", scope).await?;
        let common = git::directory(target, "--git-common-dir", scope).await?;
        if git_dir != common {
            return Err(refuse(
                "target-not-primary-worktree",
                "Only the repository's Primary worktree can be attached.",
                false,
            ));
        }
        let current = git::commit(target, "HEAD", scope).await;
        if let Some(expected) = input["expectedRevision"].as_js_string()
            && current.as_ref() != Some(&expected.lowercase())
        {
            return Err(refuse(
                "target-revision-mismatch",
                "The existing checkout is not at the requested immutable revision.",
                false,
            ));
        }
        if !input["expectedRevision"].is_null()
            && !input["nameWithOwner"].is_null()
            && !git::run(
                target,
                &["status", "--porcelain=v1", "--untracked-files=all"],
                4 * MIB,
                scope,
            )
            .await?
            .is_empty()
        {
            return Err(refuse(
                "worktree-dirty",
                "An exact-revision replica can attach only to a clean checkout.",
                false,
            ));
        }
        let fingerprint = repository::fingerprint(&common);
        let ownership = self
            .placement
            .classify_existing(&json!({
                "canonicalPath":paths::text(target),"gitCommonDir":paths::text(&common),
                "projectId":input["projectId"],"repositoryFingerprint":fingerprint,
            }))
            .await?;
        Ok(Direct {
            common,
            fingerprint,
            ownership,
        })
    }
    async fn reuse_managed(
        &self,
        input: &Value,
        target: &Path,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<()> {
        let Some(name) = input["nameWithOwner"].as_js_string() else {
            return Err(refuse(
                "policy-denied",
                "Local Git repositories can only be attached through direct placement.",
                false,
            ));
        };
        let origin=git::run(target,&["remote","get-url","origin"],MIB,scope).await
            .map_err(|_|refuse("target-mismatch","The managed replica path exists but is not a Git repository with an origin remote.",false))?;
        if !git::managed_origin_matches(&origin, name) {
            return Err(refuse(
                "target-mismatch",
                text(
                    "The managed replica path points at a different origin: ",
                    &origin,
                ),
                false,
            ));
        }
        stage(progress, "fetching", 35);
        git::run(target, &["fetch", "origin", "--prune"], 32 * MIB, scope)
            .await
            .map_err(|e| {
                refuse(
                    "remote-unavailable",
                    text(
                        "Could not fetch the repository origin: ",
                        &crate::error::message(&e),
                    ),
                    true,
                )
            })?;
        stage(progress, "inspecting", 55);
        if !git::run(
            target,
            &["status", "--porcelain=v1", "--untracked-files=all"],
            4 * MIB,
            scope,
        )
        .await?
        .is_empty()
        {
            return Err(refuse(
                "worktree-dirty",
                "The existing replica has tracked or untracked changes and was not modified.",
                false,
            ));
        }
        let mut current = git::commit(target, "HEAD", scope).await;
        if current.is_none() {
            if let Some(expected) = input["expectedRevision"].as_js_string() {
                current = git::commit(target, &expected.lossy(), scope).await;
                let Some(revision) = &current else {
                    return Err(refuse(
                        "target-not-found",
                        format!(
                            "Revision {} is not available from the repository origin.",
                            expected.lossy()
                        ),
                        false,
                    ));
                };
                git::run(
                    target,
                    &["checkout", "--detach", &revision.lossy()],
                    32 * MIB,
                    scope,
                )
                .await?;
            } else {
                current = git::attach_unborn(target, scope).await?
            }
        }
        if let Some(expected) = input["expectedRevision"].as_js_string()
            && current.as_ref() != Some(&expected.lowercase())
        {
            return Err(refuse(
                "revision-diverged",
                format!(
                    "The existing replica is at {}; exact revision {} was requested. Synchronization must be requested explicitly.",
                    current
                        .as_ref()
                        .map(|v| v.lossy().into_owned())
                        .unwrap_or("null".to_owned()),
                    expected.lossy()
                ),
                false,
            ));
        }
        Ok(())
    }
    async fn cleanup(&self, input: &Value, prepared: &Value) -> Result<()> {
        let staging = paths::native(prepared["stagingPath"].as_js_string().unwrap());
        if prepared["mode"] == "direct" {
            self.placement.cleanup_staging(&json!({"jobId":input["jobId"],"projectId":input["projectId"],"stagingPath":prepared["stagingPath"]})).await
        } else {
            super::placement::remove_staging(&staging).await
        }
    }
    async fn materialize(
        &self,
        input: &Value,
        prepared: &Value,
        target: &Path,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<()> {
        let staging = paths::native(prepared["stagingPath"].as_js_string().unwrap());
        if prepared["mode"] == "direct" {
            self.placement.claim_staging(&json!({"jobId":input["jobId"],"projectId":input["projectId"],"stagingPath":prepared["stagingPath"]})).await?;
        } else {
            super::placement::remove_staging(&staging).await?
        }
        clone::repository(
            input["nameWithOwner"].as_js_string().unwrap(),
            &staging,
            scope,
            progress,
        )
        .await?;
        git::run(&staging, &["fetch", "origin", "--prune"], 32 * MIB, scope).await?;
        if let Some(expected) = input["expectedRevision"].as_js_string() {
            stage(progress, "resolving-revision", 88);
            if git::run(
                &staging,
                &[
                    "cat-file",
                    "-e",
                    &format!("{}^{{commit}}", expected.lossy()),
                ],
                MIB,
                scope,
            )
            .await
            .is_err()
            {
                self.cleanup(input, prepared).await?;
                return Err(refuse(
                    "target-not-found",
                    format!(
                        "Revision {} is not available from the repository origin.",
                        expected.lossy()
                    ),
                    false,
                ));
            }
            git::run(
                &staging,
                &["checkout", "--detach", &expected.lossy()],
                32 * MIB,
                scope,
            )
            .await?;
        } else if git::commit(&staging, "HEAD", scope).await.is_none() {
            git::attach_unborn(&staging, scope).await?;
        }
        if prepared["mode"] == "direct" {
            let common = git::directory(&staging, "--git-common-dir", scope).await?;
            let relative = common
                .strip_prefix(&staging)
                .ok()
                .filter(|p| !p.as_os_str().is_empty());
            let Some(relative) = relative else {
                return Err(super::placement::PlacementError {
                    code: "ownership-proof-missing",
                    message: "The staged checkout has an unsupported Git common directory.",
                    retryable: false,
                }
                .into());
            };
            let fingerprint = repository::fingerprint(&target.join(relative));
            self.placement.write_created_marker(&json!({
                "gitCommonDir":paths::text(&common),"projectId":input["projectId"],"repositoryFingerprint":fingerprint,
            })).await?;
        }
        tokio::fs::rename(&staging, target).await.map_err(|e| {
            anyhow::anyhow!(
                "{} -> '{}'",
                io_error("rename", &staging, e),
                target.display()
            )
        })?;
        if prepared["mode"] == "direct" {
            self.cleanup(input, prepared).await?
        }
        Ok(())
    }
}
