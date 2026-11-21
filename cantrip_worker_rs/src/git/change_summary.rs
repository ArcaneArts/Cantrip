use super::process::{self, Output};
use crate::filesystem::{Scope, storage::open_rooted_regular};
use anyhow::{Context, Result, bail};
use cantrip_wire::{Value, value::json};
use cap_std::{ambient_authority, fs::Dir};
use std::{
    collections::HashMap,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::Duration,
};

const COMMIT_LIMIT: u64 = 1_000;
const UNTRACKED_LIMIT: usize = 10_000;
const FILE_BYTES_LIMIT: u64 = 8 * 1024 * 1024;
const TEXT_BYTES_LIMIT: u64 = 32 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const DIFF_FLAGS: &[&str] = &[
    "--numstat",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--",
];

#[derive(Default)]
struct FileChange {
    dirty: bool,
    binary: bool,
}

#[derive(Default)]
struct Summary<'a> {
    files: HashMap<&'a [u8], FileChange>,
    additions: u64,
    deletions: u64,
    commits: u64,
    partial: bool,
}

pub(super) async fn read(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let since = command["since"]
        .as_str()
        .context("Git change summary start time")?;
    let until = command["until"].as_str();
    let root = stdout(capture(cwd, &["rev-parse", "--show-toplevel"], scope).await?)?;
    let root = root
        .strip_suffix(b"\r\n")
        .or_else(|| root.strip_suffix(b"\n"))
        .unwrap_or(&root);
    let root = path_from_git(root);

    let head = capture(&root, &["rev-parse", "--verify", "--quiet", "HEAD"], scope).await?;
    let head = if head.code == Some(1) && !head.timed_out && !head.overflow {
        None
    } else {
        let bytes = stdout(head)?;
        let value = std::str::from_utf8(&bytes)?.trim();
        if !commit_hash(value.as_bytes()) {
            bail!("Git did not return a commit ID for the selected worktree.");
        }
        Some(value.to_owned())
    };

    let mut staged = vec!["diff", "--cached"];
    staged.extend(DIFF_FLAGS);
    let mut unstaged = vec!["diff"];
    unstaged.extend(DIFF_FLAGS);
    let (committed, staged, unstaged, untracked) = tokio::join!(
        history(&root, head.as_deref(), since, until, scope),
        capture(&root, &staged, scope),
        capture(&root, &unstaged, scope),
        capture(
            &root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            scope
        ),
    );
    let committed = committed?;
    let staged = stdout(staged?)?;
    let unstaged = stdout(unstaged?)?;
    let untracked = stdout(untracked?)?;
    let scope = scope.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut summary = Summary::default();
        summary.numstat(&committed, false);
        summary.partial = summary.commits > COMMIT_LIMIT;
        summary.numstat(&staged, true);
        summary.numstat(&unstaged, true);
        summary.untracked(&root, &untracked, &scope)?;
        Ok::<_, anyhow::Error>(summary.value())
    })
    .await??;
    crate::http::checked("gitChangeSummarySchema", &result)
}

async fn history(
    root: &Path,
    head: Option<&str>,
    since: &str,
    until: Option<&str>,
    scope: &Scope,
) -> Result<Vec<u8>> {
    let Some(head) = head else {
        return Ok(vec![]);
    };
    let since = format!("--since-as-filter={since}");
    let until = until.map(|value| format!("--until={value}"));
    let maximum = format!("--max-count={}", COMMIT_LIMIT + 1);
    // First-parent merge diffs count an incoming branch's edits once.
    let mut args = vec![
        "log",
        "--first-parent",
        "--diff-merges=first-parent",
        "--root",
        "--format=%x00commit:%H%x00",
        "--no-color",
        "--numstat",
        "-z",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        &since,
        &maximum,
    ];
    args.extend(until.as_deref());
    args.extend([head, "--"]);
    stdout(capture(root, &args, scope).await?)
}

async fn capture(root: &Path, args: &[&str], scope: &Scope) -> Result<Output> {
    process::capture_options(
        root,
        args,
        scope,
        &[],
        None,
        Some(Duration::from_secs(30)),
        OUTPUT_LIMIT,
    )
    .await
}

