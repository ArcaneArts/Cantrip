//! Static Gradle and Maven discovery. No build script runs while inspecting a project.
use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository::read_bounded},
};
use anyhow::Result;
use regex::Regex;
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

const DIRECTORIES: usize = 1024;
const DEPTH: usize = 10;
const MANIFESTS: usize = 256;
const SOURCES: usize = 512;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum System {
    Gradle,
    Maven,
}

impl System {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Gradle => "Gradle",
            Self::Maven => "Maven",
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Gradle => "gradle",
            Self::Maven => "maven",
        }
    }

    pub(super) fn wrapper(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::Gradle, true) => "gradlew.bat",
            (Self::Gradle, false) => "gradlew",
            (Self::Maven, true) => "mvnw.cmd",
            (Self::Maven, false) => "mvnw",
        }
    }

    pub(super) fn executable(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::Gradle, true) => "gradle.bat",
            (Self::Gradle, false) => "gradle",
            (Self::Maven, true) => "mvn.cmd",
            (Self::Maven, false) => "mvn",
        }
    }
}

struct Directory {
    absolute: PathBuf,
    relative: String,
    depth: usize,
}

struct Manifest {
    directory: String,
    gradle: Option<String>,
    settings: Option<String>,
    pom: Option<String>,
}

#[derive(Clone)]
pub(super) struct Main {
    pub class: String,
    pub file: String,
}

pub(super) struct Module {
    pub artifact: Option<String>,
    pub declared: Option<String>,
    pub mains: Vec<Main>,
    pub selector: Option<String>,
    pub tasks: Vec<String>,
}

pub(super) struct Build {
    pub directory: String,
    pub system: System,
    pub modules: Vec<Module>,
}

impl Build {
    pub(super) fn module(&self, selected: Option<&str>) -> Option<&Module> {
        self.modules.iter().find(|module| {
            module.selector.as_deref() == selected
                || self.system == System::Maven
                    && selected.is_some_and(|selector| {
                        module.artifact.as_deref().is_some_and(|artifact| {
                            selector == artifact || selector.strip_prefix(':') == Some(artifact)
                        })
                    })
        })
    }
}

pub(super) fn project(root: &Path, scope: &Scope) -> Result<Vec<Build>> {
    let collator = collator()?;
    let mut queue = VecDeque::from([Directory {
        absolute: root.to_owned(),
        relative: ".".into(),
        depth: 0,
    }]);
    let mut manifests = Vec::new();
    let mut mains = Vec::new();
    let mut visited = 0;
    let mut manifest_count = 0;
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
                Some((
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.file_type().ok()?,
                    entry.path(),
                ))
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(left, _, _), (right, _, _)| collator.compare(left, right));
        let files = entries
            .iter()
            .filter(|(_, kind, _)| kind.is_file())
            .map(|(name, _, path)| (name.as_str(), path));
        let known = files.clone().collect::<HashMap<_, _>>();
        let gradle = known
            .get("build.gradle.kts")
            .or_else(|| known.get("build.gradle"));
        let settings = known
            .get("settings.gradle.kts")
            .or_else(|| known.get("settings.gradle"));
        let pom = known.get("pom.xml");
        let count = [gradle, settings, pom].into_iter().flatten().count();
        if count > 0 {
            manifest_count += count;
            let text = |path: Option<&&PathBuf>| {
                path.and_then(|path| read_text(path, 1024 * 1024))
                    .filter(|text| !text.is_empty())
            };
            manifests.push(Manifest {
                directory: current.relative.clone(),
                gradle: text(gradle),
                settings: text(settings),
                pom: text(pom),
            });
        }
        if current.relative.split('/').any(|segment| segment == "src") {
            for (name, path) in files.filter(|(name, _)| name.ends_with(".java")) {
                scope.check()?;
                if mains.len() == SOURCES {
                    break;
                }
                if let Some(class) =
                    read_text(path, 512 * 1024).and_then(|source| main_class(&source, name))
                {
                    mains.push(Main {
                        class,
                        file: join(&current.relative, name),
                    });
                }
            }
        }
        if manifest_count >= MANIFESTS {
            break;
        }
        if current.depth < DEPTH {
            let remaining = DIRECTORIES - visited - queue.len();
            for (name, _, path) in entries
                .into_iter()
                .filter(|(name, kind, _)| kind.is_dir() && !ignored(name))
                .take(remaining)
            {
                queue.push_back(Directory {
                    absolute: path,
                    relative: join(&current.relative, &name),
                    depth: current.depth + 1,
                });
            }
        }
    }

    let order = |left: &str, right: &str| {
        depth(left)
            .cmp(&depth(right))
            .then_with(|| collator.compare(left, right))
    };
    let settings = manifests
        .iter()
        .filter(|entry| entry.settings.is_some())
        .map(|entry| entry.directory.as_str())
        .collect::<Vec<_>>();
    let mut gradle_roots = settings.clone();
    gradle_roots.extend(
        manifests
            .iter()
            .filter(|entry| {
                entry.gradle.is_some()
                    && !settings.iter().any(|root| beneath(&entry.directory, root))
            })
            .map(|entry| entry.directory.as_str()),
    );
    gradle_roots.sort_by(|left, right| order(left, right));
    let mut builds = Vec::new();
    for root in &gradle_roots {
        scope.check()?;
        builds.push(gradle_build(root, &gradle_roots, &manifests, &mains));
    }

    let poms = manifests
        .iter()
        .filter_map(|entry| Some((entry.directory.as_str(), entry.pom.as_deref()?)))
        .collect::<HashMap<_, _>>();
    let mut pom_roots = poms.keys().copied().collect::<Vec<_>>();
    pom_roots.sort_by(|left, right| order(left, right));
    let mut assigned = HashSet::new();
    for root in pom_roots {
        scope.check()?;
        if !assigned.contains(root) {
            builds.push(maven_build(root, &poms, &mains, &mut assigned));
        }
    }
    Ok(builds)
}

