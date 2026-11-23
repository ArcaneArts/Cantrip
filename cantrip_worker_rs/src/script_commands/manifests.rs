use crate::filesystem::{Scope, paths};
use anyhow::Result;
use cantrip_wire::{
    JsString, Value, parse_json_text,
    text::{trim, whitespace},
    value::json,
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::LazyLock,
};

const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
const MAX_COMMANDS: usize = 500;
const MAX_COMMAND_LENGTH: usize = 4096;

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
enum Kind {
    Package,
    Dart,
    Just,
    Cargo,
    Gradle,
    Make,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Package => "package",
            Self::Dart => "dart",
            Self::Just => "just",
            Self::Cargo => "cargo",
            Self::Gradle => "gradle",
            Self::Make => "make",
        }
    }
}

struct Script {
    kind: Kind,
    name: JsString,
    command: JsString,
    source: String,
    description: Option<JsString>,
}

#[derive(Default)]
struct Scripts {
    source: Vec<Script>,
    commands: IndexSet<JsString>,
}

fn safe_name(name: &str) -> bool {
    name.len() <= 200
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":_.-".contains(&byte))
}

fn control(unit: u16) -> bool {
    matches!(unit, 0..=31 | 127)
}

fn compact(description: &JsString) -> Option<JsString> {
    let mut output = Vec::new();
    let mut space = false;
    for &unit in description.units() {
        if char::from_u32(u32::from(unit)).is_some_and(whitespace) {
            space = !output.is_empty();
            continue;
        }
        if space {
            output.push(b' ' as u16);
            space = false;
        }
        output.push(unit);
        if output.len() >= MAX_COMMAND_LENGTH {
            output.truncate(MAX_COMMAND_LENGTH);
            break;
        }
    }
    (!output.is_empty() && !output.iter().copied().any(control)).then(|| JsString::new(output))
}

impl Scripts {
    fn add(
        &mut self,
        kind: Kind,
        name: &str,
        command: JsString,
        source: &str,
        description: Option<JsString>,
    ) {
        let name = trim(name);
        let command = command.trim();
        if !safe_name(name)
            || command.units().is_empty()
            || command.units().len() > MAX_COMMAND_LENGTH
            || command.units().iter().copied().any(control)
            || !self.commands.insert(command.clone())
        {
            return;
        }
        self.source.push(Script {
            kind,
            name: name.into(),
            command,
            source: source.to_owned(),
            description: description.as_ref().and_then(compact),
        });
    }

    fn output(mut self) -> Result<Value> {
        let collator = crate::run_definitions::collator()?;
        self.source.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| collator.compare_utf16_icu4c(left.name.units(), right.name.units()))
                .then_with(|| {
                    collator.compare_utf16_icu4c(left.command.units(), right.command.units())
                })
        });
        Ok(Value::Array(
            self.source
                .into_iter()
                .take(MAX_COMMANDS)
                .map(|item| {
                    let kind = item.kind.name();
                    let id = format!("{kind}:{}:{}", item.source, item.name.lossy());
                    json!({"id":id,"kind":kind,"name":item.name,"command":item.command,
                "description":item.description,"source":item.source})
                })
                .collect(),
        ))
    }
}

struct Project {
    path: PathBuf,
    root: Dir,
}

impl Project {
    fn open(path: &Path) -> Option<Self> {
        let path = paths::canonical_sync(path).ok()?;
        let root = Dir::open_ambient_dir(&path, ambient_authority()).ok()?;
        Some(Self { path, root })
    }

    fn relative(&self, source: &str) -> Option<PathBuf> {
        let target = paths::canonical_sync(&self.path.join(source)).ok()?;
        let path = target.strip_prefix(&self.path).ok()?;
        (!path.as_os_str().is_empty()).then(|| path.to_owned())
    }

    fn exists(&self, source: &str) -> bool {
        self.relative(source)
            .and_then(|path| self.root.metadata(path).ok())
            .is_some_and(|metadata| metadata.is_file())
    }

    fn read(&self, source: &str) -> Option<String> {
        let path = self.relative(source)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = self.root.open_with(path, &options).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() as u64 <= MAX_MANIFEST_BYTES)
            .then(|| String::from_utf8_lossy(&bytes).into_owned())
    }

    fn first_nonempty<'a>(&self, sources: &[&'a str]) -> Option<(&'a str, String)> {
        sources.iter().find_map(|&source| {
            self.read(source)
                .filter(|text| !text.is_empty())
                .map(|text| (source, text))
        })
    }
}

