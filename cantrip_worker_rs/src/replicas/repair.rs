use super::{
    Manager, clipped, git,
    placement::PlacementError,
    provision::{Refusal, refuse, text},
};
use crate::filesystem::{Scope, explorer::io_error, paths, repository, source_path};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use std::path::PathBuf;
impl Manager {
    pub(super) async fn repair(&self, input: &Value, scope: &Scope) -> Result<Value> {
        match self.repair_inner(input, scope).await {
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
                        "projectReplicaLinkRepairResultSchema",
                        &json!({"status":"blocked",
                        "error":json!({"code":code,"message":clipped(&message,4000),"retryable":retryable})}),
                    )
                } else {
                    Err(error)
                }
            }
        }
    }
    async fn repair_inner(&self, input: &Value, scope: &Scope) -> Result<Value> {
        let canonical = self.validate_managed(input, scope).await?;
        let canonical = paths::canonical(&canonical)
            .await
            .map_err(|e| io_error("realpath", &canonical, e))?;
        let common = git::directory(&canonical, "--git-common-dir", scope).await?;
        let fingerprint = repository::fingerprint(&common);
        if input["repositoryFingerprint"] != fingerprint {
            return Err(refuse(
                "ownership-proof-missing",
                "The repository fingerprint no longer matches the managed-link replica.",
                false,
            ));
        }
        let result = async {
            self.placement
                .verify_placement_ownership(&json!({
                    "canonicalPath":paths::text(&canonical),"gitCommonDir":paths::text(&common),
                    "linkPath":input["linkPath"],"mode":"managed-link","ownership":"cantrip",
                    "projectId":input["projectId"],"repositoryFingerprint":fingerprint,
                }))
                .await?;
            let result = self
                .placement
                .materialize_managed_link(&json!({
                    "canonicalPath":paths::text(&canonical),"linkPath":input["linkPath"],
                    "projectId":input["projectId"],"repositoryFingerprint":fingerprint,
                    "requestedPath":input["linkPath"],"requireExistingClaim":true,
                }))
                .await?;
            cantrip_crypto::checked(
                "projectReplicaLinkRepairResultSchema",
                &json!({
                    "status":"ready","projectId":input["projectId"],"path":paths::text(&canonical),
                    "linkPath":input["linkPath"],"repaired":result["changed"],
                }),
            )
        }
        .await;
        result.map_err(|error| {
            if error.is::<PlacementError>() {
                error
            } else {
                refuse(
                    "link-unsupported",
                    "The managed repository link could not be repaired safely.",
                    false,
                )
            }
        })
    }
    async fn validate_managed(&self, input: &Value, scope: &Scope) -> Result<PathBuf> {
        let root = self.directory.join("repositories");
        let target =
            source_path::normalize(input["sourcePath"].as_js_string().unwrap(), cfg!(windows))
                .map(|text| paths::native(&text))
                .map_err(|_| {
                    refuse(
                        "target-not-found",
                        "The managed repository path is not a supported native path.",
                        false,
                    )
                })?;
        let metadata = tokio::fs::symlink_metadata(&target).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                refuse(
                    "target-not-found",
                    "The worker-local replica path does not exist.",
                    false,
                )
            } else {
                io_error("lstat", &target, e)
            }
        })?;
        if !metadata.is_dir() || super::placement::is_link(&target, &metadata) {
            return Err(refuse(
                "target-mismatch",
                "The replica path is not a managed directory.",
                false,
            ));
        }
        let data_text = paths::text(&self.directory);
        let target_text = paths::text(&target);
        let (data, resolved) = tokio::try_join!(
            source_path::canonical(&data_text),
            source_path::canonical(&target_text),
        )?;
        let segments = resolved.strip_prefix(&data).ok().map(|path| {
            path.components()
                .map(|c| paths::text(std::path::Path::new(c.as_os_str())))
                .collect::<Vec<_>>()
        });
        let workspace = segments.as_ref().filter(|p| {
            p.len() == 5
                && p[0].as_str() == Some("workspaces")
                && p[2].as_str() == Some("repositories")
        });
        let workspace_target = workspace.and_then(|segments| {
            let identity = crate::github::repository_parts(
                input["repository"]["nameWithOwner"].as_js_string().unwrap(),
            )
            .ok()?;
            crate::filesystem::storage::workspace_root(
                &data,
                &json!({"kind":"managed","workspaceId":segments[1]}),
            )
            .ok()
            .map(|workspace| {
                workspace
                    .root
                    .join("repositories")
                    .join(paths::native(&identity[0]))
                    .join(paths::native(&identity[1]))
            })
        });
        if !workspace_target
            .as_ref()
            .is_some_and(|path| paths::equal(&resolved, path))
        {
            let resolved_root = match source_path::canonical(&paths::text(&root)).await {
                Ok(root) => Some(root),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    None
                }
                Err(error) => return Err(error),
            };
            if !resolved_root.is_some_and(|root| {
                paths::within(&root, &resolved) && !paths::equal(&root, &resolved)
            }) {
                return Err(refuse(
                    "target-mismatch",
                    "The replica resolves outside worker-managed repository storage.",
                    false,
                ));
            }
        }
        let origin = git::run(
            &target,
            &["remote", "get-url", "origin"],
            1024 * 1024,
            scope,
        )
        .await
        .map_err(|_| {
            refuse(
                "target-mismatch",
                "The replica is not a Git repository with an origin remote.",
                false,
            )
        })?;
        if !git::managed_origin_matches(
            &origin,
            input["repository"]["nameWithOwner"].as_js_string().unwrap(),
        ) {
            return Err(refuse(
                "target-mismatch",
                text("The replica points at a different origin: ", &origin),
                false,
            ));
        }
        Ok(resolved)
    }
}
