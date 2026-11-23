use super::collator;
use crate::filesystem::{Scope, paths};
use anyhow::Result;
use cantrip_protocol::parse;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 20_000;
const MAX_RESULTS: usize = 100;
const MAX_DEPTH: usize = 16;

struct Directory {
    absolute: PathBuf,
    relative: JsString,
    depth: usize,
}

struct Suggestion {
    value: Value,
    rank: (usize, usize),
    normalized: JsString,
}

pub(super) fn paths(root: &Path, purpose: &str, query: &JsString, scope: &Scope) -> Result<Value> {
    let query = JsString::new(
        query
            .trim()
            .units()
            .iter()
            .map(|&unit| if unit == 92 { 47 } else { unit })
            .collect(),
    )
    .lowercase();
    let collator = collator()?;
    let mut suggestions = Vec::new();
    let mut queue = VecDeque::from([Directory {
        absolute: root.to_owned(),
        relative: ".".into(),
        depth: 0,
    }]);
    let mut scanned = 0;
    let mut truncated = false;
    if purpose == "directory" {
        suggest(&mut suggestions, ".".into(), "directory", &query)?;
    }

    'scan: while let Some(dir) = queue.pop_front() {
        scope.check()?;
        let children = fs::read_dir(&dir.absolute)
            .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>());
        let Ok(children) = children else { continue };
        let mut entries = children
            .into_iter()
            .map(|entry| (paths::text(Path::new(&entry.file_name())), entry))
            .collect::<Vec<_>>();
        entries
            .sort_by(|(left, _), (right, _)| collator.compare_utf16(left.units(), right.units()));
        for (name, entry) in entries {
            scope.check()?;
            scanned += 1;
            if scanned > MAX_ENTRIES {
                truncated = true;
                break 'scan;
            }
            let absolute = entry.path();
            let validated = || {
                if entry.file_type().ok()?.is_symlink() {
                    return None;
                }
                let metadata = fs::symlink_metadata(&absolute).ok()?;
                if metadata.file_type().is_symlink() {
                    return None;
                }
                let canonical = paths::canonical_sync(&absolute).ok()?;
                (paths::within(root, &canonical)
                    && !paths::relative(root, &canonical)
                        .units()
                        .starts_with(&[46, 46]))
                .then_some((metadata, canonical))
            };
            let Some((metadata, canonical)) = validated() else {
                continue;
            };
            let relative = if dir.relative == JsString::from(".") {
                name.clone()
            } else {
                JsString::new(
                    dir.relative
                        .units()
                        .iter()
                        .copied()
                        .chain([47])
                        .chain(name.units().iter().copied())
                        .collect(),
                )
            };
            if metadata.is_dir() {
                if matches!(
                    name.lowercase().as_str(),
                    Some(
                        ".dart_tool"
                            | ".git"
                            | ".gradle"
                            | ".next"
                            | ".turbo"
                            | "build"
                            | "coverage"
                            | "dist"
                            | "node_modules"
                            | "target"
                    )
                ) {
                    continue;
                }
                if purpose == "directory" {
                    suggest(&mut suggestions, relative.clone(), "directory", &query)?;
                }
                if dir.depth >= MAX_DEPTH {
                    truncated = true;
                } else {
                    queue.push_back(Directory {
                        absolute: canonical,
                        depth: dir.depth + 1,
                        relative,
                    });
                }
            } else if metadata.is_file() && matches_file(purpose, &name, &metadata) {
                suggest(&mut suggestions, relative, "file", &query)?;
            }
            if query.units().is_empty() && suggestions.len() > MAX_RESULTS {
                truncated = true;
                break 'scan;
            }
        }
    }
    suggestions.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| collator.compare_utf16(left.normalized.units(), right.normalized.units()))
    });
    Ok(
        json!({"truncated":truncated || suggestions.len() > MAX_RESULTS,
        "suggestions":suggestions.into_iter().take(MAX_RESULTS).map(|entry| entry.value).collect::<Vec<_>>() }),
    )
}

fn matches_file(purpose: &str, name: &JsString, metadata: &fs::Metadata) -> bool {
    match purpose {
        "file" => true,
        "environment-file" => {
            let lower = name.lowercase();
            let name = lower.units();
            name == [46, 101, 110, 118]
                || name.starts_with(&[46, 101, 110, 118, 46])
                || name.ends_with(&[46, 101, 110, 118])
        }
        "shell-script" => {
            let lower = name.lowercase();
            let units = lower.units();
            let suffix = units
                .iter()
                .rposition(|&unit| unit == 46)
                .filter(|&dot| dot > 0)
                .map(|dot| String::from_utf16_lossy(&units[dot + 1..]));
            matches!(
                suffix.as_deref(),
                Some("bash" | "bat" | "cmd" | "fish" | "ps1" | "sh" | "zsh")
            ) || executable(metadata)
        }
        _ => false,
    }
}

fn executable(_metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    false
}

fn suggest(
    suggestions: &mut Vec<Suggestion>,
    relative: JsString,
    kind: &str,
    query: &JsString,
) -> Result<()> {
    let normalized = relative.lowercase();
    let text = normalized.units();
    let query = query.units();
    if !query.is_empty() && !text.windows(query.len()).any(|window| window == query) {
        return Ok(());
    }
    let value = json!({"kind":kind,"path":relative});
    let value = match parse("runConfigurationPathSuggestionSchema", Some(&value)) {
        Ok(value) => value,
        Err(cantrip_protocol::ValidationError::Invalid(_)) => return Ok(()),
        Err(cantrip_protocol::ValidationError::Operation) => {
            anyhow::bail!("Run configuration path contract unavailable.")
        }
    };
    let depth = if text == [46] {
        0
    } else {
        text.split(|&unit| unit == 47).count()
    };
    let basename = text.rsplit(|&unit| unit == 47).next().unwrap_or(text);
    let rank = if query.is_empty() {
        (depth, usize::from(kind != "directory"))
    } else if text == query {
        (0, depth)
    } else if basename == query {
        (1, depth)
    } else if basename.starts_with(query) {
        (2, depth)
    } else if text.starts_with(query) {
        (3, depth)
    } else {
        (4, depth)
    };
    suggestions.push(Suggestion {
        value,
        rank,
        normalized,
    });
    Ok(())
}