pub(super) fn discover(cwd: &Path, windows: bool, scope: &Scope) -> Result<Value> {
    let Some(project) = Project::open(cwd) else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut result = Scripts::default();
    scope.check()?;
    package(&project, &mut result);
    if let Some(text) = project.read("pubspec.yaml") {
        pubspec(&text, &mut result);
    }
    if let Some((source, text)) = project.first_nonempty(&["justfile", "Justfile", ".justfile"]) {
        just(&text, source, &mut result);
    }
    scope.check()?;
    cargo(&project, &mut result);
    gradle(&project, windows, &mut result);
    if let Some((source, text)) = project.first_nonempty(&["GNUmakefile", "Makefile", "makefile"]) {
        make(&text, source, &mut result);
    }
    scope.check()?;
    result.output()
}

fn package(project: &Project, result: &mut Scripts) {
    let source = "package.json";
    let Some(manifest) = project
        .read(source)
        .and_then(|text| parse_json_text(&text).ok())
    else {
        return;
    };
    let Some(scripts) = manifest["scripts"].as_object() else {
        return;
    };
    let declared = manifest["packageManager"]
        .as_str()
        .and_then(|value| value.split_once('@'));
    let runner = match declared.map(|(name, _)| name) {
        Some(name @ ("bun" | "npm" | "pnpm" | "yarn")) => name,
        _ if project.exists("pnpm-lock.yaml") => "pnpm",
        _ if project.exists("yarn.lock") => "yarn",
        _ if project.exists("bun.lock") || project.exists("bun.lockb") => "bun",
        _ => "npm",
    };
    for (name, description) in scripts {
        if let Some(description) = description.as_js_string() {
            let name = name.lossy();
            result.add(
                Kind::Package,
                &name,
                format!("{runner} run {name}").into(),
                source,
                Some(description.clone()),
            );
        }
    }
}

static PUBSPEC_SECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^scripts\s*:\s*(?:#.*)?$").unwrap());
static PUBSPEC_ENTRY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9][A-Za-z0-9:_.-]{0,199})\s*:\s*(.*)$").unwrap());
static PUBSPEC_NESTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(run|command|description)\s*:\s*(.*)$").unwrap());

fn yaml_scalar(value: &str) -> Option<JsString> {
    let mut single = false;
    let mut double = false;
    let mut previous = ' ';
    let mut end = value.len();
    for (index, character) in value.char_indices() {
        match character {
            '\'' if !double => single = !single,
            '"' if !single && previous != '\\' => double = !double,
            '#' if !single && !double && whitespace(previous) => {
                end = index;
                break;
            }
            _ => {}
        }
        previous = character;
    }
    let value = trim(&value[..end]);
    if matches!(value, "" | "|" | ">" | "null" | "~") {
        return None;
    }
    if let Some(quoted) = value
        .strip_prefix('\'')
        .and_then(|open| open.strip_suffix('\''))
    {
        return Some(quoted.replace("''", "'").into());
    }
    if value.starts_with('"') && value.ends_with('"') {
        return parse_json_text(value).ok()?.as_js_string().cloned();
    }
    (!value.starts_with(['{', '['])).then(|| value.into())
}

#[derive(Default)]
struct PubspecEntry {
    command: Option<JsString>,
    description: Option<JsString>,
}

fn pubspec(text: &str, result: &mut Scripts) {
    let mut lines = text.lines();
    if !lines.any(|line| PUBSPEC_SECTION.is_match(line)) {
        return;
    }
    let mut values = IndexMap::<&str, PubspecEntry>::new();
    let mut entry_indent = None;
    let mut name = None;
    for line in lines {
        if trim(line).is_empty() || line.trim_start_matches(whitespace).starts_with('#') {
            continue;
        }
        let body = line.trim_start_matches(' ');
        let indent = line.len() - body.len();
        if indent == 0 {
            break;
        }
        let base = *entry_indent.get_or_insert(indent);
        if indent == base {
            name = PUBSPEC_ENTRY.captures(body).map(|entry| {
                let name = entry.get(1).unwrap().as_str();
                values.insert(
                    name,
                    PubspecEntry {
                        command: yaml_scalar(&entry[2]),
                        description: None,
                    },
                );
                name
            });
        } else if indent > base
            && let Some(name) = name
            && let Some(fields) = PUBSPEC_NESTED.captures(body)
            && let Some(value) = yaml_scalar(&fields[2])
        {
            let entry = &mut values[name];
            if &fields[1] == "description" {
                entry.description = Some(value);
            } else {
                entry.command = Some(value);
            }
        }
    }
    for (name, entry) in values {
        if let Some(command) = entry.command {
            result.add(Kind::Dart, name, command, "pubspec.yaml", entry.description);
        }
    }
}

