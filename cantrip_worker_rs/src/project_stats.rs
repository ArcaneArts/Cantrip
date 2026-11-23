//! Project insights owned by the worker that holds the selected checkout.
use crate::filesystem::{Scope, paths, storage::open_rooted_regular};
use anyhow::{Context, Result};
use cantrip_wire::{Value, value::json};
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

const GIT: &str = "project.repository-stats";
const FOLDER: &str = "project.folder-stats";
const MAX_GIT_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_TEXT_FILES: usize = 50_000;
const MAX_TEXT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DIRECTORIES: usize = 10_000;
const MAX_ENTRIES: usize = 100_000;
const FOLDER_DURATION: Duration = Duration::from_secs(10);
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub(crate) fn supports(kind: &str) -> bool {
    matches!(kind, GIT | FOLDER)
}

pub(crate) async fn execute(command: &Value, scope: Scope) -> Result<Value> {
    let value = match command["type"].as_str() {
        Some(GIT) => {
            let cwd = command["cwd"].as_js_string().context("Git checkout path")?;
            let root = paths::resolve(&paths::native(cwd))?;
            // Wait for both owned children even if one Git command fails.
            let (count, tracked) = tokio::join!(
                git(&scope, &root, &["rev-list", "--count", "--all"]),
                git(&scope, &root, &["ls-files", "--cached", "-z"]),
            );
            let commit_count = count?.trim_end().parse::<u64>().unwrap_or(0);
            let tracked = tracked?;
            tokio::task::spawn_blocking(move || repository(&root, commit_count, &tracked, &scope))
                .await??
        }
        Some(FOLDER) => {
            let root = command["root"]
                .as_js_string()
                .context("Project folder path")?;
            let root = paths::resolve(&paths::native(root));
            tokio::task::spawn_blocking(move || folder(root.as_deref().ok(), &scope)).await??
        }
        _ => unreachable!("project statistics dispatch"),
    };
    crate::http::checked("projectRepositoryStatsSchema", &value)
}

async fn git(scope: &Scope, root: &Path, args: &[&str]) -> Result<String> {
    let mut argv = vec!["-C".into(), root.as_os_str().to_owned()];
    argv.extend(args.iter().map(std::ffi::OsString::from));
    scope
        .run(OsStr::new("git"), &argv, MAX_GIT_OUTPUT, 30_000)
        .await
}

#[derive(Default)]
struct TextCounts {
    bytes_scanned: u64,
    files: u64,
    lines: u64,
    truncated: bool,
}

impl TextCounts {
    fn scan(&mut self, mut file: File, size: u64) -> io::Result<bool> {
        if size > MAX_FILE_BYTES || self.bytes_scanned + size > MAX_TEXT_BYTES {
            self.truncated = true;
            return Ok(false);
        }
        self.bytes_scanned += size;
        let mut bytes = vec![0; size as usize];
        file.read_exact(&mut bytes)?;
        if bytes.contains(&0) {
            return Ok(false);
        }
        self.files += 1;
        self.lines += bytes.iter().filter(|&&byte| byte == b'\n').count() as u64;
        self.lines += u64::from(bytes.last().is_some_and(|&byte| byte != b'\n'));
        Ok(true)
    }
}

fn repository(root: &Path, commits: u64, tracked: &str, scope: &Scope) -> Result<Value> {
    let paths = || tracked.split('\0').filter(|path| !path.is_empty());
    let tracked_count = paths().count();
    let mut text = TextCounts {
        truncated: tracked_count > MAX_TEXT_FILES,
        ..TextCounts::default()
    };
    let mut bytes = 0_u64;
    let root = Dir::open_ambient_dir(root, ambient_authority());
    for (index, path) in paths().map(Path::new).enumerate() {
        scope.check()?;
        let result = (|| -> io::Result<()> {
            if !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err(io::Error::other("Git path escapes the project."));
            }
            let root = root.as_ref().map_err(io::Error::kind)?;
            let entry = root.symlink_metadata(path)?;
            if entry.is_file() || entry.is_symlink() {
                bytes = bytes.saturating_add(entry.len());
            }
            if entry.is_file() && index < MAX_TEXT_FILES {
                text.scan(open_rooted_regular(root, path)?, entry.len())?;
            }
            Ok(())
        })();
        text.truncated |= result.is_err();
    }
    Ok(json!({
        "kind":"git",
        "commitCount":commits,
        "trackedFileCount":tracked_count,
        "trackedByteCount":bytes,
        "textFileCount":text.files,
        "lineCount":text.lines,
        "excludedFileCount":tracked_count as u64 - text.files,
        "truncated":text.truncated,
    }))
}

fn open_folder(path: &Path) -> io::Result<Dir> {
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        return Dir::open_ambient_dir(parent, ambient_authority())?.open_dir_nofollow(name);
    }
    Dir::open_ambient_dir(path, ambient_authority())
}

#[derive(Default)]
struct FolderCounts {
    files: u64,
    bytes: u64,
    excluded: u64,
    text: TextCounts,
}

impl FolderCounts {
    fn skip(&mut self, truncated: bool) {
        self.excluded += 1;
        self.text.truncated |= truncated;
    }

    fn value(self) -> Value {
        json!({
            "kind":"folder",
            "fileCount":self.files,
            "byteCount":self.bytes,
            "textFileCount":self.text.files,
            "lineCount":self.text.lines,
            "excludedFileCount":self.excluded,
            "truncated":self.text.truncated,
        })
    }
}