fn gradle_build(root: &str, roots: &[&str], manifests: &[Manifest], mains: &[Main]) -> Build {
    let nested_roots = roots
        .iter()
        .copied()
        .filter(|nested| *nested != root && beneath(nested, root))
        .collect::<Vec<_>>();
    let mappings = manifests
        .iter()
        .find(|entry| entry.directory == root)
        .and_then(|entry| entry.settings.as_deref())
        .map_or_else(HashMap::new, gradle_project_paths);
    let entries = manifests
        .iter()
        .filter(|entry| {
            entry.gradle.is_some()
                && beneath(&entry.directory, root)
                && !nested_roots
                    .iter()
                    .any(|nested| beneath(&entry.directory, nested))
        })
        .collect::<Vec<_>>();
    let directories = entries
        .iter()
        .map(|entry| entry.directory.as_str())
        .collect::<Vec<_>>();
    let mut modules = entries
        .iter()
        .map(|entry| {
            let directory = relative(root, &entry.directory);
            let selector = if directory == "." {
                ":".to_owned()
            } else {
                mappings
                    .get(directory)
                    .cloned()
                    .unwrap_or_else(|| format!(":{}", directory.replace('/', ":")))
            };
            let manifest = entry.gradle.as_deref().unwrap();
            Module {
                artifact: None,
                declared: declared_main(System::Gradle, manifest),
                mains: module_mains(mains, &entry.directory, &directories),
                selector: Some(selector),
                tasks: gradle_tasks(manifest),
            }
        })
        .collect::<Vec<_>>();
    if modules.is_empty() {
        modules.push(Module {
            artifact: None,
            declared: None,
            mains: module_mains(mains, root, &[root]),
            selector: Some(":".into()),
            tasks: vec![],
        });
    }
    Build {
        directory: root.to_owned(),
        system: System::Gradle,
        modules,
    }
}

