use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository::read_regular},
};
use anyhow::Result;
use cantrip_wire::{JsString, coercion, parse_json_text};
use indexmap::IndexSet;
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
};

const MAX_DIRECTORIES: usize = 512;
const MAX_MANIFESTS: usize = 128;
const MAX_DEPTH: usize = 6;

pub(super) struct Manifest {
    pub entries: IndexSet<JsString>,
    pub scripts: IndexSet<JsString>,
    pub name: Option<JsString>,
    declared_manager: Option<JsString>,
}

impl Manifest {
    pub fn open(directory: &Path) -> std::result::Result<Self, String> {
        let path = directory.join("package.json");
        let metadata = fs::symlink_metadata(&path).map_err(|cause| {
            if cause.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "ENOENT: no such file or directory, lstat '{}'",
                    path.display()
                )
            } else {
                cause.to_string()
            }
        })?;
        if !metadata.is_file() {
            return Err("package.json must be a real file.".into());
        }
        if metadata.len() > 512 * 1024 {
            return Err("package.json exceeds the discovery size limit.".into());
        }
        let bytes = read_regular(&path).map_err(|cause| cause.to_string())?;
        let value = parse_json_text(&String::from_utf8_lossy(&bytes))
            .map_err(|cause| cause.lossy().into_owned())?;
        if !value.is_object() {
            return Err("package.json must contain a JSON object.".into());
        }
        let mut entries = IndexSet::new();
        for candidate in [&value["main"], &value["module"], &value["bin"]] {
            if let Some(value) = candidate.as_js_string().and_then(portable_entry) {
                entries.insert(value);
            }
        }
        if let Some(bins) = value["bin"].as_object() {
            for (_, value) in coercion::entries(bins) {
                if let Some(value) = value.as_js_string().and_then(portable_entry) {
                    entries.insert(value);
                }
            }
        }
        entries.truncate(32);
        let scripts = value["scripts"]
            .as_object()
            .into_iter()
            .flat_map(coercion::entries)
            .filter(|(name, script)| {
                name.units().len() <= 200
                    && !name.trim().units().is_empty()
                    && script
                        .as_js_string()
                        .is_some_and(|text| !text.trim().units().is_empty())
            })
            .map(|(name, _)| name.clone())
            .take(64)
            .collect();
        let name = value["name"]
            .as_js_string()
            .map(JsString::trim)
            .filter(|name| !name.units().is_empty())
            .map(|name| JsString::new(name.units().iter().copied().take(200).collect()));
        Ok(Self {
            entries,
            scripts,
            name,
            declared_manager: value["packageManager"].as_js_string().cloned(),
        })
    }

    pub fn package_manager(&self, root: &Path, package: &Path) -> &'static str {
        match self
            .declared_manager
            .as_ref()
            .and_then(JsString::as_str)
            .and_then(|value| value.split('@').next())
        {
            Some("npm") => return "npm",
            Some("pnpm") => return "pnpm",
            Some("yarn") => return "yarn",
            Some("bun") => return "bun",
            _ => {}
        }
        for directory in [package, root] {
            for (name, manager) in [
                ("pnpm-lock.yaml", "pnpm"),
                ("yarn.lock", "yarn"),
                ("bun.lock", "bun"),
                ("bun.lockb", "bun"),
                ("package-lock.json", "npm"),
            ] {
                if real_file(&directory.join(name)) {
                    return manager;
                }
            }
            if package == root {
                break;
            }
        }
        "npm"
    }
}

pub(super) fn real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn portable_entry(value: &JsString) -> Option<JsString> {
    let units = value.units();
    let units = units
        .strip_prefix(&[b'.' as u16, b'/' as u16])
        .unwrap_or(units);
    let drive = units.get(1) == Some(&(b':' as u16))
        && units.first().is_some_and(|unit| {
            u8::try_from(*unit).is_ok_and(|letter| letter.is_ascii_alphabetic())
        });
    let slash = b'/' as u16;
    let dot = b'.' as u16;
    if drive
        || units.contains(&(b'\\' as u16))
        || units
            .split(|unit| *unit == slash)
            .any(|part| part.is_empty() || part == [dot] || part == [dot, dot])
    {
        return None;
    }
    Some(JsString::new(units.to_vec()))
}

pub(super) struct Package {
    pub absolute: PathBuf,
    pub relative: JsString,
    pub manifest: Manifest,
}

pub(super) fn discover(root: &Path, scope: &Scope) -> Result<Vec<Package>> {
    let collator = collator()?;
    let mut queue = VecDeque::from([(root.to_owned(), JsString::from("."), 0)]);
    let mut manifests = Vec::new();
    let mut visited = 0;
    while let Some((directory, relative, depth)) = queue.pop_front() {
        scope.check()?;
        visited += 1;
        let Ok(canonical) = paths::canonical_sync(&directory) else {
            continue;
        };
        if !paths::within(root, &canonical)
            || !fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.is_dir())
        {
            continue;
        }
        let Ok(entries) = fs::read_dir(&canonical)
            .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>())
        else {
            continue;
        };
        if entries.iter().any(|entry| {
            entry.file_name() == "package.json"
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        }) && let Ok(manifest) = Manifest::open(&canonical)
        {
            manifests.push(Package {
                absolute: canonical,
                relative: relative.clone(),
                manifest,
            });
            if manifests.len() == MAX_MANIFESTS {
                break;
            }
        }
        if depth >= MAX_DEPTH || visited + queue.len() >= MAX_DIRECTORIES {
            continue;
        }
        let mut children = entries
            .into_iter()
            .filter_map(|entry| {
                let name = paths::text(Path::new(&entry.file_name()));
                if matches!(
                    name.as_str(),
                    Some(
                        ".cantrip"
                            | ".git"
                            | ".gradle"
                            | ".idea"
                            | ".next"
                            | ".turbo"
                            | ".yarn"
                            | "build"
                            | "coverage"
                            | "dist"
                            | "node_modules"
                            | "target"
                    )
                ) || !entry.file_type().is_ok_and(|kind| kind.is_dir())
                {
                    return None;
                }
                Some((entry.path(), name))
            })
            .collect::<Vec<_>>();
        children.sort_by(|(_, a), (_, b)| collator.compare_utf16(a.units(), b.units()));
        let available = MAX_DIRECTORIES - visited - queue.len();
        for (absolute, child) in children.into_iter().take(available) {
            queue.push_back((absolute, join(&relative, &child), depth + 1));
        }
    }
    Ok(manifests)
}

pub(super) fn join(directory: &JsString, name: &JsString) -> JsString {
    if directory.as_str() == Some(".") {
        name.clone()
    } else {
        JsString::new(
            directory
                .units()
                .iter()
                .copied()
                .chain([b'/' as u16])
                .chain(name.units().iter().copied())
                .collect(),
        )
    }
}
