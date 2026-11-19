//! Provider diagnostics are used by definition inspection. Launch builds the
//! real command and leaves tool availability to the owned process spawn.
mod cargo;
mod dart;
mod dart_source;
mod flutter;
mod node;
mod sdk;

use super::{
    Environment, Failure, layers,
    shell::{self, Launch},
};
use crate::{
    filesystem::{Scope, paths},
    platform,
};
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};
use std::path::{Path, PathBuf};

pub(crate) use flutter::inspect_devices;

pub(super) struct Resolved<'a> {
    document: &'a Value,
    selected: &'a Value,
}

impl<'a> Resolved<'a> {
    pub(super) fn new(document: &'a Value) -> Self {
        Self {
            document,
            selected: &document["platformOverrides"][platform::platform()],
        }
    }

    pub(super) fn field(&self, name: &str) -> &'a Value {
        self.selected.get(name).unwrap_or(&self.document[name])
    }

    pub(super) fn option(&self, name: &str) -> &'a Value {
        self.selected["options"]
            .get(name)
            .unwrap_or(&self.document["options"][name])
    }
}

pub(super) fn environment(document: &Value) -> Value {
    let resolved = Resolved::new(document);
    let field = |name| {
        resolved.selected["environment"]
            .get(name)
            .unwrap_or(&document["environment"][name])
    };
    json!({
        "includeCodexEnvironment":field("includeCodexEnvironment"),"files":field("files"),
        "variables":field("variables"),"secrets":field("secrets"),
    })
}

pub(super) fn materialize(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    match document["provider"].as_str() {
        Some("shell") => shell::materialize(document, root, baseline),
        Some("node") => node::materialize(document, root, baseline),
        Some("dart") => dart::materialize(document, root, baseline),
        Some("flutter") => flutter::materialize(document, root, baseline),
        Some("rust") => cargo::materialize(document, root, baseline),
        _ => Err(Failure::new(
            "provider",
            "provider-unavailable",
            "This Run configuration provider is unavailable on the native worker.",
            true,
        )),
    }
}

pub(crate) fn capabilities() -> Value {
    let capability = |provider, label, icon, discovery| {
        json!({
            "provider":provider,"label":label,"icon":icon,"available":true,
            "supportsDiscovery":discovery,"supportsCommandOverride":true,
            "supportsBeforeLaunch":true,"supportsPlatformOverrides":true,
        })
    };
    json!(vec![
        capability("shell", "Shell", "terminal", false),
        capability("node", "Node / package", "package", true),
        capability("dart", "Dart", "file-code", true),
        capability("flutter", "Flutter", "smartphone", true),
        capability("rust", "Rust / Cargo", "boxes", true),
    ])
}

pub(crate) fn detect(
    root: &Path,
    provider: Option<&str>,
    scope: &Scope,
) -> Result<(Vec<Value>, Vec<Value>)> {
    match provider {
        None => {
            let mut candidates = node::discover(root, scope)?;
            let packages = dart_source::scan(root, scope)?;
            candidates.extend(dart::discover(&packages, scope)?);
            candidates.extend(flutter::discover(&packages, scope)?);
            candidates.extend(cargo::discover(root, scope)?);
            Ok((candidates, vec![]))
        }
        Some("node") => Ok((node::discover(root, scope)?, vec![])),
        Some("dart" | "flutter") => {
            let packages = dart_source::scan(root, scope)?;
            let candidates = if provider == Some("dart") {
                dart::discover(&packages, scope)?
            } else {
                flutter::discover(&packages, scope)?
            };
            Ok((candidates, vec![]))
        }
        Some("rust") => Ok((cargo::discover(root, scope)?, vec![])),
        Some("shell") => Ok((vec![], vec![])),
        Some(provider) => Ok((
            vec![],
            vec![json!({
                "severity":"warning","code":"provider-unavailable",
                "message":format!("The {provider} Run configuration provider is not installed on this worker."),
                "relativePath":Value::Null,"field":"provider",
            })],
        )),
    }
}

