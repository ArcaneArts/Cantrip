//! Checkout-scoped Explorer reads for principals without ambient filesystem access.
use super::{
    date_iso, decode,
    search::{Sorting, score},
};
use crate::filesystem::{Scope, paths, storage::open_rooted_regular};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_protocol::external_mcp::{inspection, orchestration::Call};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use cap_fs_ext::DirExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata},
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_DIRECTORY_ENTRIES: usize = 1000;
const MAX_SEARCH_ENTRIES: usize = 20_000;
const MAX_RESULT_BYTES: usize = 20 * 1024;

pub(crate) async fn resolve_checkout(
    worktrees: &crate::git::worktrees::Manager,
    checkout: &Value,
    scope: &Scope,
) -> Result<PathBuf> {
    let source = checkout["sourcePath"]
        .as_js_string()
        .context("Checkout source")?;
    let target = checkout["worktreePath"]
        .as_js_string()
        .context("Checkout path")?;
    let source = paths::native(source);
    let target = paths::native(target);
    let root = match checkout["rootKind"].as_str() {
        Some("folder-root") => {
            let root = paths::canonical(&target).await?;
            ensure!(paths::equal(&source, &root), "The project folder changed.");
            root
        }
        Some("git-worktree") => {
            worktrees
                .authorize_checkout(&source, &target, scope)
                .await?
        }
        _ => bail!("The checkout root type is unavailable on this worker."),
    };
    ensure!(paths::equal(&target, &root), "The checkout path changed.");
    Ok(root)
}

pub(crate) async fn execute(root: PathBuf, call: Call, scope: Scope) -> Result<Value> {
    tokio::task::spawn_blocking(move || {
        let directory = open_checkout(&root)?;
        scope.check()?;
        match call {
            Call::DirectoryList(input) => directory_list(&directory, &input),
            Call::FileMetadata(input) => {
                let (parent, name) = parent(&directory, &input.path)?;
                let metadata = parent
                    .symlink_metadata(&name)
                    .context("File is unavailable.")?;
                Ok(json!({"summary":"Read checkout entry metadata.",
                    "entry":entry(&input.path, &metadata)?}))
            }
            Call::FileRead(input) => file_read(&directory, &input),
            Call::FileSearch(input) => file_search(&directory, &input, &scope),
            _ => bail!("Unsupported checkout file operation."),
        }
    })
    .await?
}

pub(crate) fn open_checkout(root: &Path) -> Result<Dir> {
    let canonical = paths::canonical_sync(root).context("The checkout path is unavailable.")?;
    ensure!(
        paths::equal(root, &canonical),
        "The registered checkout path changed."
    );
    let anchor = canonical
        .ancestors()
        .last()
        .context("The checkout has no filesystem root.")?;
    let mut directory = Dir::open_ambient_dir(anchor, ambient_authority())?;
    for segment in canonical.strip_prefix(anchor)?.components() {
        directory = directory
            .open_dir_nofollow(segment.as_os_str())
            .context("The registered checkout directory moved.")?;
    }
    Ok(directory)
}

pub(crate) fn working_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    let checkout = open_checkout(root)?;
    directory_at(&checkout, relative).context("The checkout working directory is unavailable.")?;
    Ok(root.join(relative))
}

pub(crate) fn contains_regular(root: &Dir, relative: &str) -> bool {
    parent(root, relative)
        .is_ok_and(|(directory, name)| open_rooted_regular(&directory, Path::new(&name)).is_ok())
}

fn portable_path(relative: &str) -> bool {
    inspection::relative_path(relative)
        && (!cfg!(windows)
            || relative
                .split('/')
                .all(|part| !part.contains(':') && !part.ends_with(['.', ' '])))
}

fn directory_at(root: &Dir, relative: &str) -> Result<Dir> {
    ensure!(portable_path(relative), "Use a checkout-relative path.");
    let mut directory = root.try_clone()?;
    for part in Path::new(relative).components() {
        let Component::Normal(segment) = part else {
            bail!("Use a checkout-relative path.");
        };
        directory = directory
            .open_dir_nofollow(segment)
            .context("Directory is unavailable or is a symbolic link.")?;
    }
    Ok(directory)
}

fn parent(root: &Dir, relative: &str) -> Result<(Dir, String)> {
    ensure!(portable_path(relative), "Use a checkout-relative path.");
    let (path, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    ensure!(
        !name.is_empty()
            && matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            ),
        "Enter a file or directory name."
    );
    Ok((directory_at(root, path)?, name.to_owned()))
}

fn entry(relative: &str, metadata: &Metadata) -> Result<Value> {
    let kind = if metadata.is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    let modified = metadata
        .modified()
        .ok()
        .map(|time| {
            let time = time.into_std();
            let millis = time.duration_since(UNIX_EPOCH).map_or_else(
                |error| -error.duration().as_secs_f64() * 1000.0,
                |duration| duration.as_secs_f64() * 1000.0,
            );
            date_iso(millis)
        })
        .transpose()?;
    Ok(json!({
        "path":relative,"name":relative.rsplit('/').next().unwrap_or(relative),"kind":kind,
        "size":metadata.is_file().then(||metadata.len()),"modifiedAt":modified,
    }))
}

fn relative_name(directory: &str, name: &str) -> String {
    if directory.is_empty() {
        name.to_owned()
    } else {
        format!("{directory}/{name}")
    }
}

