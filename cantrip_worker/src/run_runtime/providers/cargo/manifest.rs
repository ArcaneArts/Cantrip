use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository::read_regular},
};
use anyhow::Result;
use cantrip_wire::JsString;
use icu_collator::CollatorBorrowed;
use indexmap::{IndexMap, IndexSet};
use std::{
    collections::{HashSet, VecDeque},
    fs, io,
    path::{Path, PathBuf},
};
use toml::{Table, Value as Toml};

const DIRECTORIES: usize = 1024;
const MANIFESTS: usize = 256;
const TARGETS: usize = 1024;
const DEPTH: usize = 10;
const MANIFEST_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) enum Kind {
    Binary,
    Example,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Binary => "binary",
            Self::Example => "example",
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Binary => "bin",
            Self::Example => "example",
        }
    }

    fn parent(self) -> &'static str {
        match self {
            Self::Binary => "src/bin",
            Self::Example => "examples",
        }
    }
}

pub(super) struct Target {
    pub kind: Kind,
    pub name: String,
    pub features: Vec<String>,
    pub source: String,
}

pub(super) struct Package {
    pub name: String,
    pub default: Option<String>,
    pub directory: JsString,
    pub targets: Vec<Target>,
}

struct Directory {
    absolute: PathBuf,
    relative: JsString,
    depth: usize,
}

pub(super) fn scan(root: &Path, scope: &Scope) -> Result<Vec<Package>> {
    let collator = collator()?;
    let mut queue = VecDeque::from([Directory {
        absolute: root.to_owned(),
        relative: ".".into(),
        depth: 0,
    }]);
    let mut packages = Vec::new();
    let mut visited = 0;
    let mut manifests = 0;
    let mut targets = 0;
    while manifests < MANIFESTS && targets < TARGETS {
        scope.check()?;
        let Some(current) = queue.pop_front() else {
            break;
        };
        visited += 1;
        let Ok(canonical) = paths::canonical_sync(&current.absolute) else {
            continue;
        };
        if !inside(root, &canonical)
            || !fs::symlink_metadata(&current.absolute).is_ok_and(|metadata| metadata.is_dir())
        {
            continue;
        }
        if let Some(package) = read_package(root, &canonical, &current.relative, &collator)? {
            manifests += 1;
            targets += package.targets.len();
            if !package.targets.is_empty() {
                packages.push(package);
            }
        }
        if current.depth >= DEPTH || visited + queue.len() >= DIRECTORIES {
            continue;
        }
        let Ok(entries) = fs::read_dir(&canonical) else {
            continue;
        };
        let mut children = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = paths::text(Path::new(&entry.file_name()));
                if matches!(
                    name.as_str(),
                    Some(
                        ".cantrip"
                            | ".cargo-cache"
                            | ".git"
                            | ".idea"
                            | ".vscode"
                            | "build"
                            | "coverage"
                            | "dist"
                            | "node_modules"
                            | "out"
                            | "target"
                            | "vendor"
                    )
                ) || !entry.file_type().ok()?.is_dir()
                {
                    return None;
                }
                Some((entry.path(), name))
            })
            .collect::<Vec<_>>();
        children
            .sort_by(|(_, left), (_, right)| collator.compare_utf16(left.units(), right.units()));
        let remaining = DIRECTORIES - visited - queue.len();
        for (absolute, child) in children.into_iter().take(remaining) {
            let relative = if current.depth == 0 {
                child
            } else {
                JsString::new(
                    current
                        .relative
                        .units()
                        .iter()
                        .copied()
                        .chain([u16::from(b'/')])
                        .chain(child.units().iter().copied())
                        .collect(),
                )
            };
            queue.push_back(Directory {
                absolute,
                relative,
                depth: current.depth + 1,
            });
        }
    }
    packages.sort_by(|left, right| {
        collator
            .compare_utf16(left.directory.units(), right.directory.units())
            .then_with(|| collator.compare(&left.name, &right.name))
    });
    Ok(packages)
}

