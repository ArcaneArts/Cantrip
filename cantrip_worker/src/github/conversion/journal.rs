use super::{changed, paths};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

pub(super) struct Journal {
    path: PathBuf,
    legacy: PathBuf,
    binding: Value,
    source: JsString,
    initial_commit: Value,
    native: Option<Value>,
    legacy_matches: bool,
}

impl Journal {
    pub(super) fn new(data: &Path, root: &Path, input: &Value, repository: &Value) -> Result<Self> {
        let job =
            uuid::Uuid::parse_str(input["jobId"].as_str().context("Missing conversion job.")?)?;
        let path = data.join("folder-conversions").join(format!("{job}.json"));
        let legacy = root.join(".git").join("cantrip-conversion.json");
        let binding = json!({
            "confirmationToken":input["confirmationToken"], "jobId":input["jobId"],
            "projectId":input["projectId"], "repositoryId":repository["repositoryId"]
        });
        let source = paths::text(root);
        let initial_commit = input["initialCommit"].clone();
        let native = read(&path)?;
        if let Some(record) = &native {
            if record["version"] != 1
                || record["binding"] != binding
                || record["source"].as_js_string() != Some(&source)
                || record["initialCommit"] != initial_commit
                || !record["branch"]
                    .as_js_string()
                    .is_some_and(|branch| !branch.is_empty())
                || (!record["head"].is_null() && record["head"].as_js_string().is_none())
            {
                return Err(changed());
            }
        }
        let legacy_matches = read(&legacy).ok().flatten().is_some_and(|marker| {
            ["confirmationToken", "jobId", "projectId", "repositoryId"]
                .iter()
                .all(|&key| marker[key] == binding[key])
        });
        Ok(Self {
            path,
            legacy,
            binding,
            source,
            initial_commit,
            native,
            legacy_matches,
        })
    }

    pub(super) fn resumes(&self) -> bool {
        self.native.is_some() || self.legacy_matches
    }

    pub(super) fn check_head(
        &self,
        branch: Option<&JsString>,
        head: Option<&JsString>,
    ) -> Result<()> {
        if let Some(record) = &self.native {
            let prepared = record["head"].as_js_string();
            if branch.is_some_and(|branch| Some(branch) != record["branch"].as_js_string())
                || prepared.is_some_and(|prepared| Some(prepared) != head || branch.is_none())
            {
                return Err(changed());
            }
        }
        Ok(())
    }

    pub(super) fn record(&mut self, branch: &JsString, head: Option<&JsString>) -> Result<()> {
        let record = json!({
            "version":1, "binding":self.binding, "source":self.source,
            "initialCommit":self.initial_commit, "branch":branch, "head":head
        });
        if self.native.as_ref() != Some(&record) {
            cantrip_host::files::private_directory(self.path.parent().unwrap())?;
            write(&self.path, &record)?;
            self.native = Some(record);
        }
        Ok(())
    }

    pub(super) fn write_legacy(&mut self) -> Result<()> {
        if !self.legacy_matches {
            write(&self.legacy, &self.binding)?;
            self.legacy_matches = true;
        }
        Ok(())
    }

    pub(super) fn finish(&self) -> Result<()> {
        for (remove, path) in [
            (self.legacy_matches, &self.legacy),
            (self.native.is_some(), &self.path),
        ] {
            if remove {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }
}

fn read(path: &Path) -> Result<Option<Value>> {
    const LIMIT: u64 = 64 * 1024;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(metadata.is_file(), "Invalid conversion journal file.");
    let mut text = String::new();
    File::open(path)?
        .take(LIMIT + 1)
        .read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= LIMIT,
        "Conversion journal is too large."
    );
    Ok(Some(
        parse_json_text(&text).map_err(crate::error::WireError)?,
    ))
}

fn write(path: &Path, value: &Value) -> Result<()> {
    let directory = path
        .parent()
        .context("Missing conversion journal directory.")?;
    ensure!(
        fs::symlink_metadata(directory)?.is_dir(),
        "Invalid conversion journal directory."
    );
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    pending.write_all(value.stringify().as_bytes())?;
    pending.as_file().sync_all()?;
    pending.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(())
}
