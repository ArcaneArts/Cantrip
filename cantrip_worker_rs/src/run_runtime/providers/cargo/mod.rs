mod manifest;
mod toolchain;

use super::{
    Environment, Failure, Launch, Resolved, diagnose_shell, environment, issue, render, shell,
    string_arguments,
};
use crate::{
    filesystem::Scope,
    run_definitions::{collator, repository},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, value::json};
use manifest::{Kind, Package, Target};
use std::path::{Path, PathBuf};

const TASK_MESSAGE: &str = "Rust provider tasks must be one of: build, check, or clippy.";

pub(super) fn materialize(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    let resolved = Resolved::new(document);
    let cwd = shell::located(root, resolved.field("workingDirectory"), true)
        .map_err(|message| Failure::new("provider", "working-directory-invalid", message, true))?;
    let main = if resolved.field("commandOverride").is_null() {
        command(cwd.clone(), "run", document, &resolved, true)
    } else {
        shell::invocation(
            cwd.clone(),
            effective(document, &resolved),
            "automatic",
            true,
            baseline,
        )?
    };
    let mut before = Vec::new();
    for step in steps(document) {
        if step["kind"] == "providerTask" {
            let task = step["task"].as_str().unwrap();
            if !provider_task(task) {
                return Err(Failure::new(
                    "provider",
                    "rust-provider-task-invalid",
                    TASK_MESSAGE,
                    false,
                ));
            }
            before.push(command(cwd.clone(), task, document, &resolved, false));
        } else {
            let directory =
                shell::located(root, &step["workingDirectory"], true).map_err(|message| {
                    Failure::new("provider", "before-launch-command-invalid", message, true)
                })?;
            before.push(shell::invocation(
                directory,
                step["command"].as_js_string().unwrap().lossy().into_owned(),
                "automatic",
                true,
                baseline,
            )?);
        }
    }
    Ok(Launch {
        main,
        before,
        environment: environment(document),
    })
}

pub(super) fn validate(
    document: &Value,
    root: &Path,
    baseline: &Environment,
    scope: &Scope,
) -> Result<(String, Vec<Value>)> {
    let resolved = Resolved::new(document);
    let custom = !resolved.field("commandOverride").is_null();
    let mut diagnostics = Vec::new();
    match shell::located(root, resolved.field("workingDirectory"), true) {
        Ok(cwd)
            if !custom
                || steps(document)
                    .iter()
                    .any(|step| step["kind"] == "providerTask") =>
        {
            diagnostics.extend(toolchain::diagnostics(
                document, &resolved, root, &cwd, baseline,
            ));
            let packages = manifest::scan(&cwd, scope)?;
            diagnostics.extend(target_diagnostic(&packages, &document["target"], &resolved));
        }
        Err(message) => diagnostics.push(issue(
            "working-directory-invalid",
            message,
            "workingDirectory",
        )),
        _ => {}
    }
    for (index, step) in steps(document).iter().enumerate() {
        let field = format!("beforeLaunch[{index}]");
        if step["kind"] == "providerTask" {
            if !step["task"].as_str().is_some_and(provider_task) {
                diagnostics.push(issue(
                    "rust-provider-task-invalid",
                    TASK_MESSAGE,
                    &format!("{field}.task"),
                ));
            }
        } else {
            match shell::located(root, &step["workingDirectory"], true) {
                Ok(_) => diagnose_shell(
                    root,
                    baseline,
                    &field,
                    "before-launch-command-invalid",
                    &mut diagnostics,
                ),
                Err(message) => {
                    diagnostics.push(issue("before-launch-command-invalid", message, &field))
                }
            }
        }
    }
    if custom {
        diagnose_shell(
            root,
            baseline,
            "commandOverride",
            "shell-unavailable",
            &mut diagnostics,
        );
    }
    Ok((effective(document, &resolved), diagnostics))
}

fn target_diagnostic(
    packages: &[Package],
    target: &Value,
    resolved: &Resolved<'_>,
) -> Option<Value> {
    let package_name = target["package"].as_str().unwrap();
    let target_name = target["name"].as_str().unwrap();
    let kind = target["kind"].as_str().unwrap();
    let mut matches = packages
        .iter()
        .filter(|package| package.name == package_name);
    let Some(package) = matches.next() else {
        return Some(issue(
            "cargo-package-missing",
            &format!("Cargo package {package_name} was not found beneath the start directory."),
            "target.package",
        ));
    };
    if matches.next().is_some() {
        return Some(issue(
            "cargo-package-ambiguous",
            &format!(
                "More than one Cargo package named {package_name} exists beneath the start directory."
            ),
            "target.package",
        ));
    }
    let Some(target) = package
        .targets
        .iter()
        .find(|target| target.kind.name() == kind && target.name == target_name)
    else {
        return Some(issue(
            "cargo-target-missing",
            &format!("Cargo {kind} target {target_name} was not found in package {package_name}."),
            "target.name",
        ));
    };
    let enabled = resolved.option("features").as_array().unwrap();
    if *resolved.option("allFeatures") != true
        && target.features.iter().any(|feature| {
            let qualified = format!("{package_name}/{feature}");
            !enabled
                .iter()
                .any(|value| value == feature || value == &qualified)
        })
    {
        return Some(issue(
            "cargo-target-features-missing",
            &format!(
                "Cargo target {} requires features: {}.",
                target.name,
                target.features.join(", ")
            ),
            "options.features",
        ));
    }
    None
}