fn read_package(
    root: &Path,
    directory: &Path,
    relative: &JsString,
    collator: &CollatorBorrowed<'_>,
) -> Result<Option<Package>> {
    let path = directory.join("Cargo.toml");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > MANIFEST_BYTES {
        return Ok(None);
    }
    let bytes = match read_regular(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if bytes.contains(&0) {
        return Ok(None);
    }
    let Ok(manifest) = String::from_utf8_lossy(&bytes).parse::<Table>() else {
        return Ok(None);
    };
    let Some(package) = manifest.get("package").and_then(Toml::as_table) else {
        return Ok(None);
    };
    let Some(name) = string(package, "name").and_then(|name| valid_name(name, false)) else {
        return Ok(None);
    };
    let targets = package_targets(root, directory, &manifest, package, name, collator)?;
    Ok(Some(Package {
        name: name.to_owned(),
        default: string(package, "default-run")
            .and_then(|value| valid_name(value, true))
            .map(str::to_owned),
        directory: relative.clone(),
        targets,
    }))
}

fn package_targets(
    root: &Path,
    directory: &Path,
    manifest: &Table,
    package: &Table,
    name: &str,
    collator: &CollatorBorrowed<'_>,
) -> Result<Vec<Target>> {
    let mut targets = IndexMap::new();
    let mut claimed = HashSet::new();
    for kind in [Kind::Binary, Kind::Example] {
        let tables = manifest.get(kind.table()).and_then(Toml::as_array);
        for table in tables
            .into_iter()
            .flatten()
            .filter_map(Toml::as_table)
            .take(256)
        {
            let Some(target_name) = string(table, "name").and_then(|value| valid_name(value, true))
            else {
                continue;
            };
            let candidates =
                if let Some(configured) = string(table, "path").filter(|path| !path.is_empty()) {
                    vec![configured.to_owned()]
                } else {
                    let mut paths = Vec::new();
                    if kind == Kind::Binary && target_name == name {
                        paths.push("src/main.rs".into());
                    }
                    paths.push(format!("{}/{target_name}.rs", kind.parent()));
                    paths.push(format!("{}/{target_name}/main.rs", kind.parent()));
                    paths
                };
            for source in candidates {
                if portable_source(&source) && regular(root, &directory.join(&source))? {
                    claimed.insert(source.clone());
                    targets.insert(
                        (kind, target_name.to_owned()),
                        Target {
                            kind,
                            name: target_name.to_owned(),
                            source,
                            features: required_features(table),
                        },
                    );
                    break;
                }
            }
        }
    }
    let mut add = |target: Target| {
        let key = (target.kind, target.name.clone());
        if !targets.contains_key(&key) && claimed.insert(target.source.clone()) {
            targets.insert(key, target);
        }
    };
    for (kind, option) in [(Kind::Binary, "autobins"), (Kind::Example, "autoexamples")] {
        if package.get(option).and_then(Toml::as_bool) == Some(false) {
            continue;
        }
        if kind == Kind::Binary && regular(root, &directory.join("src/main.rs"))? {
            add(Target {
                kind,
                name: name.to_owned(),
                source: "src/main.rs".into(),
                features: vec![],
            });
        }
        for target in conventional(root, directory, kind, collator)? {
            add(target);
        }
    }
    let mut targets = targets.into_values().collect::<Vec<_>>();
    targets.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| collator.compare(&left.name, &right.name))
    });
    Ok(targets)
}

fn conventional(
    root: &Path,
    directory: &Path,
    kind: Kind,
    collator: &CollatorBorrowed<'_>,
) -> Result<Vec<Target>> {
    let entries = match fs::read_dir(directory.join(kind.parent())) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let mut entries = entries
        .map(|entry| {
            let entry = entry?;
            Ok((paths::text(Path::new(&entry.file_name())), entry))
        })
        .collect::<io::Result<Vec<_>>>()?;
    entries.sort_by(|(left, _), (right, _)| collator.compare_utf16(left.units(), right.units()));
    let mut targets = Vec::new();
    for (name, entry) in entries.into_iter().take(256) {
        let Some(name) = name.as_str() else { continue };
        let kind_on_disk = entry.file_type()?;
        let (candidate, source) = if kind_on_disk.is_file() {
            let Some(candidate) = name.strip_suffix(".rs") else {
                continue;
            };
            (candidate, format!("{}/{name}", kind.parent()))
        } else if kind_on_disk.is_dir() {
            (name, format!("{}/{name}/main.rs", kind.parent()))
        } else {
            continue;
        };
        if let Some(name) = valid_name(candidate, true)
            && regular(root, &directory.join(&source))?
        {
            targets.push(Target {
                kind,
                name: name.to_owned(),
                source,
                features: vec![],
            });
        }
    }
    Ok(targets)
}

fn string<'a>(table: &'a Table, key: &str) -> Option<&'a str> {
    table.get(key).and_then(Toml::as_str)
}

fn valid_name(value: &str, target: bool) -> Option<&str> {
    let value = cantrip_wire::text::trim(value);
    (!value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') || (target && byte == b'.')
        }))
    .then_some(value)
}

fn required_features(table: &Table) -> Vec<String> {
    table
        .get("required-features")
        .and_then(Toml::as_array)
        .into_iter()
        .flatten()
        .filter_map(Toml::as_str)
        .filter(|feature| {
            !feature.is_empty()
                && feature.len() <= 256
                && feature
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_+.-".contains(&byte))
        })
        .take(128)
        .map(str::to_owned)
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect()
}

fn portable_source(path: &str) -> bool {
    path.ends_with(".rs")
        && path.encode_utf16().count() <= 512
        && !path.contains(['\0', '\\'])
        && !(path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn inside(root: &Path, path: &Path) -> bool {
    paths::within(root, path)
        && !paths::relative(root, path)
            .units()
            .starts_with(&[u16::from(b'.'), u16::from(b'.')])
}

fn regular(root: &Path, path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Ok(false);
    }
    match paths::canonical_sync(path) {
        Ok(canonical) => Ok(inside(root, &canonical)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
