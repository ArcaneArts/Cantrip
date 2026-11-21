//! Whole-project removal for repositories managed by an older worker.
use super::Manager;
use crate::filesystem::{Scope, paths};
use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value, value::json};
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
};

pub(crate) const COMMAND: &str = "project.files.delete";

impl Manager {
    pub(crate) async fn remove_retained<Stop>(
        &self,
        target: &JsString,
        scope: &Scope,
        stop_runs: impl FnOnce(PathBuf) -> Stop,
    ) -> Result<Value>
    where
        Stop: Future<Output = Result<()>>,
    {
        scope.check()?;
        let root = paths::resolve(&self.directory.join("repositories"))?;
        let target = paths::resolve(&paths::native(target))?;
        let (canonical, directory) =
            tokio::task::spawn_blocking(move || open_managed(&root, &target)).await??;

        stop_runs(canonical).await?;
        scope.check()?;
        let Some(directory) = directory else {
            return Ok(json!({"deleted":false}));
        };
        let deleted = tokio::task::spawn_blocking(move || match directory.remove_open_dir_all() {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).context("Could not remove the managed repository."),
        })
        .await??;
        Ok(json!({"deleted":deleted}))
    }
}

fn open_managed(root: &Path, target: &Path) -> Result<(PathBuf, Option<Dir>)> {
    let relative = target
        .strip_prefix(root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .context("Cantrip will only delete repositories it manages.")?;
    let canonical_root = match paths::canonical_sync(root) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((target.to_owned(), None));
        }
        Err(error) => {
            return Err(error).context("Could not open the managed repositories directory.");
        }
    };
    let canonical = canonical_root.join(relative);
    let open = || -> io::Result<Dir> {
        let mut parent = Dir::open_ambient_dir(&canonical_root, ambient_authority())?;
        for part in relative.components() {
            parent = parent.open_dir_nofollow(part.as_os_str())?;
        }
        Ok(parent)
    };
    match open() {
        Ok(directory) => Ok((canonical, Some(directory))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok((canonical, None)),
        Err(error) => Err(error).context("The project source is not a managed directory."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retires_runs_then_removes_the_retained_checkout_and_retries() -> Result<()> {
        let profile = tempfile::tempdir()?;
        let manager = Manager::new(profile.path(), &"worker".into());
        let checkout = profile.path().join("repositories/owned/repository");
        let sibling = checkout.with_file_name("sibling");
        std::fs::create_dir_all(&checkout)?;
        std::fs::create_dir_all(&sibling)?;
        std::fs::write(checkout.join("local changes"), "owned data")?;
        let scope = Scope::default();
        let result = manager
            .remove_retained(&paths::text(&checkout), &scope, |directory| async move {
                assert_eq!(
                    std::fs::read(directory.join("local changes"))?,
                    b"owned data"
                );
                Ok(())
            })
            .await?;
        assert_eq!(result, json!({"deleted":true}));
        assert!(!checkout.exists());
        assert!(sibling.is_dir());
        let result = manager
            .remove_retained(&paths::text(&checkout), &scope, |_| async { Ok(()) })
            .await?;
        assert_eq!(result, json!({"deleted":false}));
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_a_linked_checkout_and_a_linked_parent_before_retirement() -> Result<()> {
        let profile = tempfile::tempdir()?;
        let external = tempfile::tempdir()?;
        let repositories = profile.path().join("repositories");
        let linked = repositories.join("linked");
        std::fs::create_dir_all(&repositories)?;
        std::fs::create_dir(external.path().join("checkout"))?;
        std::os::unix::fs::symlink(external.path(), &linked)?;
        let manager = Manager::new(profile.path(), &"worker".into());
        for invalid in [
            &repositories,
            &linked,
            &linked.join("checkout"),
            &external.path().to_owned(),
        ] {
            let result = manager
                .remove_retained(&paths::text(invalid), &Scope::default(), |_| async {
                    panic!("retirement must stay within the managed directory")
                })
                .await;
            assert!(result.is_err());
        }
        assert!(external.path().join("checkout").is_dir());
        Ok(())
    }
}