fn steps(document: &Value) -> &[Value] {
    document["beforeLaunch"].as_array().unwrap()
}

fn provider_task(task: &str) -> bool {
    matches!(task, "build" | "check" | "clippy")
}

fn cargo_executable() -> &'static str {
    if cfg!(windows) { "cargo.exe" } else { "cargo" }
}

fn cargo_arguments(
    action: &str,
    document: &Value,
    resolved: &Resolved<'_>,
    program_arguments: bool,
) -> Vec<String> {
    let mut arguments = Vec::new();
    let toolchain = resolved.option("toolchain").as_str().unwrap();
    if toolchain != "default" {
        arguments.push(format!("+{toolchain}"));
    }
    let target = &document["target"];
    let target_flag = if target["kind"] == "binary" {
        "bin"
    } else {
        "example"
    };
    arguments.extend([
        action.to_owned(),
        format!("--package={}", target["package"].as_str().unwrap()),
        format!("--{target_flag}={}", target["name"].as_str().unwrap()),
    ]);
    if *resolved.option("allFeatures") == true {
        arguments.push("--all-features".into());
    } else {
        arguments.extend(
            resolved
                .option("features")
                .as_array()
                .unwrap()
                .iter()
                .map(|feature| format!("--features={}", feature.as_str().unwrap())),
        );
    }
    if *resolved.option("useDefaultFeatures") == false {
        arguments.push("--no-default-features".into());
    }
    if let Some(triple) = resolved.option("targetTriple").as_str() {
        arguments.push(format!("--target={triple}"));
    }
    match resolved.option("profile").as_str().unwrap() {
        "dev" => {}
        "release" => arguments.push("--release".into()),
        profile => arguments.push(format!("--profile={profile}")),
    }
    for (option, flag) in [("locked", "--locked"), ("offline", "--offline")] {
        if *resolved.option(option) == true {
            arguments.push(flag.into());
        }
    }
    let selected = resolved.field("arguments");
    if program_arguments && !selected.as_array().unwrap().is_empty() {
        arguments.push("--".into());
        arguments.extend(string_arguments(selected));
    }
    arguments
}

fn command(
    cwd: PathBuf,
    action: &str,
    document: &Value,
    resolved: &Resolved<'_>,
    program_arguments: bool,
) -> shell::Command {
    shell::Command {
        program: cargo_executable().into(),
        arguments: cargo_arguments(action, document, resolved, program_arguments),
        cwd,
    }
}

fn effective(document: &Value, resolved: &Resolved<'_>) -> String {
    match resolved.field("commandOverride").as_js_string() {
        Some(override_) => render(
            &override_.lossy(),
            &string_arguments(resolved.field("arguments")),
        ),
        None => render(
            cargo_executable(),
            &cargo_arguments("run", document, resolved, true),
        ),
    }
}

pub(super) fn discover(root: &Path, scope: &Scope) -> Result<Vec<Value>> {
    let collator = collator()?;
    let mut candidates = Vec::new();
    'packages: for package in manifest::scan(root, scope)? {
        for target in &package.targets {
            scope.check()?;
            candidates.push(candidate(&package, target)?);
            if candidates.len() >= 128 {
                break 'packages;
            }
        }
    }
    candidates.sort_by(|(left, a), (right, b)| {
        left.cmp(right).then_with(|| {
            collator.compare_utf16(
                a["document"]["name"].as_js_string().unwrap().units(),
                b["document"]["name"].as_js_string().unwrap().units(),
            )
        })
    });
    Ok(candidates
        .into_iter()
        .map(|(_, candidate)| candidate)
        .collect())
}

fn candidate(package: &Package, target: &Target) -> Result<(u8, Value)> {
    let default = package.default.as_deref() == Some(target.name.as_str());
    let conventional = target.kind == Kind::Binary && target.source == "src/main.rs";
    let only = package.targets.len() == 1;
    let rank = u8::from(!(default || conventional || only));
    let confidence = if rank == 0 { "high" } else { "medium" };
    let kind = target.kind.name();
    let name = if target.kind == Kind::Binary {
        format!("Rust {}: {}", package.name, target.name)
    } else {
        format!("Rust {} example: {}", package.name, target.name)
    };
    // Package and target names are validated ASCII.
    let name = &name[..name.len().min(200)];
    let reason = if default {
        format!(
            "{} is the default Cargo binary for {}.",
            target.name, package.name
        )
    } else if target.source == "src/main.rs" {
        format!(
            "{} has the conventional binary target {}.",
            package.name, target.source
        )
    } else if only {
        format!(
            "{} is the only runnable Cargo target discovered in {}.",
            target.name, package.name
        )
    } else {
        format!(
            "{} is a statically declared or conventional Cargo {kind} target in {}.",
            target.name, package.name
        )
    };
    let document = repository::document(&json!({
        "schema":"cantrip.run-configuration","version":1,"id":uuid::Uuid::new_v4().to_string(),
        "name":name,"provider":"rust","workingDirectory":package.directory,
        "target":json!({"kind":kind,"package":package.name,"name":target.name}),
        "options":json!({"features":target.features}),
    }))
    .map_err(|error| {
        anyhow!(
            "Cargo discovery produced an invalid Run definition: {}",
            error.body()
        )
    })?;
    let effective_command = effective(&document, &Resolved::new(&document));
    Ok((
        rank,
        json!({"provider":"rust","confidence":confidence,"reason":reason,"document":document,"effectiveCommand":effective_command}),
    ))
}
