use super::{
    Scope, paths, repository, source_path,
    storage::{self, FolderLocation},
};
use crate::routing::Registry;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct AttachmentError {
    pub code: &'static str,
}
impl std::fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The existing folder could not be attached on its owning worker.")
    }
}
impl std::error::Error for AttachmentError {}
pub struct Manager {
    data: PathBuf,
}
async fn entry(path: &Path) -> Result<Option<std::fs::Metadata>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
impl Manager {
    pub fn new(data: &Path) -> Self {
        Self {
            data: data.to_owned(),
        }
    }
    async fn verified_target(
        &self,
        project: &JsString,
        storage: &Value,
    ) -> Result<(FolderLocation, PathBuf)> {
        let location = storage::folder_location(&self.data, project, storage)?;
        let root = if storage["kind"] == "managed" {
            storage::ensure_workspace_directory(&self.data, storage, &["folders".into()]).await?
        } else {
            storage::make_directory(&location.root, true).await?;
            location.root.clone()
        };
        let entry = tokio::fs::symlink_metadata(&root).await?;
        if !entry.is_dir() || entry.file_type().is_symlink() {
            bail!("The managed folders root is not a safe directory.");
        }
        let canonical = source_path::canonical(&paths::text(&root)).await?;
        Ok((location, canonical))
    }
    pub async fn resolve(
        &self,
        project: &JsString,
        storage: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        let (location, root) = self.verified_target(project, storage).await?;
        if !entry(&location.target)
            .await?
            .is_some_and(|e| e.is_dir() && !e.file_type().is_symlink())
        {
            bail!("The managed folder target is not a safe directory.");
        }
        let canonical = source_path::canonical(&paths::text(&location.target)).await?;
        if canonical.parent() != Some(root.as_path()) {
            bail!("The managed folder target escaped its storage root.");
        }
        Ok(
            json!({"path":paths::text(&canonical),"displayPath":paths::text(&location.display_path)}),
        )
    }
    pub async fn materialize(&self, input: &Value, scope: &Scope) -> Result<Value> {
        scope.check()?;
        if let Some(existing) = input["existingPath"]
            .as_js_string()
            .filter(|s| !s.is_empty())
        {
            let canonical = async {
                let requested = source_path::normalize(existing, cfg!(windows))?;
                let canonical = paths::canonical(&paths::native(&requested)).await?;
                let canonical = paths::native(&source_path::normalize(
                    &paths::text(&canonical),
                    cfg!(windows),
                )?);
                if !tokio::fs::symlink_metadata(&canonical).await?.is_dir() {
                    return Err(AttachmentError {
                        code: "existing-path-not-directory",
                    }
                    .into());
                }
                Ok::<_, anyhow::Error>(canonical)
            }
            .await
            .map_err(|error| {
                if error.is::<AttachmentError>() {
                    return error;
                }
                let code = match error
                    .downcast_ref::<std::io::Error>()
                    .map(std::io::Error::kind)
                {
                    Some(std::io::ErrorKind::NotFound) => "existing-path-missing",
                    Some(std::io::ErrorKind::NotADirectory) => "existing-path-not-directory",
                    Some(std::io::ErrorKind::PermissionDenied) => "existing-path-permission-denied",
                    _ => "attachment-failed",
                };
                anyhow::Error::from(AttachmentError { code })
            })?;
            let repository = repository::inspect_checkout(&canonical, scope).await?;
            return checked(
                "managedFolderMaterializeReadySchema",
                &json!({"status":"ready","jobId":input["jobId"],"attempt":input["attempt"],"path":paths::text(&canonical),"displayPath":existing,"reused":true,"github":repository["github"],"repositoryFingerprint":repository["repositoryFingerprint"]}),
            );
        }
        let system = json!({"kind":"system"});
        let storage = input.get("workspaceStorage").unwrap_or(&system);
        let (location, root) = self
            .verified_target(input["projectId"].as_js_string().unwrap(), storage)
            .await?;
        let existing = entry(&location.target).await?;
        if existing
            .as_ref()
            .is_some_and(|e| !e.is_dir() || e.file_type().is_symlink())
        {
            bail!("The managed folder target is not a safe directory.");
        }
        scope.check()?;
        if existing.is_none() {
            storage::make_directory(&location.target, false).await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(
                    &location.target,
                    std::fs::Permissions::from_mode(0o700),
                )
                .await?;
            }
            #[cfg(windows)]
            if let Ok(metadata) = tokio::fs::metadata(&location.target).await {
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = tokio::fs::set_permissions(&location.target, permissions).await;
            }
        }
        let entry = tokio::fs::symlink_metadata(&location.target).await?;
        if !entry.is_dir() || entry.file_type().is_symlink() {
            bail!("The managed folder target changed during creation.");
        }
        let canonical = source_path::canonical(&paths::text(&location.target)).await?;
        if canonical.parent() != Some(root.as_path()) {
            bail!("The managed folder target escaped its storage root.");
        }
        checked(
            "managedFolderMaterializeReadySchema",
            &json!({"status":"ready","jobId":input["jobId"],"attempt":input["attempt"],"path":paths::text(&canonical),"displayPath":paths::text(&location.display_path),"reused":existing.is_some()}),
        )
    }
    pub async fn delete(
        &self,
        project: &JsString,
        storage: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        let (location, root) = self.verified_target(project, storage).await?;
        let Some(entry) = entry(&location.target).await? else {
            return checked("managedFolderDeleteResultSchema", &json!({"deleted":false}));
        };
        if !entry.is_dir() || entry.file_type().is_symlink() {
            bail!("The managed folder target is not a safe directory.");
        }
        let canonical = source_path::canonical(&paths::text(&location.target)).await?;
        if canonical.parent() != Some(root.as_path()) {
            bail!("The managed folder target escaped its storage root.");
        }
        scope.check()?;
        tokio::fs::remove_dir_all(&location.target).await?;
        checked("managedFolderDeleteResultSchema", &json!({"deleted":true}))
    }
    pub async fn execute_routed(
        &self,
        command: &Value,
        registry: &Registry,
        scope: &Scope,
    ) -> Result<Value> {
        let kind = command["type"].as_str().unwrap();
        let result = async {
            let resolved = registry.resolve(command).await?;
            let system = json!({"kind":"system"});
            let result = match kind {
                "project.folder.materialize" => self.materialize(&resolved, scope).await?,
                "project.folder.delete" => {
                    self.delete(
                        resolved["projectId"].as_js_string().unwrap(),
                        resolved.get("workspaceStorage").unwrap_or(&system),
                        scope,
                    )
                    .await?
                }
                _ => bail!("Unsupported managed-folder command."),
            };
            registry.protect_result(kind, &result).await
        }
        .await;
        result.map_err(|error| crate::routing::protect_error(kind, error))
    }
}