fn maven_build<'a>(
    root: &'a str,
    poms: &HashMap<&'a str, &str>,
    mains: &[Main],
    assigned: &mut HashSet<&'a str>,
) -> Build {
    let mut directories = Vec::new();
    let mut queue = VecDeque::from([root]);
    while directories.len() < 128 {
        let Some(directory) = queue.pop_front() else {
            break;
        };
        if !assigned.insert(directory) {
            continue;
        }
        directories.push(directory);
        for module in maven_modules(poms[directory]) {
            if let Some((&child, _)) = poms.get_key_value(join(directory, module).as_str()) {
                queue.push_back(child);
            }
        }
    }
    let modules = directories
        .iter()
        .map(|directory| {
            let manifest = poms[directory];
            let path = relative(root, directory);
            Module {
                artifact: maven_artifact(manifest),
                declared: declared_main(System::Maven, manifest),
                mains: module_mains(mains, directory, &directories),
                selector: (path != ".").then(|| path.to_owned()),
                tasks: maven_goals(manifest),
            }
        })
        .collect();
    Build {
        directory: root.to_owned(),
        system: System::Maven,
        modules,
    }
}

fn module_mains(mains: &[Main], directory: &str, modules: &[&str]) -> Vec<Main> {
    let nested = modules
        .iter()
        .copied()
        .filter(|nested| *nested != directory && beneath(nested, directory))
        .collect::<Vec<_>>();
    mains
        .iter()
        .filter(|main| {
            beneath(&main.file, directory)
                && !nested.iter().any(|nested| beneath(&main.file, nested))
        })
        .cloned()
        .collect()
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".cantrip"
            | ".git"
            | ".gradle"
            | ".idea"
            | ".mvn-cache"
            | ".settings"
            | "build"
            | "dist"
            | "node_modules"
            | "out"
            | "target"
    )
}

pub(super) fn join(parent: &str, child: &str) -> String {
    if parent == "." {
        child.to_owned()
    } else {
        format!("{parent}/{child}")
    }
}

fn depth(path: &str) -> usize {
    if path == "." {
        0
    } else {
        path.split('/').count()
    }
}

fn beneath(path: &str, parent: &str) -> bool {
    parent == "."
        || parent == path
        || path
            .strip_prefix(parent)
            .is_some_and(|tail| tail.starts_with('/'))
}

fn relative<'a>(parent: &str, path: &'a str) -> &'a str {
    if path == parent {
        "."
    } else if parent == "." {
        path
    } else {
        &path[parent.len() + 1..]
    }
}

fn module_path(path: &str) -> Option<&str> {
    let path = cantrip_wire::text::trim(path);
    let path = path.strip_prefix("./").unwrap_or(path);
    (!path.contains('\\') && !path.split('/').any(|part| matches!(part, "" | "." | "..")))
        .then_some(path)
}

fn read_text(path: &Path, maximum: u64) -> Option<String> {
    let bytes = read_bounded(path, maximum).ok()?;
    (!bytes.contains(&0)).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

fn class_name(name: &str) -> bool {
    name.split('.').all(|part| {
        let mut bytes = part.bytes();
        bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || b"_$".contains(&byte))
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"_$".contains(&byte))
    })
}

fn main_class(source: &str, file_name: &str) -> Option<String> {
    static COMMENTS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/|//[^\r\n]*").unwrap());
    static MAIN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"\bpublic\s+(?:final\s+)?static\s+(?:final\s+)?void\s+main\s*\(\s*(?:final\s+)?(?:java\.lang\.)?String(?:\s*\[\s*\]\s*[A-Za-z_$]|\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\[\s*\]|\s*\.\.\.\s*[A-Za-z_$])"
    ).unwrap()
    });
    static PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\bpackage\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;")
            .unwrap()
    });
    let simple = file_name.strip_suffix(".java")?;
    if simple.contains('.') || !class_name(simple) {
        return None;
    }
    let cleaned = COMMENTS.replace_all(source, " ");
    if !MAIN.is_match(&cleaned) {
        return None;
    }
    Some(capture(&PACKAGE, &cleaned).map_or_else(
        || simple.to_owned(),
        |package| format!("{package}.{simple}"),
    ))
}

fn capture<'a>(regex: &Regex, text: &'a str) -> Option<&'a str> {
    Some(cantrip_wire::text::trim(
        regex.captures(text)?.get(1)?.as_str(),
    ))
}

fn patterns<const N: usize>(patterns: [&str; N]) -> [Regex; N] {
    patterns.map(|pattern| Regex::new(pattern).unwrap())
}