static JUST_PRIVATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[[^\]]*private[^\]]*\]\s*$").unwrap());
static JUST_RECIPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z0-9][A-Za-z0-9_-]*)([^:]*):").unwrap());

fn just(text: &str, source: &str, result: &mut Scripts) {
    let mut comments = Vec::new();
    let mut private = false;
    for line in text.lines() {
        if let Some(comment) = line.strip_prefix('#') {
            if !trim(comment).is_empty() {
                comments.push(trim(comment));
            }
            continue;
        }
        if trim(line).is_empty() {
            comments.clear();
            private = false;
            continue;
        }
        if JUST_PRIVATE.is_match(line) {
            private = true;
            continue;
        }
        let recipe = JUST_RECIPE
            .captures(line)
            .filter(|fields| !line[fields.get(0).unwrap().end()..].starts_with('='));
        let Some(recipe) = recipe else {
            if !line.starts_with(whitespace) {
                comments.clear();
            }
            continue;
        };
        let name = &recipe[1];
        let required = recipe[2].split(whitespace).any(|parameter| {
            !parameter.is_empty() && !parameter.contains('=') && !parameter.starts_with('*')
        });
        if !private && !required {
            result.add(
                Kind::Just,
                name,
                format!("just {name}").into(),
                source,
                Some(comments.join(" ").into()),
            );
        }
        comments.clear();
        private = false;
    }
}

static TOML_SECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$").unwrap());
static TOML_ENTRY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=\s*(.+?)\s*$").unwrap());

fn cargo(project: &Project, result: &mut Scripts) {
    let source = "Cargo.toml";
    let Some(text) = project.read(source).filter(|text| !text.is_empty()) else {
        return;
    };
    for (name, description) in [
        ("build", "Build the current Cargo package or workspace."),
        ("check", "Check the project without producing binaries."),
        ("test", "Run the Cargo test suite."),
        ("clippy", "Run the Rust linter."),
        ("fmt", "Format Rust sources."),
    ] {
        result.add(
            Kind::Cargo,
            name,
            format!("cargo {name}").into(),
            source,
            Some(description.into()),
        );
    }
    if text.contains("[[bin]]") || project.exists("src/main.rs") {
        result.add(
            Kind::Cargo,
            "run",
            "cargo run".into(),
            source,
            Some("Run the current Cargo binary.".into()),
        );
    }
    let config = Path::new(".cargo").join("config");
    let modern = config.with_extension("toml");
    if let Some((source, text)) =
        project.first_nonempty(&[modern.to_str().unwrap(), config.to_str().unwrap()])
    {
        let mut active = false;
        for line in text.lines() {
            if let Some(section) = TOML_SECTION.captures(line) {
                active = trim(&section[1]) == "alias";
            } else if active && let Some(entry) = TOML_ENTRY.captures(line) {
                let name = &entry[1];
                result.add(
                    Kind::Cargo,
                    name,
                    format!("cargo {name}").into(),
                    source,
                    Some(format!("Cargo alias: {}", &entry[2]).into()),
                );
            }
        }
    }
}

static GRADLE_TASKS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
        Regex::new(r"(?:^|\n)\s*task\s+([A-Za-z0-9][A-Za-z0-9_.-]*)").unwrap(),
        Regex::new(
            r#"tasks\.(?:register|create)(?:<[^>]+>)?\s*\(\s*["']([A-Za-z0-9][A-Za-z0-9_.-]*)["']"#,
        )
        .unwrap(),
        Regex::new(
            r"(?:^|\n)\s*val\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s+by\s+tasks\.(?:registering|creating)",
        )
        .unwrap(),
    ]
});

