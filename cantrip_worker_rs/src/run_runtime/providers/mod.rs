//! Provider diagnostics are used by definition inspection. Launch builds the
//! real command and leaves tool availability to the owned process spawn.
mod node;

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
    ])
}

pub(crate) fn detect(
    root: &Path,
    provider: Option<&str>,
    scope: &Scope,
) -> Result<(Vec<Value>, Vec<Value>)> {
    match provider {
        None | Some("node") => Ok((node::discover(root, scope)?, vec![])),
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

pub(crate) fn validation(document: &Value, root: &Path, baseline: &Environment) -> Result<Value> {
    let (effective, diagnostics) = match document["provider"].as_str() {
        Some("shell") => shell::validate(document, root, baseline),
        Some("node") => node::validate(document, root, baseline),
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
    if executable_on_path(program, root, baseline) {
        return None;
    }
    Some(issue(
        "executable-unavailable",
        &format!(
            "The required executable {} is not available in the target worker launch environment. Install it, add it to PATH, or select a configured SDK/toolchain path.",
            json!(program).stringify()
        ),
        field,
    ))
}

fn executable_on_path(program: &str, root: &Path, baseline: &Environment) -> bool {
    fn executable(path: &Path) -> bool {
        paths::canonical_sync(path)
            .and_then(std::fs::metadata)
            .is_ok_and(|metadata| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                }
                #[cfg(not(unix))]
                metadata.is_file()
            })
    }
    if program.contains(['/', '\\']) {
        return executable(&cantrip_config::resolve(root, Path::new(program)));
    }
    let Some(path) = layers::env_value(baseline, "PATH") else {
        return false;
    };
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
    path.split(separator).any(|directory| {
        let directory = directory.trim();
        let directory = directory.strip_prefix('"').unwrap_or(directory);
        let directory = directory.strip_suffix('"').unwrap_or(directory);
        let directory = cantrip_config::resolve(root, &PathBuf::from(directory));
        names.iter().any(|name| executable(&directory.join(name)))
    })
}