fn directory_list(root: &Dir, input: &inspection::DirectoryList) -> Result<Value> {
    let directory = directory_at(root, &input.path)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for (candidates, candidate) in directory.entries()?.enumerate() {
        if candidates == MAX_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }
        let candidate = candidate?;
        let name = candidate.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let path = relative_name(&input.path, name);
        if portable_path(&path) {
            let metadata = directory.symlink_metadata(name)?;
            entries.push(entry(&path, &metadata)?);
        }
    }
    let sorting = Sorting::new()?;
    entries.sort_by(|left, right| {
        (right["kind"] == "directory")
            .cmp(&(left["kind"] == "directory"))
            .then_with(|| {
                sorting.base(
                    left["name"].as_js_string().unwrap(),
                    right["name"].as_js_string().unwrap(),
                )
            })
            .then_with(|| left["name"].as_str().cmp(&right["name"].as_str()))
    });
    let binding = URL_SAFE_NO_PAD.encode(Sha256::digest(
        json!({"projectId":input.project_id,"worktreeId":input.worktree_id,
          "path":input.path,"entries":entries})
        .stringify()
        .as_bytes(),
    ));
    let offset = match &input.cursor {
        None => 0,
        Some(cursor) => {
            let bytes = URL_SAFE_NO_PAD
                .decode(cursor)
                .context("Invalid directory cursor.")?;
            let value = parse_json_text(std::str::from_utf8(&bytes)?)
                .map_err(|_| anyhow::anyhow!("Invalid directory cursor."))?;
            ensure!(
                value["binding"] == binding,
                "The directory changed. Start a new listing."
            );
            let offset = value["offset"]
                .as_u64()
                .context("Invalid directory cursor.")? as usize;
            ensure!(offset <= entries.len(), "Invalid directory cursor.");
            offset
        }
    };
    let total = entries.len();
    let page = bounded(
        entries
            .into_iter()
            .skip(offset)
            .take(usize::from(input.limit)),
    );
    let next = offset + page.len();
    let next_cursor = (next < total)
        .then(|| URL_SAFE_NO_PAD.encode(json!({"binding":binding,"offset":next}).stringify()));
    Ok(
        json!({"summary":format!("Listed {} checkout entries.", page.len()),
        "path":input.path,"entries":page,"nextCursor":next_cursor,"truncated":truncated}),
    )
}

fn file_read(root: &Dir, input: &inspection::FileRead) -> Result<Value> {
    let (directory, name) = parent(root, &input.path)?;
    let mut file = open_rooted_regular(&directory, Path::new(&name))
        .context("File is unavailable, not a regular file, or a symbolic link.")?;
    let size = file.metadata()?.len();
    ensure!(
        input.offset <= size,
        "The byte offset is beyond the end of the file."
    );
    file.seek(SeekFrom::Start(input.offset))?;
    let mut buffer = Vec::new();
    file.take(u64::from(input.max_bytes))
        .read_to_end(&mut buffer)?;
    let raw = match std::str::from_utf8(&buffer) {
        Ok(_) => buffer.as_slice(),
        Err(error)
            if error.error_len().is_none() && input.offset + (buffer.len() as u64) < size =>
        {
            &buffer[..error.valid_up_to()]
        }
        Err(_) => bail!("Use a UTF-8 text file and a byte offset on a character boundary."),
    };
    let text = decode(raw)?;
    let mut end = text.len();
    if json!(text).stringify().len() > MAX_RESULT_BYTES {
        end = text.floor_char_boundary(3000);
    }
    let text = &text[..end];
    let next = input.offset + text.len() as u64;
    Ok(
        json!({"summary":format!("Read {} bytes of UTF-8 text.",text.len()),
        "path":input.path,"text":text,"size":size,"offset":input.offset,
        "nextOffset":(next < size).then_some(next)}),
    )
}

fn file_search(root: &Dir, input: &inspection::FileSearch, scope: &Scope) -> Result<Value> {
    let sorting = Sorting::new()?;
    let query = sorting.lower(&JsString::from(input.query.trim()), false);
    let start = directory_at(root, &input.path)?;
    let mut queue = VecDeque::<String>::new();
    let mut first = Some((input.path.clone(), start));
    let mut found = Vec::new();
    let mut visited = 0;
    let mut truncated = false;
    'walk: while let Some((path, directory)) = first.take().or_else(|| {
        while let Some(path) = queue.pop_front() {
            if let Ok(directory) = directory_at(root, &path) {
                return Some((path, directory));
            }
        }
        None
    }) {
        scope.check()?;
        for candidate in directory.entries()? {
            if visited >= MAX_SEARCH_ENTRIES {
                truncated = true;
                break 'walk;
            }
            visited += 1;
            let candidate = candidate?;
            let name = candidate.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let relative = relative_name(&path, name);
            if !portable_path(&relative) {
                continue;
            }
            let kind = candidate.file_type()?;
            if kind.is_dir() {
                queue.push_back(relative);
            } else if kind.is_file() {
                let relative_string = JsString::from(relative.as_str());
                if let Some(rank) = score(&relative_string, false, &query, &sorting) {
                    found.push((rank, relative_string, relative));
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| sorting.compare(&a.1, &b.1)));
    let count = found.len();
    let entries = bounded(
        found
            .into_iter()
            .take(usize::from(input.limit))
            .map(|record| json!({"path":record.2})),
    );
    Ok(
        json!({"summary":format!("Found {} matching paths.",entries.len()),
        "path":input.path,"entries":entries,"truncated":truncated || count > entries.len()}),
    )
}

fn bounded(entries: impl Iterator<Item = Value>) -> Vec<Value> {
    let mut used = 0;
    entries
        .take_while(|entry| {
            used += entry.stringify().len() + 1;
            used <= MAX_RESULT_BYTES
        })
        .collect()
}