fn declared_main(system: System, manifest: &str) -> Option<String> {
    static GRADLE: LazyLock<[Regex; 2]> = LazyLock::new(|| {
        patterns([
            r#"\bmainClass(?:Name)?\s*(?:\.set\s*\()?\s*["']([^"']+)["']"#,
            r#"\bmainClass(?:Name)?\s*=\s*["']([^"']+)["']"#,
        ])
    });
    static MAVEN: LazyLock<[Regex; 2]> = LazyLock::new(|| {
        patterns([
            r"<mainClass>\s*([^<]+?)\s*</mainClass>",
            r"<start-class>\s*([^<]+?)\s*</start-class>",
        ])
    });
    let candidates = match system {
        System::Gradle => &*GRADLE,
        System::Maven => &*MAVEN,
    };
    candidates
        .iter()
        .find_map(|regex| capture(regex, manifest).filter(|name| class_name(name)))
        .map(str::to_owned)
}

fn gradle_tasks(manifest: &str) -> Vec<String> {
    static APPLICATION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b(?:application|mainClass(?:Name)?)\b").unwrap());
    static JAVA_EXEC: LazyLock<[Regex; 3]> = LazyLock::new(|| {
        patterns([
            r#"tasks\.(?:register|create)\s*<\s*JavaExec\s*>\s*\(\s*["']([A-Za-z0-9_.-]+)["']"#,
            r#"tasks\.(?:register|create)\s*\(\s*["']([A-Za-z0-9_.-]+)["'][^\n)]*\bJavaExec\b"#,
            r"\btask\s+([A-Za-z0-9_.-]+)\s*\([^\n)]*type\s*:\s*JavaExec",
        ])
    });
    let mut tasks = BTreeSet::new();
    for (found, task) in [
        (APPLICATION.is_match(manifest), "run"),
        (
            manifest.contains("org.springframework.boot") || manifest.contains("spring-boot"),
            "bootRun",
        ),
        (manifest.contains("io.quarkus"), "quarkusDev"),
    ] {
        if found {
            tasks.insert(task);
        }
    }
    for pattern in JAVA_EXEC.iter() {
        for found in pattern.captures_iter(manifest) {
            tasks.insert(found.get(1).unwrap().as_str());
            if tasks.len() >= 64 {
                break;
            }
        }
    }
    tasks.into_iter().map(str::to_owned).collect()
}

fn gradle_project_paths(settings: &str) -> HashMap<&str, String> {
    static PROJECT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r#"project\s*\(\s*["'](:[A-Za-z0-9_.:-]+)["']\s*\)\.projectDir\s*=\s*(?:file\s*\(|new\s+File\s*\(\s*rootDir\s*,\s*)["']([^"']+)["']"#
    ).unwrap()
    });
    let mut projects = HashMap::new();
    for found in PROJECT.captures_iter(settings) {
        if let Some(directory) = module_path(found.get(2).unwrap().as_str()) {
            projects.insert(directory, found[1].to_owned());
        }
        if projects.len() >= 128 {
            break;
        }
    }
    projects
}

fn maven_artifact(manifest: &str) -> Option<String> {
    static PARENT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)<parent\b[^>]*>.*?</parent>").unwrap());
    static ARTIFACT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<artifactId>\s*([^<]+?)\s*</artifactId>").unwrap());
    capture(&ARTIFACT, &PARENT.replace(manifest, "")).map(str::to_owned)
}

fn maven_modules(manifest: &str) -> Vec<&str> {
    static MODULES: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<module>\s*([^<]+?)\s*</module>").unwrap());
    let mut seen = HashSet::new();
    MODULES
        .captures_iter(manifest)
        .filter_map(|found| module_path(found.get(1)?.as_str()))
        .filter(|path| seen.insert(*path))
        .take(128)
        .collect()
}

fn maven_goals(manifest: &str) -> Vec<String> {
    [
        ("exec-maven-plugin", "exec:java"),
        ("quarkus-maven-plugin", "quarkus:dev"),
        ("spring-boot-maven-plugin", "spring-boot:run"),
    ]
    .into_iter()
    .filter(|(plugin, _)| manifest.contains(plugin))
    .map(|(_, goal)| goal.to_owned())
    .collect()
}
