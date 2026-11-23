use super::*;
#[derive(Default)]
struct Record {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
    prune_reason: Option<String>,
}
fn after<'a>(token: &'a str, prefix: &str) -> Option<&'a str> {
    if token == prefix {
        Some("")
    } else {
        token
            .strip_prefix(prefix)
            .and_then(|tail| tail.strip_prefix(' '))
    }
}
fn parse(output: &str) -> Result<Vec<Record>> {
    let mut rows = Vec::new();
    let mut current: Option<Record> = None;
    for token in output.split('\0') {
        if token.is_empty() {
            if let Some(record) = current.take() {
                rows.push(record);
            }
            continue;
        }
        if let Some(path) = after(token, "worktree") {
            if let Some(record) = current.take() {
                rows.push(record);
            }
            if path.is_empty() {
                bail!("Git returned an empty worktree path.");
            }
            current = Some(Record {
                path: path.to_owned(),
                ..Record::default()
            });
            continue;
        }
        let Some(current) = current.as_mut() else {
            continue;
        };
        if let Some(head) = after(token, "HEAD") {
            current.head = (!head.is_empty()).then(|| head.to_owned());
        } else if let Some(branch) = after(token, "branch") {
            let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
            current.branch = (!branch.is_empty()).then(|| branch.to_owned());
        } else if token == "detached" {
            current.detached = true;
        } else if let Some(reason) = after(token, "locked") {
            current.locked = true;
            current.lock_reason = (!reason.is_empty()).then(|| reason.to_owned());
        } else if let Some(reason) = after(token, "prunable") {
            current.prunable = true;
            current.prune_reason = (!reason.is_empty()).then(|| reason.to_owned());
        }
    }
    if let Some(record) = current {
        rows.push(record);
    }
    Ok(rows)
}
impl Manager {
    pub async fn list(&self, source: &Path, scope: &Scope) -> Result<Value> {
        let source = canonical(Path::new(
            &text(source, &["rev-parse", "--show-toplevel"], scope).await?,
        ))
        .await?;
        let common = common(&source, scope).await?;
        let records =
            parse(&raw(&source, &["worktree", "list", "--porcelain", "-z"], scope).await?)?;
        if records.is_empty() {
            bail!("Git did not report a Primary worktree.");
        }
        let configured = paths::resolve(&self.data.join("worktrees"))?;
        let managed = if exists(&configured).await? {
            canonical(&configured).await?
        } else {
            configured
        };
        let rows=futures::future::join_all(records.into_iter().enumerate().map(|(index,record)|{
            let managed=&managed;
            async move {
                let path=Path::new(&record.path);
                let missing=!exists(path).await?;
                let path=if missing {paths::resolve(path)?}else{canonical(path).await?};
                Ok::<_,anyhow::Error>(json!({"path":paths::text(&path),"head":record.head,"branch":record.branch,
                    "detached":record.detached,"isPrimary":index==0,"managed":within(managed,&path),
                    "locked":record.locked,"lockReason":record.lock_reason,"prunable":record.prunable,
                    "pruneReason":record.prune_reason,"missing":missing}))
            }
        })).await.into_iter().collect::<Result<Vec<_>>>()?;
        scope.check()?;
        let source_text = paths::text(&source);
        if !rows
            .iter()
            .any(|row| row["path"].as_js_string() == Some(&source_text))
        {
            bail!("Project source is not registered in its Git worktree list.");
        }
        checked(
            "worktreeInventorySchema",
            &json!({"sourcePath":source_text,"primaryPath":rows[0]["path"],
            "gitCommonDir":paths::text(&common),"managedRoot":paths::text(&managed),
            "repositoryFingerprint":digest(&paths::text(&common)),"worktrees":rows}),
        )
    }
    pub(super) async fn resolve(
        &self,
        source: &Path,
        target: &Path,
        scope: &Scope,
    ) -> Result<(Value, Value)> {
        let inventory = self.list(source, scope).await?;
        let target = paths::text(&requested(target).await?);
        let worktree = inventory["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["path"].as_js_string() == Some(&target))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("The requested path is not a worktree of this project source.")
            })?;
        if worktree["missing"] != true {
            let common = common(&paths::native(&target), scope).await?;
            if Some(&paths::text(&common)) != inventory["gitCommonDir"].as_js_string() {
                bail!("The requested worktree belongs to a different repository.");
            }
        }
        Ok((inventory, worktree))
    }
    pub async fn authorize_targets(
        &self,
        source: &Path,
        targets: &[PathBuf],
        scope: &Scope,
    ) -> Result<Vec<Value>> {
        let inventory = self.list(source, scope).await?;
        let requested = futures::future::join_all(targets.iter().map(|path| requested(path)))
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        requested
            .iter()
            .map(|target| {
                let target = paths::text(target);
                let worktree = inventory["worktrees"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["path"].as_js_string() == Some(&target))
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "The requested path is not a worktree of this project source."
                        )
                    })?;
                if worktree["missing"] == true {
                    bail!("Cannot authorize a missing worktree.");
                }
                Ok(json!({"inventory":inventory,"worktree":worktree}))
            })
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nul_records_preserve_paths_and_multi_line_reasons() {
        let rows=parse("ignored\0worktree /owned/a\nb\0HEAD abc\0branch refs/heads/main\0\0worktree /owned/c\0detached\0locked review\nreason\0prunable missing gitdir\0").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, "/owned/a\nb");
        assert_eq!(rows[0].branch.as_deref(), Some("main"));
        assert!(rows[1].detached && rows[1].locked && rows[1].prunable);
        assert_eq!(rows[1].lock_reason.as_deref(), Some("review\nreason"));
        assert_eq!(rows[1].prune_reason.as_deref(), Some("missing gitdir"));
        assert!(parse("worktree\0").is_err());
    }
}
