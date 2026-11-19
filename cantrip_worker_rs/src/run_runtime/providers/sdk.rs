//! SDK path rendering and inspection shared by Dart and Flutter.
use super::executable_file;
use crate::filesystem::paths;
use std::{
    io,
    path::{Path, PathBuf},
};

pub(super) struct Sdk {
    pub name: &'static str,
    pub program: &'static str,
}

impl Sdk {
    pub(super) fn executable(&self, home: &Path) -> PathBuf {
        let path = home.join("bin").join(self.program);
        if paths::absolute(home) {
            cantrip_config::resolve(Path::new(""), &path)
        } else {
            path
        }
    }

    fn require_absolute(&self, home: &Path) -> Result<(), String> {
        if !paths::absolute(home) {
            return Err(format!(
                "The selected {} SDK home must be an absolute path for the target platform.",
                self.name
            ));
        }
        Ok(())
    }

    pub(super) fn configured(&self, home: &Path) -> Result<PathBuf, String> {
        self.require_absolute(home)?;
        Ok(self.executable(home))
    }

    pub(super) fn inspect(&self, home: &Path) -> Result<PathBuf, String> {
        self.require_absolute(home)?;
        let home = canonical(home)?;
        if !home.is_dir() {
            return Err(format!(
                "The selected {} SDK home is not a directory.",
                self.name
            ));
        }
        let executable = canonical(&self.executable(&home))?;
        if !executable_file(&executable) {
            return Err(format!(
                "The selected {} SDK home does not contain a {} executable.",
                self.name, self.name
            ));
        }
        Ok(executable)
    }
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    paths::canonical_sync(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!(
                "ENOENT: no such file or directory, realpath '{}'",
                path.display()
            )
        } else {
            error.to_string()
        }
    })
}
