use super::*;
fn slug(name: &JsString) -> String {
    let normalized =
        icu_normalizer::DecomposingNormalizer::new_nfkd().normalize_utf16(name.units());
    let normalized = JsString::new(normalized.into_owned()).lowercase();
    let mut slug = String::new();
    for &unit in normalized.units() {
        if (97..=122).contains(&unit) || (48..=57).contains(&unit) {
            slug.push(unit as u8 as char);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let mut slug = slug.trim_matches('-').to_owned();
    slug.truncate(48);
    if slug.is_empty() {
        "worktree".into()
    } else {
        slug
    }
}
async fn mkdir(path: &Path) -> Result<()> {
    storage::make_directory(path, true)
        .await
        .map_err(|error| io_error("mkdir", path, error))
}
impl Manager {
    async fn managed_target(
        &self,
        inventory: &Value,
        id: &JsString,
        name: &JsString,
    ) -> Result<PathBuf> {
        let managed = paths::native(inventory["managedRoot"].as_js_string().unwrap());
        mkdir(&managed).await?;
        let managed = canonical(&managed).await?;
        let repository = managed.join(&inventory["repositoryFingerprint"].as_str().unwrap()[..20]);
        mkdir(&repository).await?;
        let repository = canonical(&repository).await?;
        if !within(&managed, &repository) {
            bail!("Managed worktree root escaped the worker data directory.");
        }
        let target = repository.join(format!("{}-{}", slug(name), &digest(id)[..12]));
        if !within(&managed, &target) {
            bail!("Managed worktree path escaped the worker data directory.");
        }
        Ok(target)
    }
    pub(super) async fn create(
        &self,
        source: &Path,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let inventory = self.list(source, scope).await?;
        let target = self
            .managed_target(
                &inventory,
                command["worktreeId"].as_js_string().unwrap(),
                command["name"].as_js_string().unwrap(),
            )
            .await?;
        let source = paths::native(inventory["sourcePath"].as_js_string().unwrap());
        let target_text = paths::text(&target);
        let target_arg = target_text.lossy();
        let mode = &command["mode"];
        let branch = mode["branch"].as_js_string().map(JsString::lossy);
        let revision = mode["revision"].as_js_string().map(JsString::lossy);
        let start = mode["startPoint"].as_js_string().map(JsString::lossy);
        let mut args = vec!["worktree", "add"];
        let mut detached = None;
        match mode["type"].as_str().unwrap() {
            "newBranch" => {
                let branch = branch.as_deref().unwrap();
                text(&source, &["check-ref-format", "--branch", branch], scope).await?;
                if let Some(start) = start.as_deref() {
                    text(
                        &source,
                        &[
                            "rev-parse",
                            "--verify",
                            "--end-of-options",
                            &format!("{start}^{{commit}}"),
                        ],
                        scope,
                    )
                    .await?;
                }
                args.extend(["-b", branch, "--", &target_arg]);
                if let Some(start) = start.as_deref() {
                    args.push(start);
                }
            }
            "existingBranch" => {
                let branch = branch.as_deref().unwrap();
                text(&source, &["check-ref-format", "--branch", branch], scope).await?;
                text(
                    &source,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("refs/heads/{branch}^{{commit}}"),
                    ],
                    scope,
                )
                .await?;
                args.extend(["--", &target_arg, branch]);
            }
            _ => {
                let revision = revision.as_deref().unwrap();
                detached = Some(
                    text(
                        &source,
                        &[
                            "rev-parse",
                            "--verify",
                            "--end-of-options",
                            &format!("{revision}^{{commit}}"),
                        ],
                        scope,
                    )
                    .await?,
                );
                args.extend(["--detach", "--", &target_arg, revision]);
            }
        }
        if let Some(existing) = inventory["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["path"].as_js_string() == Some(&target_text))
        {
            let matches = existing["isPrimary"] != true
                && existing["managed"] == true
                && existing["missing"] != true
                && existing["prunable"] != true
                && if mode["type"] == "detached" {
                    existing["detached"] == true && existing["head"].as_str() == detached.as_deref()
                } else {
                    existing["detached"] != true && existing["branch"] == mode["branch"]
                };
            if !matches {
                bail!("The managed worktree identity belongs to a different create request.");
            }
            return checked(
                "worktreeCreateResultSchema",
                &json!({"created":false,"worktree":existing,"inventory":inventory}),
            );
        }
        if exists(&target).await? {
            bail!("The managed worktree destination already exists.");
        }
        text(&source, &args, scope).await?;
        let next = self.list(&source, scope).await?;
        let created = next["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["path"].as_js_string() == Some(&target_text))
            .filter(|row| row["managed"] == true)
            .ok_or_else(|| anyhow::anyhow!("Git created a worktree outside the managed root."))?;
        checked(
            "worktreeCreateResultSchema",
            &json!({"created":true,"worktree":created,"inventory":next}),
        )
    }
    pub(super) async fn remove(
        &self,
        source: &Path,
        command: &Value,
        scope: &Scope,
        before: Option<&BeforeRemove>,
    ) -> Result<Value> {
        let (inventory, worktree) = self
            .resolve(
                source,
                &paths::native(command["worktreePath"].as_js_string().unwrap()),
                scope,
            )
            .await?;
        if worktree["isPrimary"] == true {
            bail!("Primary cannot be removed as an individual worktree.");
        }
        if worktree["managed"] != true && command["allowExternal"] != true {
            bail!("Removing an external worktree requires explicit user authorization.");
        }
        if worktree["locked"] == true {
            bail!("Unlock the worktree before removing it.");
        }
        if worktree["missing"] == true {
            bail!("The worktree is missing; prune its stale metadata instead.");
        }
        let path = paths::native(worktree["path"].as_js_string().unwrap());
        let dirty = !text(
            &path,
            &["status", "--porcelain", "--untracked-files=all"],
            scope,
        )
        .await?
        .is_empty();
        if dirty && command["force"] != true {
            bail!("The worktree has uncommitted changes.");
        }
        if let Some(before) = before {
            before(path.clone()).await?;
        }
        let mut args = vec!["worktree", "remove"];
        if command["force"] == true {
            args.push("--force");
        }
        let target = paths::text(&path);
        let target = target.lossy();
        args.push(&target);
        let source = paths::native(inventory["sourcePath"].as_js_string().unwrap());
        text(&source, &args, scope).await?;
        checked(
            "worktreeRemoveResultSchema",
            &json!({"removedPath":worktree["path"],"inventory":self.list(&source,scope).await?}),
        )
    }
    pub(super) async fn lock(
        &self,
        source: &Path,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let (inventory, worktree) = self
            .resolve(
                source,
                &paths::native(command["worktreePath"].as_js_string().unwrap()),
                scope,
            )
            .await?;
        let unlock = command["type"] == "worktree.unlock";
        if worktree["isPrimary"] == true {
            bail!(
                "{}",
                if unlock {
                    "Primary cannot be unlocked."
                } else {
                    "Primary cannot be locked."
                }
            );
        }
        if !unlock && worktree["missing"] == true {
            bail!("A missing worktree cannot be locked.");
        }
        if unlock && worktree["locked"] != true {
            bail!("The worktree is not locked.");
        }
        let source = paths::native(inventory["sourcePath"].as_js_string().unwrap());
        if unlock || worktree["locked"] != true {
            let reason = command["reason"].as_js_string().map(JsString::lossy);
            let target = worktree["path"].as_js_string().unwrap().lossy();
            let mut args = vec!["worktree", if unlock { "unlock" } else { "lock" }];
            if !unlock && let Some(reason) = reason.as_deref().filter(|reason| !reason.is_empty()) {
                args.extend(["--reason", reason]);
            }
            args.push(&target);
            text(&source, &args, scope).await?;
        }
        let next = self.list(&source, scope).await?;
        let worktree = next["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["path"] == worktree["path"]);
        checked(
            "worktreeMutationResultSchema",
            &json!({"worktree":worktree,"inventory":next}),
        )
    }
    pub(super) async fn prune(
        &self,
        source: &Path,
        allow_external: bool,
        scope: &Scope,
    ) -> Result<Value> {
        let before = self.list(source, scope).await?;
        if !allow_external
            && before["worktrees"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["prunable"] == true && row["managed"] != true)
        {
            bail!("Pruning stale external worktrees requires explicit user authorization.");
        }
        let source = paths::native(before["sourcePath"].as_js_string().unwrap());
        text(&source, &["worktree", "prune", "--expire", "now"], scope).await?;
        let inventory = self.list(&source, scope).await?;
        let remaining = inventory["worktrees"].as_array().unwrap();
        let pruned: Vec<_> = before["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| {
                row["prunable"] == true
                    && !remaining.iter().any(|other| other["path"] == row["path"])
            })
            .map(|row| row["path"].clone())
            .collect();
        checked(
            "worktreePruneResultSchema",
            &json!({"prunedPaths":pruned,"inventory":inventory}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_slug_bounds_and_identity_are_source_compatible() {
        assert_eq!(slug(&" Ｆéature 🧙 Straße ".into()), "fe-ature-stra-e");
        assert_eq!(slug(&"🧙\u{0301}".into()), "worktree");
        assert_eq!(
            slug(&format!("{}suffix", "a".repeat(49)).into()),
            "a".repeat(48)
        );
        assert_eq!(
            digest(&JsString::new(vec![0xd800])),
            digest(&"\u{fffd}".into())
        );
    }
}