pub(crate) fn validation(
    document: &Value,
    root: &Path,
    baseline: &Environment,
    scope: &Scope,
) -> Result<Value> {
    let (effective, diagnostics) = match document["provider"].as_str() {
        Some("shell") => shell::validate(document, root, baseline),
        Some("node") => node::validate(document, root, baseline),
        Some("dart") => dart::validate(document, root, baseline),
        Some("flutter") => flutter::validate(document, root, baseline),
        Some("rust") => cargo::validate(document, root, baseline, scope)?,
        _ => bail!("This Run configuration provider is unavailable on the native worker."),
    };
    Ok(json!({
        "configurationId":document["id"],"provider":document["provider"],
        "platform":platform::platform(),"effectiveCommand":effective,
        "valid":diagnostics.is_empty(),"diagnostics":diagnostics
    }))
}

pub(super) fn issue(code: &str, message: &str, field: &str) -> Value {
    json!({"severity":"error","code":code,"message":message,"relativePath":Value::Null,"field":field})
}

pub(super) fn executable_diagnostic(
    program: &str,
    field: &str,
    root: &Path,
    baseline: &Environment,
) -> Option<Value> {
    find_executable(program, root, baseline)
        .is_none()
        .then(|| missing_executable(program, field))
}

fn missing_executable(program: &str, field: &str) -> Value {
    issue(
        "executable-unavailable",
        &format!(
            "The required executable {} is not available in the target worker launch environment. Install it, add it to PATH, or select a configured SDK/toolchain path.",
            json!(program).stringify()
        ),
        field,
    )
}

fn find_executable(program: &str, root: &Path, baseline: &Environment) -> Option<PathBuf> {
    if program.contains(['/', '\\']) {
        let candidate =
            paths::canonical_sync(&cantrip_config::resolve(root, Path::new(program))).ok()?;
        return executable_file(&candidate).then_some(candidate);
    }
    let path = layers::env_value(baseline, "PATH")?;
    let mut names = vec![program.to_owned()];
    if cfg!(windows) && Path::new(program).extension().is_none() {
        for suffix in layers::env_value(baseline, "PATHEXT")
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .map(str::trim)
            .filter(|suffix| !suffix.is_empty())
        {
            let dot = if suffix.starts_with('.') { "" } else { "." };
            names.push(format!("{program}{dot}{suffix}"));
        }
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    path.split(separator).find_map(|directory| {
        let directory = directory.trim();
        let directory = directory.strip_prefix('"').unwrap_or(directory);
        let directory = directory.strip_suffix('"').unwrap_or(directory);
        let directory = cantrip_config::resolve(root, &PathBuf::from(directory));
        names
            .iter()
            .filter_map(|name| paths::canonical_sync(&directory.join(name)).ok())
            .find(|candidate| executable_file(candidate))
    })
}

fn executable_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        metadata.is_file()
    })
}

fn diagnose_shell(
    root: &Path,
    baseline: &Environment,
    field: &str,
    failure_code: &str,
    issues: &mut Vec<Value>,
) {
    match shell::invocation(root.to_owned(), String::new(), "automatic", true, baseline) {
        Ok(command) => issues.extend(executable_diagnostic(
            &command.program,
            field,
            root,
            baseline,
        )),
        Err(failure) => issues.push(issue(failure_code, &failure.message, field)),
    }
}

fn string_arguments(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|argument| argument.as_js_string().unwrap().lossy().into_owned())
        .collect()
}

fn render(program: &str, arguments: &[String]) -> String {
    let mut command = program.to_owned();
    for value in arguments {
        command.push(' ');
        command.push_str(&quote_argument(value));
    }
    command
}

fn quote_argument(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./:@%+=,-".contains(&byte))
    {
        value.to_owned()
    } else if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