fn gradle(project: &Project, windows: bool, result: &mut Scripts) {
    let Some((source, text)) = ["build.gradle", "build.gradle.kts"]
        .into_iter()
        .find_map(|source| project.read(source).map(|text| (source, text)))
    else {
        return;
    };
    let (wrapper, launcher) = if windows {
        ("gradlew.bat", "gradlew.bat")
    } else {
        ("gradlew", "./gradlew")
    };
    if text.is_empty() || !project.exists(wrapper) {
        return;
    }
    let names = ["build", "test", "check", "clean", "assemble"]
        .into_iter()
        .chain(GRADLE_TASKS.iter().flat_map(|pattern| {
            pattern
                .captures_iter(&text)
                .map(|captures| captures.get(1).unwrap().as_str())
        }));
    for name in names {
        result.add(
            Kind::Gradle,
            name,
            format!("{launcher} {name}").into(),
            source,
            Some("Gradle task".into()),
        );
    }
}

fn make(text: &str, source: &str, result: &mut Scripts) {
    let mut description: Option<JsString> = None;
    for line in text.lines() {
        if let Some(comment) = line.strip_prefix("##") {
            description = Some(trim(comment).into());
            continue;
        }
        if line.starts_with(whitespace) {
            continue;
        }
        if let Some((targets, tail)) = line.split_once(':')
            && !tail.starts_with('=')
        {
            for name in targets.split(whitespace).filter(|name| !name.is_empty()) {
                result.add(
                    Kind::Make,
                    name,
                    format!("make {name}").into(),
                    source,
                    description.clone(),
                );
            }
            description = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovers_all_manifest_kinds_with_the_existing_platform_rules() -> Result<()> {
        let root = tempfile::tempdir()?;
        let base = root.path();
        for (file, contents) in [
            (
                "package.json",
                r#"{"scripts":{"dev":"vite","bad name":"invalid"}}"#,
            ),
            ("pnpm-lock.yaml", ""),
            (
                "pubspec.yaml",
                "scripts:\n  analyze: dart analyze # notes\n",
            ),
            (
                "justfile",
                "# Use a port\nserve port='8080':\n[private]\nsecret:\nneed target:\n",
            ),
            ("Cargo.toml", "[[bin]]\n"),
            (
                ".cargo/config.toml",
                "[alias]\nxtask = \"run --package xtask\"\n",
            ),
            ("build.gradle.kts", "val smoke by tasks.registering { }\n"),
            ("gradlew.bat", ""),
            ("Makefile", "## Release package\nrelease:\n"),
        ] {
            let file = base.join(file);
            fs::create_dir_all(file.parent().unwrap())?;
            fs::write(file, contents)?;
        }
        let results = discover(base, true, &Scope::default())?;
        crate::http::checked("scriptCommandListSchema", &results)?;
        let scripts = results.as_array().unwrap();
        let find = |command: &str| scripts.iter().find(|script| script["command"] == command);
        assert_eq!(scripts[0]["command"], "pnpm run dev");
        assert!(find("dart analyze").is_some());
        assert_eq!(find("just serve").unwrap()["description"], "Use a port");
        assert!(find("just secret").is_none());
        assert!(find("just need").is_none());
        assert!(find("cargo run").is_some());
        assert!(find("cargo xtask").is_some());
        assert!(find("gradlew.bat smoke").is_some());
        assert_eq!(
            find("make release").unwrap()["description"],
            "Release package"
        );
        assert_eq!(scripts.len(), 17);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn follows_manifest_aliases_inside_the_project_and_excludes_external_files() -> Result<()> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        let linked = root.path().join("project.json");
        let external = outside.path().join("private.json");
        fs::write(&linked, r#"{"scripts":{"inside":"available"}}"#)?;
        fs::write(&external, r#"{"scripts":{"external":"private"}}"#)?;
        std::os::unix::fs::symlink(&linked, root.path().join("package.json"))?;
        std::os::unix::fs::symlink(&external, root.path().join("Makefile"))?;
        let contents = discover(root.path(), false, &Scope::default())?;
        let scripts = contents.as_array().unwrap();
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0]["command"], "npm run inside");
        Ok(())
    }
}