fn folder(path: Option<&Path>, scope: &Scope) -> Result<Value> {
    scope.check()?;
    let deadline = Instant::now() + FOLDER_DURATION;
    let mut counts = FolderCounts::default();
    let Some(root) = path.and_then(|path| open_folder(path).ok()) else {
        counts.skip(true);
        return Ok(counts.value());
    };
    let mut directories = vec![PathBuf::from(".")];
    let mut files = Vec::new();
    let mut directory_index = 0;
    let mut seen = 0;
    'discovery: while directory_index < directories.len() {
        scope.check()?;
        if Instant::now() >= deadline || seen >= MAX_ENTRIES {
            counts.skip(true);
            break;
        }
        let directory = directories[directory_index].clone();
        directory_index += 1;
        let entries = root
            .open_dir_nofollow(&directory)
            .and_then(|dir| dir.entries());
        let Ok(entries) = entries else {
            counts.skip(true);
            continue;
        };
        for entry in entries {
            scope.check()?;
            if Instant::now() >= deadline || seen >= MAX_ENTRIES {
                counts.skip(true);
                break 'discovery;
            }
            seen += 1;
            let Ok((name, kind)) =
                entry.and_then(|entry| Ok((entry.file_name(), entry.file_type()?)))
            else {
                counts.skip(true);
                continue;
            };
            if name == ".git" {
                counts.skip(false);
            } else if kind.is_dir() {
                if directories.len() == MAX_DIRECTORIES {
                    counts.skip(true);
                } else {
                    directories.push(directory.join(name));
                }
            } else if kind.is_file() {
                counts.files += 1;
                if files.len() == MAX_TEXT_FILES {
                    counts.skip(true);
                } else {
                    files.push(directory.join(name));
                }
            } else {
                counts.skip(false);
            }
        }
    }
    for file in files {
        scope.check()?;
        if Instant::now() >= deadline {
            counts.text.truncated = true;
            break;
        }
        let outcome = (|| -> io::Result<bool> {
            if !root.symlink_metadata(&file)?.is_file() {
                return Ok(false);
            }
            let file = open_rooted_regular(&root, &file)?;
            let size = file.metadata()?.len();
            if size > MAX_SAFE_INTEGER {
                counts.text.truncated = true;
                return Ok(false);
            }
            counts.bytes = counts.bytes.saturating_add(size);
            if counts.bytes > MAX_SAFE_INTEGER {
                counts.bytes = MAX_SAFE_INTEGER;
                counts.text.truncated = true;
            }
            counts.text.scan(file, size)
        })();
        match outcome {
            Ok(true) => {}
            Ok(false) => counts.skip(false),
            Err(_) => counts.skip(true),
        }
    }
    Ok(counts.value())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn folder_counts_text_binary_and_excluded_entries() -> Result<()> {
        let root = tempfile::tempdir()?;
        std::fs::create_dir(root.path().join("nested"))?;
        std::fs::create_dir(root.path().join(".git"))?;
        std::fs::write(root.path().join(".git/config"), "ignored\n")?;
        std::fs::write(root.path().join("nested/text"), "one\ntwo\n")?;
        std::fs::write(root.path().join("binary"), [0, 1, 2])?;
        std::fs::write(root.path().join("empty"), "")?;
        let stats = execute(
            &json!({"type":FOLDER,"root":paths::text(root.path())}),
            Scope::default(),
        )
        .await?;
        assert_eq!(
            stats,
            json!({
                "kind":"folder","fileCount":3,"byteCount":11,"textFileCount":2,
                "lineCount":2,"excludedFileCount":2,"truncated":false,
            })
        );
        Ok(())
    }

    #[tokio::test]
    async fn repository_counts_index_paths_and_all_commits() -> Result<()> {
        let root = tempfile::tempdir()?;
        let scope = Scope::default();
        git(&scope, root.path(), &["init"]).await?;
        std::fs::write(root.path().join("non-ASCII-é.txt"), "one\ntwo")?;
        std::fs::write(root.path().join("binary.dat"), [0, 1, 2, 3])?;
        git(&scope, root.path(), &["add", "."]).await?;
        git(
            &scope,
            root.path(),
            &[
                "-c",
                "user.name=Cantrip Test",
                "-c",
                "user.email=cantrip@example.com",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-m",
                "test",
            ],
        )
        .await?;
        std::fs::write(root.path().join("untracked"), "unused")?;
        let stats = execute(&json!({"type":GIT,"cwd":paths::text(root.path())}), scope).await?;
        assert_eq!(
            stats,
            json!({
                "kind":"git","commitCount":1,"trackedFileCount":2,"trackedByteCount":11,
                "textFileCount":1,"lineCount":2,"excludedFileCount":1,"truncated":false,
            })
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn folder_scan_skips_symlinked_entries_and_rejects_symlinked_root() -> Result<()> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        std::fs::write(outside.path().join("private"), "outside\n")?;
        let link = root.path().join("linked");
        std::os::unix::fs::symlink(outside.path(), &link)?;
        let scan = |path: &Path| json!({"type":FOLDER,"root":paths::text(path)});
        let stats = execute(&scan(root.path()), Scope::default()).await?;
        assert_eq!(stats["fileCount"], 0);
        assert_eq!(stats["excludedFileCount"], 1);
        assert_eq!(stats["truncated"], false);
        let stats = execute(&scan(&link), Scope::default()).await?;
        assert_eq!(stats["fileCount"], 0);
        assert_eq!(stats["excludedFileCount"], 1);
        assert_eq!(stats["truncated"], true);
        Ok(())
    }
}