fn stdout(output: Output) -> Result<Vec<u8>> {
    if output.code != Some(0) || output.overflow || output.timed_out {
        bail!("{}", output.error);
    }
    Ok(output.bytes)
}

fn commit_hash(value: &[u8]) -> bool {
    (40..=64).contains(&value.len())
        && value
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn path_from_git(value: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(std::ffi::OsStr::from_bytes(value))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(value).as_ref())
    }
}

fn count(field: &[u8]) -> Option<Option<u64>> {
    if field == b"-" {
        return Some(None);
    }
    if field.is_empty() || !field.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(field).ok()?.parse().ok().map(Some)
}

impl<'a> Summary<'a> {
    fn numstat(&mut self, output: &'a [u8], working: bool) {
        let mut records = output.split(|&b| b == 0);
        while let Some(record) = records.next() {
            let record = record.strip_prefix(b"\n").unwrap_or(record);
            if !working && record.strip_prefix(b"commit:").is_some_and(commit_hash) {
                self.commits += 1;
                continue;
            }
            let mut fields = record.splitn(3, |&b| b == b'\t');
            let (Some(added), Some(removed), Some(mut path)) = (
                fields.next().and_then(count),
                fields.next().and_then(count),
                fields.next(),
            ) else {
                continue;
            };
            if path.is_empty() {
                records.next(); // Consume the old path even if it looks like a commit header.
                let Some(destination) = records.next().filter(|path| !path.is_empty()) else {
                    continue;
                };
                path = destination;
            }
            let file = self.files.entry(path).or_default();
            file.dirty |= working;
            file.binary |= added.is_none() || removed.is_none();
            self.additions += added.unwrap_or(0);
            self.deletions += removed.unwrap_or(0);
        }
    }

    fn untracked(&mut self, root: &Path, output: &'a [u8], scope: &Scope) -> Result<()> {
        let root = Dir::open_ambient_dir(root, ambient_authority());
        let mut available = TEXT_BYTES_LIMIT;
        for (index, path) in output
            .split(|&byte| byte == 0)
            .filter(|path| !path.is_empty())
            .enumerate()
        {
            scope.check()?;
            let file = self.files.entry(path).or_default();
            file.dirty = true;
            if index >= UNTRACKED_LIMIT {
                self.partial = true;
                continue;
            }
            let content = root.as_ref().ok().and_then(|root| {
                untracked_content(root, &path_from_git(path), &mut available).ok()
            });
            match content {
                Some(bytes) if bytes.contains(&0) => file.binary = true,
                Some(bytes) => {
                    self.additions += bytes.iter().filter(|&&byte| byte == b'\n').count() as u64;
                    self.additions += u64::from(bytes.last().is_some_and(|&byte| byte != b'\n'));
                }
                None => self.partial = true,
            }
        }
        scope.check()
    }

    fn value(self) -> Value {
        json!({
            "filesChanged":self.files.len(),
            "additions":self.additions,
            "deletions":self.deletions,
            "commits":self.commits,
            "uncommittedFiles":self.files.values().filter(|file| file.dirty).count(),
            "binaryFiles":self.files.values().filter(|file| file.binary).count(),
            "partial":self.partial,
            "observedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
    }
}

fn untracked_content(root: &Dir, path: &Path, available: &mut u64) -> io::Result<Vec<u8>> {
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(io::Error::other("Git path escapes the selected worktree."));
    }
    let metadata = root.symlink_metadata(path)?;
    let limit = FILE_BYTES_LIMIT.min(*available);
    let too_large = || io::Error::other("Untracked file exceeds the Git change summary limit.");
    if metadata.len() > limit {
        return Err(too_large());
    }
    *available -= metadata.len();
    let bytes = if metadata.is_symlink() {
        root.read_link_contents(path)?
            .as_os_str()
            .as_encoded_bytes()
            .to_vec()
    } else {
        let mut bytes = Vec::new();
        open_rooted_regular(root, path)?
            .take(limit + 1)
            .read_to_end(&mut bytes)?;
        bytes
    };
    if bytes.len() as u64 > limit {
        *available = available.saturating_sub(limit - metadata.len());
        return Err(too_large());
    }
    *available -= (bytes.len() as u64).saturating_sub(metadata.len());
    Ok(bytes)
}
