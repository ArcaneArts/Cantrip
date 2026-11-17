use super::{
    Manager, Progress, clipped, git,
    placement::PlacementError,
    provision::{Refusal, refuse, text},
    stage,
};
use crate::filesystem::{Scope, explorer::io_error, paths, repository};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use std::path::Path;
const MIB: usize = 1024 * 1024;
fn removed(
    input: &Value,
    _target: &Path,
    deleted: bool,
    released: bool,
    link: Option<(bool, Value)>,
) -> Result<Value> {
    let mut value = json!({"status":"removed","jobId":input["jobId"],"attempt":input["attempt"],
        "path":super::placement::resolved_path_text(input["sourcePath"].as_js_string().unwrap())?,"localFilesDeleted":deleted,"ownershipReleased":released});
    if let Some((removed, warning)) = link {
        value["linkRemoved"] = json!(removed);
        value["warning"] = warning
    }
    cantrip_crypto::checked("projectReplicaRemoveResultSchema", &value)
}
fn proof(input: &Value, path: &Path, common: Value) -> Value {
    proof_text(input, &paths::text(path), common)
}
fn proof_text(input: &Value, path: &cantrip_wire::JsString, common: Value) -> Value {
    json!({"canonicalPath":path,"gitCommonDir":common,"mode":input["placement"]["mode"],
        "ownership":input["placement"]["ownership"],"linkPath":input["placement"]["linkPath"],
        "projectId":input["projectId"],"repositoryFingerprint":input["repositoryFingerprint"]})
}
fn missing(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}
impl Manager {
    pub(super) async fn remove(
        &self,
        input: &Value,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        let delete = input["deleteLocalFiles"] == true;
        if input["nameWithOwner"].is_null() && delete {
            return Err(refuse(
                "policy-denied",
                "Detaching a local Git source never deletes its checkout.",
                false,
            ));
        }
        let target_text =
            super::placement::resolved_path_text(input["sourcePath"].as_js_string().unwrap())?;
        let target = paths::native(&target_text);
        let placement = &input["placement"];
        let mode = placement["mode"].as_str().unwrap_or("managed");
        let custom = mode == "direct" || mode == "managed-link";
        let root = paths::resolve(&self.directory.join("repositories"))?;
        let canonical_root = paths::canonical(&root)
            .await
            .unwrap_or_else(|_| root.clone());
        if !placement.is_null()
            && !paths::equal(
                &paths::resolve(&paths::native(
                    placement["canonicalPath"].as_js_string().unwrap(),
                ))?,
                &target,
            )
        {
            return Err(refuse(
                "target-mismatch",
                "The persisted canonical repository path does not match the removal target.",
                false,
            ));
        }
        let within_root = paths::within(&root, &target) && !paths::equal(&target, &root);
        let within_canonical =
            paths::within(&canonical_root, &target) && !paths::equal(&target, &canonical_root);
        if mode != "direct" && !within_root && !within_canonical {
            return Err(refuse(
                "target-mismatch",
                "Cantrip will only remove managed repositories from worker-owned storage.",
                false,
            ));
        }
        if custom && input["repositoryFingerprint"].is_null() {
            return Err(refuse(
                "ownership-proof-missing",
                "Custom repository removal requires its persisted repository fingerprint.",
                false,
            ));
        }
        let released = custom
            && !placement.is_null()
            && !input["repositoryFingerprint"].is_null()
            && self
                .placement
                .is_placement_released(&proof_text(input, &target_text, Value::Null))
                .await?;
        if released && delete {
            return Err(refuse(
                "policy-denied",
                "This repository placement was already retained as user-managed storage.",
                false,
            ));
        }
        match tokio::fs::metadata(&target).await {
            Ok(_) => {}
            Err(error) if missing(&error) => {
                if released {
                    return removed(input, &target, false, true, None);
                }
                let mut link_removed = false;
                let mut warning = Value::Null;
                if mode == "managed-link"
                    && !placement["linkPath"].is_null()
                    && !input["repositoryFingerprint"].is_null()
                {
                    self.placement
                        .verify_placement_ownership(&proof_text(input, &target_text, json!("")))
                        .await?;
                    if delete {
                        let link=self.placement.remove_managed_link_if_matching(&json!({"canonicalPath":target_text,"linkPath":placement["linkPath"]})).await?;
                        link_removed = link["removed"] == true;
                        warning = link["warning"].clone();
                        self.placement
                            .forget_placement(&input["projectId"], &json!(target_text))
                            .await?;
                    } else {
                        self.placement
                            .release_placement(&proof_text(input, &target_text, Value::Null))
                            .await?
                    }
                } else if mode == "direct" {
                    self.placement
                        .forget_placement(&input["projectId"], &json!(target_text))
                        .await?
                }
                return removed(
                    input,
                    &target,
                    delete,
                    custom,
                    Some((link_removed, warning)),
                );
            }
            Err(error) => return Err(io_error("access", &target, error)),
        }
        if mode != "direct" && input["nameWithOwner"].is_null() {
            return Err(refuse(
                "policy-denied",
                "Local Git repositories can only be removed from direct placement.",
                false,
            ));
        }
        if mode == "direct" {
            self.validate_direct(&target_text, input, scope).await?;
        } else {
            self.validate_managed(input, scope).await?;
        }
        let canonical = paths::canonical(&target)
            .await
            .map_err(|e| io_error("realpath", &target, e))?;
        let mut common = None;
        if custom {
            let directory = git::directory(&canonical, "--git-common-dir", scope).await?;
            if input["repositoryFingerprint"] != repository::fingerprint(&directory) {
                return Err(refuse(
                    "ownership-proof-missing",
                    "The repository fingerprint no longer matches the persisted project replica.",
                    false,
                ));
            }
            if placement.is_null() || (mode == "managed-link" && placement["linkPath"].is_null()) {
                return Err(refuse(
                    "ownership-proof-missing",
                    "The custom repository placement metadata is incomplete.",
                    false,
                ));
            }
            if released {
                self.placement
                    .release_placement(&proof(input, &canonical, json!(paths::text(&directory))))
                    .await?;
                return removed(input, &target, false, true, None);
            }
            self.placement
                .verify_placement_ownership(&proof(
                    input,
                    &canonical,
                    json!(paths::text(&directory)),
                ))
                .await?;
            if mode == "direct" && placement["ownership"] == "user" && delete {
                return Err(refuse(
                    "policy-denied",
                    "This checkout existed before Cantrip and cannot be deleted.",
                    false,
                ));
            }
            common = Some(directory);
        }
        if !delete {
            if let Some(common) = &common {
                self.placement
                    .release_placement(&proof(input, &canonical, json!(paths::text(common))))
                    .await?;
            }
            return removed(input, &target, false, custom, None);
        }
        let operation = async {
            let result = self
                .remove_files(
                    input,
                    &target,
                    &canonical,
                    common.as_deref(),
                    custom,
                    scope,
                    progress,
                )
                .await;
            // Lifecycle wrappers see Source's parsed blocked result, so they
            // can resume their observations after a refused deletion.
            match result {
                Ok(value) => Ok(value),
                Err(error) => {
                    let refusal = error
                        .downcast_ref::<Refusal>()
                        .map(|e| (e.code, e.message.clone(), e.retryable))
                        .or_else(|| {
                            error
                                .downcast_ref::<PlacementError>()
                                .map(|e| (e.code, e.message.into(), e.retryable))
                        });
                    if let Some((code, message, retryable)) = refusal {
                        cantrip_crypto::checked(
                            "projectReplicaRemoveResultSchema",
                            &json!({"status":"blocked","jobId":input["jobId"],"attempt":input["attempt"],
                            "error":json!({"code":code,"message":clipped(&message,4000),"retryable":retryable})}),
                        )
                    } else {
                        Err(error)
                    }
                }
            }
        };
        let lifecycle = self.removal_lifecycle.lock().unwrap().clone();
        match lifecycle {
            Some(lifecycle) => lifecycle(canonical.clone(), Box::pin(operation)).await,
            None => operation.await,
        }
    }
    #[allow(clippy::too_many_arguments)]
    async fn remove_files(
        &self,
        input: &Value,
        target: &Path,
        canonical: &Path,
        common: Option<&Path>,
        custom: bool,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        stage(progress, "inspecting", 30);
        let status = git::run(
            target,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
            4 * MIB,
            scope,
        )
        .await?;
        let ignored = git::run(
            target,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
            4 * MIB,
            scope,
        )
        .await?;
        if !status.is_empty() || !ignored.is_empty() {
            return Err(refuse(
                "worktree-dirty",
                "The replica contains changed, untracked, or ignored files and was not deleted.",
                false,
            ));
        }
        let worktrees =
            git::run(target, &["worktree", "list", "--porcelain"], 4 * MIB, scope).await?;
        if worktrees
            .units()
            .split(|u| *u == 10)
            .filter(|line| line.starts_with(&"worktree ".encode_utf16().collect::<Vec<_>>()))
            .count()
            != 1
        {
            return Err(refuse(
                "policy-denied",
                "The replica has additional Git worktrees and was not deleted.",
                false,
            ));
        }
        git::run(target, &["fetch", "origin", "--prune"], 32 * MIB, scope)
            .await
            .map_err(|e| {
                refuse(
                    "remote-unavailable",
                    if custom {
                        "Could not verify published history for the selected worker checkout."
                            .into()
                    } else {
                        text(
                            "Could not verify published history: ",
                            &crate::error::message(&e),
                        )
                    },
                    true,
                )
            })?;
        let head = git::revision(target, "HEAD", scope).await?;
        let containing = git::run(
            target,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "--contains",
                &head.lossy(),
                "refs/remotes/origin",
            ],
            4 * MIB,
            scope,
        )
        .await?;
        if containing.is_empty() {
            return Err(refuse(
                "unpushed-commits",
                "The replica HEAD is not contained in a fetched origin reference and was not deleted.",
                false,
            ));
        }
        stage(progress, "removing", 80);
        if let Some(common) = common {
            self.placement
                .verify_placement_ownership(&proof(input, canonical, json!(paths::text(common))))
                .await?;
        }
        tokio::fs::remove_dir_all(target)
            .await
            .map_err(|e| io_error("rmdir", target, e))?;
        let mode = input["placement"]["mode"].as_str().unwrap_or("managed");
        let mut link_removed = false;
        let mut warning = Value::Null;
        if mode == "managed-link"
            && !input["placement"]["linkPath"].is_null()
            && !input["repositoryFingerprint"].is_null()
        {
            let link=self.placement.remove_managed_link_if_matching(&json!({"canonicalPath":paths::text(canonical),"linkPath":input["placement"]["linkPath"]})).await?;
            link_removed = link["removed"] == true;
            warning = link["warning"].clone();
            self.placement
                .forget_placement(&input["projectId"], &json!(paths::text(canonical)))
                .await?;
        } else if mode == "direct" {
            self.placement
                .forget_placement(&input["projectId"], &json!(paths::text(canonical)))
                .await?;
        }
        removed(input, target, true, custom, Some((link_removed, warning)))
    }
}
