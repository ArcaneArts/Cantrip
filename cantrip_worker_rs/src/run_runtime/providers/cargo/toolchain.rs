//! Definition inspection can describe installed Rustup tools. The launcher
//! delegates executable and toolchain selection to Cargo in the Run environment.
use super::{Resolved, cargo_executable};
use crate::{
    filesystem::paths,
    run_runtime::{
        Environment,
        layers::env_value,
        providers::{executable_diagnostic, executable_file, issue},
    },
};
use cantrip_wire::{Value, value::json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

const MAX_TOOLCHAINS: usize = 512;

pub(super) fn diagnostics(
    document: &Value,
    resolved: &Resolved<'_>,
    root: &Path,
    cwd: &Path,
    baseline: &Environment,
) -> Vec<Value> {
    if let Some(diagnostic) =
        executable_diagnostic(cargo_executable(), "options.toolchain", root, baseline)
    {
        return vec![diagnostic];
    }
    let configured = resolved.option("toolchain").as_str().unwrap();
    let Some(requested) = (if configured == "default" {
        env_value(baseline, "RUSTUP_TOOLCHAIN")
    } else {
        Some(configured)
    })
    .filter(|value| !value.is_empty()) else {
        return vec![];
    };
    let roots = match matching_roots(requested, cwd, baseline) {
        Ok(roots) if !roots.is_empty() => roots,
        Ok(_) => {
            return vec![issue(
                "rust-toolchain-unavailable",
                &format!(
                    "The selected Rust toolchain {} is not installed for this launch environment. Install it with rustup or select an installed toolchain.",
                    json!(requested).stringify()
                ),
                "options.toolchain",
            )];
        }
        Err(()) => {
            return vec![issue(
                "rust-toolchain-inventory-too-large",
                "The Rustup toolchain inventory exceeds the validation limit.",
                "options.toolchain",
            )];
        }
    };
    let mut diagnostics = Vec::new();
    if !has_tools(&roots, &["rustc"]) {
        diagnostics.push(component_issue(
            "rust-compiler-unavailable",
            "Rust compiler",
            "rustc",
            "options.toolchain",
        ));
    }
    if let Some(index) = document["beforeLaunch"]
        .as_array()
        .unwrap()
        .iter()
        .position(|step| step["kind"] == "providerTask" && step["task"] == "clippy")
        && !has_tools(&roots, &["cargo-clippy", "clippy-driver"])
    {
        diagnostics.push(component_issue(
            "rust-clippy-unavailable",
            "Clippy component",
            "clippy",
            &format!("beforeLaunch[{index}].task"),
        ));
    }
    if let Some(triple) = resolved.option("targetTriple").as_str()
        && !roots.iter().any(|root| {
            root.join("lib")
                .join("rustlib")
                .join(triple)
                .join("lib")
                .is_dir()
        })
    {
        diagnostics.push(issue(
            "rust-target-unavailable",
            &format!("The selected Rust target {} is not installed for the launch toolchain. Install it with rustup target add or choose an installed target.", json!(triple).stringify()),
            "options.targetTriple",
        ));
    }
    diagnostics
}

fn rustup_home(cwd: &Path, baseline: &Environment) -> Option<PathBuf> {
    let absolute = |value: &str| cantrip_config::resolve(cwd, Path::new(value));
    if let Some(configured) = env_value(baseline, "RUSTUP_HOME") {
        return Some(absolute(configured));
    }
    let mut home = env_value(baseline, "HOME").map(str::to_owned);
    if cfg!(windows) {
        home = env_value(baseline, "USERPROFILE")
            .map(str::to_owned)
            .or(home);
        if home.as_ref().is_none_or(String::is_empty)
            && let Some(drive) = env_value(baseline, "HOMEDRIVE")
            && let Some(path) = env_value(baseline, "HOMEPATH")
            && !drive.is_empty()
            && !path.is_empty()
        {
            home = Some(format!("{drive}{path}"));
        }
    }
    home.filter(|value| !value.is_empty())
        .map(|value| absolute(&value).join(".rustup"))
}

fn matching_roots(requested: &str, cwd: &Path, baseline: &Environment) -> Result<Vec<PathBuf>, ()> {
    let Some(home) = rustup_home(cwd, baseline) else {
        return Ok(vec![]);
    };
    let Ok(installed) = fs::read_dir(home.join("toolchains")) else {
        return Ok(vec![]);
    };
    let installed = installed
        .take(MAX_TOOLCHAINS + 1)
        .collect::<std::io::Result<Vec<_>>>();
    let Ok(installed) = installed else {
        return Ok(vec![]);
    };
    if installed.len() > MAX_TOOLCHAINS {
        return Err(());
    }
    Ok(installed
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            if !toolchain_matches(requested, name.to_str()?) {
                return None;
            }
            let root = paths::canonical_sync(&entry.path()).ok()?;
            (root.is_dir() && executable_file(&root.join("bin").join(cargo_executable())))
                .then_some(root)
        })
        .collect())
}

