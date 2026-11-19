use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository::read_regular},
};
use anyhow::Result;
use regex::{Captures, Regex};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

const MAX_DIRECTORIES: usize = 1_024;
const MAX_DEPTH: usize = 10;
const MAX_PACKAGES: usize = 256;
const MAX_SOURCES: usize = 512;

fn js_whitespace_pattern(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(
        r"\s",
        r"[\u0009-\u000D \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]",
    ))
    .expect("valid Dart discovery pattern")
}

pub(super) struct Pubspec {
    pub name: Option<String>,
    pub flutter: bool,
}

pub(super) fn read_pubspec(path: &Path) -> Option<Pubspec> {
    static NAME: LazyLock<Regex> = LazyLock::new(|| {
        js_whitespace_pattern(
            r#"(?m)^(?:\uFEFF)?name\s*:\s*(?:"([a-z_][a-z0-9_]*)"|'([a-z_][a-z0-9_]*)'|([a-z_][a-z0-9_]*))\s*(?:#.*)?$"#,
        )
    });
    static FLUTTER: LazyLock<Regex> =
        LazyLock::new(|| js_whitespace_pattern(r"(?m)^[ \t]+sdk\s*:\s*flutter\s*(?:#.*)?$"));
    let pubspec = read_text(path)?.replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let name = NAME
        .captures(&pubspec)
        .and_then(|found| (1..=3).find_map(|index| found.get(index)))
        .map(|matched| matched.as_str().to_owned());
    Some(Pubspec {
        name,
        flutter: FLUTTER.is_match(&pubspec),
    })
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = read_regular(path).ok()?;
    (!bytes.contains(&0)).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn has_main(source: &str) -> bool {
    static COMMENTS_AND_STRINGS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?s)/\*.*?\*/|//[^\r\n]*|[rR]?'''.*?'''|[rR]?""".*?"""|[rR]?'(?:\\[^\r\n\u{2028}\u{2029}]|[^'\\\r\n])*'|[rR]?"(?:\\[^\r\n\u{2028}\u{2029}]|[^"\\\r\n])*""#,
        )
        .expect("valid Dart comment and string pattern")
    });
    static DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
        js_whitespace_pattern(
            r"^\s*(?:@[^\r\n]+\s*)*(?:(?:Future(?:Or)?\s*<\s*void\s*>|void|dynamic)\s+)?main\s*\(",
        )
    });
    let scrubbed = COMMENTS_AND_STRINGS.replace_all(source, |captures: &Captures<'_>| {
        captures[0]
            .chars()
            .map(|character| match character {
                '\n' | '\r' => character,
                _ => ' ',
            })
            .collect::<String>()
    });
    let mut depth = 0usize;
    for line in scrubbed.split('\n') {
        if depth == 0 && DECLARATION.is_match(line) {
            return true;
        }
        for character in line.bytes() {
            match character {
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    false
}

struct Directory {
    absolute: PathBuf,
    relative: String,
    depth: usize,
}

pub(super) struct Package {
    pub directory: String,
    pub name: String,
    pub entrypoints: Vec<String>,
}

pub(super) fn scan(root: &Path, scope: &Scope) -> Result<Vec<Package>> {
    let collator = collator()?;
    let mut queue = VecDeque::from([Directory {
        absolute: root.to_owned(),
        relative: ".".into(),
        depth: 0,
    }]);
    let mut pubspecs = Vec::new();
    let mut sources = Vec::new();
    let mut visited = 0;
    while let Some(current) = queue.pop_front() {
        scope.check()?;
        visited += 1;
        let Ok(canonical) = paths::canonical_sync(&current.absolute) else {
            continue;
        };
        if !paths::within(root, &canonical) || !paths::equal(&canonical, &current.absolute) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&canonical) else {
            continue;
        };
        let mut entries = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let kind = entry.file_type().ok()?;
                let name = entry.file_name().to_string_lossy().into_owned();
                Some((entry.path(), kind, name))
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(_, _, left), (_, _, right)| collator.compare(left, right));
        for (path, kind, name) in entries {
            scope.check()?;
            if kind.is_file() {
                if name == "pubspec.yaml"
                    && pubspecs.len() < MAX_PACKAGES
                    && let Some(pubspec) = read_pubspec(&path)
                {
                    pubspecs.push((current.relative.clone(), pubspec));
                }
                if name.ends_with(".dart")
                    && sources.len() < MAX_SOURCES
                    && read_text(&path).is_some_and(|source| has_main(&source))
                {
                    sources.push(portable_join(&current.relative, &name));
                }
            } else if kind.is_dir()
                && current.depth < MAX_DEPTH
                && visited + queue.len() < MAX_DIRECTORIES
                && !ignored(&name)
            {
                queue.push_back(Directory {
                    absolute: path,
                    relative: portable_join(&current.relative, &name),
                    depth: current.depth + 1,
                });
            }
        }
    }

    let mut packages = Vec::new();
    for (directory, pubspec) in &pubspecs {
        scope.check()?;
        if pubspec.flutter {
            continue;
        }
        let Some(name) = &pubspec.name else {
            continue;
        };
        let nested = pubspecs
            .iter()
            .map(|(child, _)| child)
            .filter(|child| *child != directory && beneath(child, directory).is_some())
            .collect::<Vec<_>>();
        let mut entrypoints = sources
            .iter()
            .filter_map(|source| {
                let relative = beneath(source, directory)?;
                let first = relative.split('/').next()?;
                (!matches!(first, "test" | "integration_test")
                    && !nested.iter().any(|child| beneath(source, child).is_some()))
                .then(|| relative.to_owned())
            })
            .collect::<Vec<_>>();
        entrypoints.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        packages.push(Package {
            directory: directory.clone(),
            name: name.clone(),
            entrypoints,
        });
    }
    Ok(packages)
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".cantrip"
            | ".dart_tool"
            | ".git"
            | ".idea"
            | ".pub-cache"
            | "build"
            | "coverage"
            | "node_modules"
            | "target"
    )
}

fn beneath<'a>(path: &'a str, directory: &str) -> Option<&'a str> {
    if directory == "." {
        Some(path)
    } else {
        path.strip_prefix(directory)?.strip_prefix('/')
    }
}

pub(super) fn portable_join(parent: &str, child: &str) -> String {
    if parent == "." {
        child.to_owned()
    } else {
        format!("{parent}/{child}")
    }
}

#[cfg(test)]
mod tests {
    use super::has_main;

    #[test]
    fn run_dart_discovery_ignores_nested_code_and_strings() {
        assert!(!has_main(
            "/* void main() {} */\nclass Demo {\n void main() {}\n}\nfinal x = r'''\nmain() {}\n''';"
        ));
        assert!(has_main(
            "final x = 'unbalanced { and \\'quote';\r\n@pragma('vm:entry-point') FutureOr<void> main() async {}"
        ));
    }
}
