mod manifest;

use super::{
    Environment, Failure, Launch, Resolved, diagnose_shell, environment, executable_diagnostic,
    issue, render, shell, string_arguments,
};
use crate::{
    filesystem::Scope,
    run_definitions::{collator, repository},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, value::json};
use manifest::Manifest;
use std::{
    cell::OnceCell,
    path::{Path, PathBuf},
};

pub(super) fn materialize(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    let resolved = Resolved::new(document);
    let cwd = shell::located(root, resolved.field("workingDirectory"), true)
        .map_err(|message| provider_failure("working-directory-invalid", message))?;
    let manifest = OnceCell::new();
    let arguments = string_arguments(resolved.field("arguments"));
    let manager = option(&resolved, "packageManager");
    let target = &document["target"];
    let main = if let Some(command) = resolved.field("commandOverride").as_js_string() {
        shell::invocation(
            cwd.clone(),
            render(&command.lossy(), &arguments),
            "automatic",
            true,
            baseline,
        )?
    } else if target["kind"] == "packageScript" {
        let script = target["script"].as_js_string().unwrap();
        require_script(package(&manifest, &cwd), script)?;
        package_command(cwd.clone(), manager, &script.lossy(), &arguments, baseline)?
    } else {
        let entry = shell::located(root, &target["path"], false)
            .map_err(|message| provider_failure("entrypoint-invalid", message))?;
        let mut runtime_args = string_arguments(resolved.option("runtimeArguments"));
        runtime_args.push(entry.to_string_lossy().into_owned());
        runtime_args.extend(arguments);
        shell::Command {
            program: runtime_program(option(&resolved, "runtime")),
            arguments: runtime_args,
            cwd: cwd.clone(),
        }
    };
    let mut before = Vec::new();
    for step in document["beforeLaunch"].as_array().unwrap() {
        if step["kind"] == "providerTask" {
            let task = step["task"].as_js_string().unwrap();
            require_script(package(&manifest, &cwd), task)?;
            before.push(package_command(
                cwd.clone(),
                manager,
                &task.lossy(),
                &[],
                baseline,
            )?);
        } else {
            let step_cwd = shell::located(root, &step["workingDirectory"], true)
                .map_err(|message| provider_failure("before-launch-command-invalid", message))?;
            before.push(shell::invocation(
                step_cwd,
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

fn provider_failure(code: &str, message: impl Into<String>) -> Failure {
    Failure::new("provider", code, message, true)
}

type Package = std::result::Result<Manifest, String>;

fn package<'a>(manifest: &'a OnceCell<Package>, cwd: &Path) -> &'a Package {
    manifest.get_or_init(|| Manifest::open(cwd))
}

fn script_problem(manifest: &Package, script: &JsString) -> Option<(&'static str, String)> {
    match manifest {
        Ok(manifest) if manifest.scripts.contains(script) => None,
        Ok(_) => Some((
            "package-script-missing",
            format!("package.json does not define the {script} script."),
        )),
        Err(message) => Some(("package-manifest-invalid", message.clone())),
    }
}

fn require_script(manifest: &Package, script: &JsString) -> Result<(), Failure> {
    script_problem(manifest, script).map_or(Ok(()), |(code, message)| {
        Err(provider_failure(code, message))
    })
}

pub(super) fn validate(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> (String, Vec<Value>) {
    let resolved = Resolved::new(document);
    let custom = !resolved.field("commandOverride").is_null();
    let target = &document["target"];
    let cwd = shell::located(root, resolved.field("workingDirectory"), true);
    let manifest = OnceCell::new();
    let script_diagnostic = |script: &Value, field: &str| {
        let package = manifest.get_or_init(|| match &cwd {
            Ok(cwd) => Manifest::open(cwd),
            Err(message) => Err((*message).to_owned()),
        });
        script_problem(package, script.as_js_string().unwrap())
            .map(|(code, message)| issue(code, &message, field))
    };
    let mut diagnostics = Vec::new();
    if let Err(message) = cwd {
        diagnostics.push(issue(
            "working-directory-invalid",
            message,
            "workingDirectory",
        ));
    }
    let mut package_required = !custom && target["kind"] == "packageScript";
    if !custom {
        if package_required {
            diagnostics.extend(script_diagnostic(&target["script"], "target.script"));
        } else {
            if let Err(message) = shell::located(root, &target["path"], false) {
                diagnostics.push(issue("entrypoint-invalid", message, "target.path"));
            }
            diagnostics.extend(executable_diagnostic(
                &runtime_program(option(&resolved, "runtime")),
                "options.runtime",
                root,
                baseline,
            ));
        }
    }
    for (index, step) in document["beforeLaunch"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let field = format!("beforeLaunch[{index}]");
        if step["kind"] == "providerTask" {
            let issue = script_diagnostic(&step["task"], &format!("{field}.task"));
            package_required |= issue.is_none();
            diagnostics.extend(issue);
        } else {
            match shell::located(root, &step["workingDirectory"], true) {
                Err(message) => {
                    diagnostics.push(issue("before-launch-command-invalid", message, &field))
                }
                Ok(_) => diagnose_shell(
                    root,
                    baseline,
                    &field,
                    "before-launch-command-invalid",
                    &mut diagnostics,
                ),
            }
        }
    }
    if package_required {
        let manager = option(&resolved, "packageManager");
        if let Some(diagnostic) = executable_diagnostic(
            &package_program(manager),
            "options.packageManager",
            root,
            baseline,
        ) {
            diagnostics.push(diagnostic);
        } else if manager != "bun" {
            diagnostics.extend(executable_diagnostic(
                &runtime_program("node"),
                "options.packageManager",
                root,
                baseline,
            ));
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
    (effective(document, &resolved), diagnostics)
}

fn option<'a>(resolved: &Resolved<'a>, name: &str) -> &'a str {
    resolved.option(name).as_str().unwrap()
}

fn package_arguments(script: &str, values: &[String]) -> Vec<String> {
    let mut args = vec!["run".into(), script.to_owned()];
    if !values.is_empty() {
        args.push("--".into());
        args.extend_from_slice(values);
    }
    args
}

fn package_program(manager: &str) -> String {
    match (cfg!(windows), manager) {
        (true, "bun") => "bun.exe".into(),
        (true, other) => format!("{other}.cmd"),
        (false, manager) => manager.to_owned(),
    }
}

fn runtime_program(runtime: &str) -> String {
    if cfg!(windows) {
        format!("{runtime}.exe")
    } else {
        runtime.to_owned()
    }
}

fn package_command(
    cwd: PathBuf,
    manager: &str,
    script: &str,
    values: &[String],
    baseline: &Environment,
) -> Result<shell::Command, Failure> {
    let program = package_program(manager);
    let arguments = package_arguments(script, values);
    if cfg!(windows) && program.ends_with(".cmd") {
        shell::invocation(cwd, render(&program, &arguments), "cmd", false, baseline)
    } else {
        Ok(shell::Command {
            program,
            arguments,
            cwd,
        })
    }
}

fn effective(document: &Value, resolved: &Resolved<'_>) -> String {
    let arguments = string_arguments(resolved.field("arguments"));
    if let Some(command) = resolved.field("commandOverride").as_js_string() {
        return render(&command.lossy(), &arguments);
    }
    if document["target"]["kind"] == "packageScript" {
        let script = document["target"]["script"].as_js_string().unwrap().lossy();
        render(
            option(resolved, "packageManager"),
            &package_arguments(&script, &arguments),
        )
    } else {
        let mut combined = string_arguments(resolved.option("runtimeArguments"));
        combined.push(
            document["target"]["path"]
                .as_js_string()
                .unwrap()
                .lossy()
                .into_owned(),
        );
        combined.extend(arguments);
        render(option(resolved, "runtime"), &combined)
    }
}

pub(super) fn discover(root: &Path, scope: &Scope) -> Result<Vec<Value>> {
    const MAX_CANDIDATES: usize = 128;
    let collator = collator()?;
    let mut candidates = Vec::new();
    for package in manifest::discover(root, scope)? {
        scope.check()?;
        let directory = &package.relative;
        let manifest = package.manifest;
        let top_level = directory.as_str() == Some(".");
        let label = manifest.name.clone().unwrap_or_else(|| {
            if top_level {
                "Node package".into()
            } else {
                directory.clone()
            }
        });
        let manager = manifest.package_manager(root, &package.absolute);
        let mut scripts = manifest.scripts.iter().collect::<Vec<_>>();
        scripts.sort_by(|left, right| {
            rank(left)
                .cmp(&rank(right))
                .then_with(|| collator.compare_utf16(left.units(), right.units()))
        });
        for script in scripts.into_iter().take(MAX_CANDIDATES - candidates.len()) {
            let rank = rank(script);
            candidates.push(candidate(
                directory,
                &label,
                script,
                manager,
                rank,
                format!("{label} defines the {script} package script."),
                json!({"kind":"packageScript","script":script}),
            )?);
        }
        let mut entries = manifest.entries.clone();
        for name in [
            "index.js",
            "index.mjs",
            "index.cjs",
            "server.js",
            "src/index.js",
            "src/index.mjs",
            "src/main.js",
        ] {
            if manifest::real_file(&package.absolute.join(name)) {
                entries.insert(name.into());
            }
        }
        for entry in entries {
            if candidates.len() >= MAX_CANDIDATES {
                break;
            }
            let target = json!(manifest::join(directory, &entry));
            if shell::located(root, &target, false).is_err() {
                continue;
            }
            let known = manifest.entries.contains(&entry);
            let (rank, reason) = if known {
                (0, format!("{label} declares {entry} as an entrypoint."))
            } else {
                (
                    1,
                    format!("{label} contains the likely entrypoint {entry}."),
                )
            };
            candidates.push(candidate(
                directory,
                &label,
                &entry,
                manager,
                rank,
                reason,
                json!({"kind":"entry","path":target}),
            )?);
        }
        if candidates.len() >= MAX_CANDIDATES {
            break;
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
    Ok(candidates.into_iter().map(|(_, value)| value).collect())
}

fn rank(script: &JsString) -> u8 {
    match script.as_str() {
        Some("start") => 0,
        Some("dev") => 1,
        _ => 2,
    }
}

fn candidate(
    directory: &JsString,
    label: &JsString,
    target_name: &JsString,
    manager: &str,
    rank: u8,
    reason: String,
    target: Value,
) -> Result<(u8, Value)> {
    let prefix = if directory.as_str() == Some(".") {
        "Run ".to_owned()
    } else {
        format!("{label}: ")
    };
    let name = JsString::new(
        prefix
            .encode_utf16()
            .chain(target_name.units().iter().copied())
            .take(200)
            .collect(),
    );
    let document = repository::document(&json!({
        "schema":"cantrip.run-configuration","version":1,"id":uuid::Uuid::new_v4().to_string(),
        "name":name,"provider":"node","workingDirectory":directory,"target":target,
        "options":json!({"packageManager":manager,"runtime":if manager == "bun" {"bun"} else {"node"}}),
    })).map_err(|error| anyhow!("Package discovery produced an invalid Run definition: {}", error.body()))?;
    let command = effective(&document, &Resolved::new(&document));
    Ok((
        rank,
        json!({"provider":"node","confidence":["high","medium","low"][rank as usize],
        "reason":reason,"document":document,"effectiveCommand":command}),
    ))
}
