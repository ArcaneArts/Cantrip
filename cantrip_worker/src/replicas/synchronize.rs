use super::{
    Manager, Progress, git,
    provision::{refuse, text},
    stage,
};
use crate::filesystem::{Scope, paths, source_path};
use anyhow::Result;
use cantrip_wire::{Value, value::json};
const MIB: usize = 1024 * 1024;
impl Manager {
    pub(super) async fn synchronize(
        &self,
        input: &Value,
        scope: &Scope,
        progress: &Progress<'_>,
    ) -> Result<Value> {
        let placement = &input["placement"];
        let mode = placement["mode"].as_str().unwrap_or("managed");
        let custom = mode == "direct" || mode == "managed-link";
        let source =
            source_path::normalize(input["sourcePath"].as_js_string().unwrap(), cfg!(windows))?;
        if !placement.is_null() {
            let persisted = source_path::normalize(
                placement["canonicalPath"].as_js_string().unwrap(),
                cfg!(windows),
            )
            .map_err(|_| {
                refuse(
                    "target-not-found",
                    "The persisted project source path is not a supported native path.",
                    false,
                )
            })?;
            if !super::placement::same_path(&persisted, &source) {
                return Err(refuse(
                    "target-mismatch",
                    "The persisted canonical repository path does not match the synchronization target.",
                    false,
                ));
            }
        }
        if custom && (placement.is_null() || input["repositoryFingerprint"].is_null()) {
            return Err(refuse(
                "ownership-proof-missing",
                "Custom repository synchronization requires its persisted placement identity.",
                false,
            ));
        }
        stage(progress, "validating", 10);
        let target = if mode == "direct" {
            self.validate_direct(&source, input, scope).await?
        } else {
            self.validate_managed(input, scope).await?
        };
        if custom {
            let canonical = source_path::canonical(&paths::text(&target)).await?;
            let common = git::directory(&canonical, "--git-common-dir", scope).await?;
            self.verify_custom(input, &canonical, &common).await?;
        }
        stage(progress, "fetching", 30);
        git::run(&target, &["fetch", "origin", "--prune"], 32 * MIB, scope)
            .await
            .map_err(|error| {
                refuse(
                    "remote-unavailable",
                    if custom {
                        "Could not fetch the selected worker checkout's repository origin.".into()
                    } else {
                        text(
                            "Could not fetch the repository origin: ",
                            &crate::error::message(&error),
                        )
                    },
                    true,
                )
            })?;
        stage(progress, "inspecting", 50);
        if !git::run(
            &target,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
            4 * MIB,
            scope,
        )
        .await?
        .is_empty()
        {
            return Err(refuse(
                "worktree-dirty",
                "The replica has tracked or untracked changes and was not modified.",
                false,
            ));
        }
        let expected = input["expectedRevision"].as_str().unwrap();
        if git::run(
            &target,
            &["cat-file", "-e", &format!("{expected}^{{commit}}")],
            MIB,
            scope,
        )
        .await
        .is_err()
        {
            return Err(refuse(
                "target-not-found",
                format!("Revision {expected} is not available from the repository origin."),
                false,
            ));
        }
        let containing = git::run(
            &target,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "--contains",
                expected,
                "refs/remotes/origin",
            ],
            4 * MIB,
            scope,
        )
        .await?;
        if containing.is_empty() {
            return Err(refuse(
                "policy-denied",
                "The expected revision is not reachable from a fetched origin reference.",
                false,
            ));
        }
        let previous = git::revision(&target, "HEAD", scope).await?;
        let branch = git::run(&target, &["branch", "--show-current"], MIB, scope).await?;
        let changed = previous.as_str() != Some(expected);
        if changed {
            if input["policy"] == "verify-only" {
                return Err(refuse(
                    "revision-diverged",
                    format!(
                        "The replica is at {}; verify-only policy did not change it.",
                        previous.lossy()
                    ),
                    false,
                ));
            }
            if branch.is_empty() {
                return Err(refuse(
                    "policy-denied",
                    "Only an attached Primary branch may be fast-forwarded.",
                    false,
                ));
            }
            if !git::ancestor(&target, &previous.lossy(), expected, scope).await? {
                let ahead = git::ancestor(&target, expected, &previous.lossy(), scope).await?;
                return Err(refuse(
                    if ahead {
                        "unpushed-commits"
                    } else {
                        "revision-diverged"
                    },
                    if ahead {
                        "The replica contains commits beyond the expected revision and was not changed."
                    } else {
                        "The replica and expected revision have diverged and cannot be fast-forwarded."
                    },
                    false,
                ));
            }
            stage(progress, "fast-forwarding", 75);
            git::run(&target, &["merge", "--ff-only", expected], 32 * MIB, scope).await?;
            let resolved = git::revision(&target, "HEAD", scope).await?;
            let status = git::run(
                &target,
                &["status", "--porcelain=v1", "--untracked-files=normal"],
                4 * MIB,
                scope,
            )
            .await?;
            anyhow::ensure!(
                resolved.as_str() == Some(expected) && status.is_empty(),
                "Replica verification failed after the fast-forward operation."
            );
            return cantrip_crypto::checked(
                "projectReplicaSynchronizeResultSchema",
                &json!({
                    "status":"ready","jobId":input["jobId"],"attempt":input["attempt"],"path":paths::text(&target),
                    "previousRevision":previous,"resolvedRevision":resolved,"branch":branch,"changed":true,
                }),
            );
        }
        cantrip_crypto::checked(
            "projectReplicaSynchronizeResultSchema",
            &json!({
                "status":"ready","jobId":input["jobId"],"attempt":input["attempt"],"path":paths::text(&target),
                "previousRevision":previous,"resolvedRevision":previous,"branch":if branch.is_empty(){Value::Null}else{json!(branch)},"changed":false,
            }),
        )
    }
}