fn toolchain_matches(requested: &str, installed: &str) -> bool {
    static SHORTHAND: LazyLock<regress::Regex> = LazyLock::new(|| {
        regress::Regex::new(
            r"^(?:(?:stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?|\d+\.\d+(?:\.\d+)?)$",
        )
        .expect("Rustup shorthand")
    });
    installed == requested
        || (installed
            .strip_prefix(requested)
            .is_some_and(|suffix| suffix.starts_with('-'))
            && SHORTHAND.find(requested).is_some())
}

fn has_tools(roots: &[PathBuf], tools: &[&str]) -> bool {
    roots.iter().any(|root| {
        let bin = root.join("bin");
        tools.iter().all(|tool| {
            let name = if cfg!(windows) {
                format!("{tool}.exe")
            } else {
                (*tool).to_owned()
            };
            executable_file(&bin.join(name))
        })
    })
}

fn component_issue(code: &str, name: &str, install: &str, field: &str) -> Value {
    issue(
        code,
        &format!(
            "The selected Rust toolchain does not include the {name} required by this Run configuration. Install it with rustup component add {install} or select a toolchain that includes it."
        ),
        field,
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::run_definitions::repository;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn reports_missing_toolchain_components_from_files_without_invoking_cargo() -> anyhow::Result<()>
    {
        let directory = tempfile::tempdir()?;
        let root = paths::canonical_sync(directory.path())?;
        let path = root.join("bin");
        let home = root.join("rustup");
        let toolchain = home.join("toolchains/nightly-2026-08-01-aarch64-apple-darwin");
        let bin = toolchain.join("bin");
        fs::create_dir_all(&path)?;
        fs::create_dir_all(&bin)?;
        let mark = root.join("executed");
        let tool = |path: PathBuf| -> std::io::Result<()> {
            fs::write(
                &path,
                format!("#!/bin/sh\necho started > '{}'\n", mark.display()),
            )?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        };
        tool(path.join("cargo"))?;
        tool(bin.join("cargo"))?;
        let environment = Environment::from([
            ("PATH".into(), path.to_string_lossy().into_owned()),
            ("RUSTUP_HOME".into(), home.to_string_lossy().into_owned()),
            ("RUSTUP_TOOLCHAIN".into(), "nightly-2026-08-01".into()),
        ]);
        let source = json!({
            "schema":"cantrip.run-configuration","version":1,"id":uuid::Uuid::new_v4().to_string(),
            "name":"Cargo fixture","provider":"rust",
            "target":json!({"kind":"binary","package":"fixture","name":"fixture"}),
            "options":json!({"targetTriple":"aarch64-apple-darwin"}),
            "beforeLaunch":vec![json!({"kind":"providerTask","task":"clippy"})],
        });
        let document = repository::document(&source)
            .map_err(|error| anyhow::anyhow!("fixture: {}", error.body()))?;
        let resolved = Resolved::new(&document);
        let missing = diagnostics(&document, &resolved, &root, &root, &environment);
        let codes = missing
            .iter()
            .map(|item| item["code"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            codes,
            [
                "rust-compiler-unavailable",
                "rust-clippy-unavailable",
                "rust-target-unavailable"
            ]
        );

        for name in ["rustc", "cargo-clippy", "clippy-driver"] {
            tool(bin.join(name))?;
        }
        fs::create_dir_all(toolchain.join("lib/rustlib/aarch64-apple-darwin/lib"))?;
        assert!(diagnostics(&document, &resolved, &root, &root, &environment).is_empty());
        assert!(!mark.exists());
        Ok(())
    }
}
