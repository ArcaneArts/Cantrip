mod discovery;

use super::{
    Environment, Failure, Launch, Resolved, diagnose_shell, environment, executable_diagnostic,
    executable_file, issue, render, shell, string_arguments,
};
use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    io,
    path::{Path, PathBuf},
};

const SDK_ABSOLUTE: &str =
    "The selected Dart SDK home must be an absolute path for the target platform.";
const FLUTTER_PACKAGE: &str =
    "The start directory is a Flutter package; use a Flutter Run configuration.";
const TASK_UNSUPPORTED: &str =
    "Dart Run configurations support command before-launch steps, not provider tasks.";

pub(super) fn materialize(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    let resolved = Resolved::new(document);
    let cwd = shell::located(root, resolved.field("workingDirectory"), true)
        .map_err(|message| Failure::new("provider", "working-directory-invalid", message, true))?;
    let main = if resolved.field("commandOverride").is_null() {
        inspect_package(&cwd)
            .map_err(|(code, message)| Failure::new("provider", code, message, true))?;
        shell::located(root, &target_path(document, &resolved), false).map_err(|message| {
            Failure::new("provider", "dart-entrypoint-invalid", message, true)
        })?;
        let program = if let Some(home) = resolved.option("sdkHome").as_js_string() {
            let home = paths::native(home);
            if !paths::absolute(&home) {
                return Err(Failure::new(
                    "provider",
                    "dart-sdk-invalid",
                    SDK_ABSOLUTE,
                    true,
                ));
            }
            sdk_executable(&home).to_string_lossy().into_owned()
        } else {
            "dart".into()
        };
        shell::Command {
            program,
            arguments: dart_arguments(document, &resolved),
            cwd,
        }
    } else {
        shell::invocation(
            cwd,
            effective(document, &resolved),
            "automatic",
            true,
            baseline,
        )?
    };
    let mut before = Vec::new();
    for step in steps(document) {
        if step["kind"] == "providerTask" {
            return Err(Failure::new(
                "provider",
                "dart-provider-task-unsupported",
                TASK_UNSUPPORTED,
                false,
            ));
        }
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
) -> (String, Vec<Value>) {
    let resolved = Resolved::new(document);
    let custom = !resolved.field("commandOverride").is_null();
    let mut diagnostics = Vec::new();
    match shell::located(root, resolved.field("workingDirectory"), true) {
        Ok(cwd) if !custom => {
            if let Err((code, message)) = inspect_package(&cwd) {
                diagnostics.push(issue(code, message, "workingDirectory"));
            }
            if let Err(message) = shell::located(root, &target_path(document, &resolved), false) {
                diagnostics.push(issue("dart-entrypoint-invalid", message, "target.path"));
            }
            if let Some(home) = resolved.option("sdkHome").as_js_string() {
                if let Err(message) = inspect_sdk(&paths::native(home)) {
                    diagnostics.push(issue("dart-sdk-invalid", &message, "options.sdkHome"));
                }
            } else {
                diagnostics.extend(executable_diagnostic(
                    "dart",
                    "options.sdkHome",
                    root,
                    baseline,
                ));
            }
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
            diagnostics.push(issue(
                "dart-provider-task-unsupported",
                TASK_UNSUPPORTED,
                &field,
            ));
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
    (effective(document, &resolved), diagnostics)
}

fn inspect_package(cwd: &Path) -> Result<(), (&'static str, &'static str)> {
    let pubspec = discovery::read_pubspec(&cwd.join("pubspec.yaml")).ok_or((
        "dart-package-invalid",
        "The start directory does not contain a readable pubspec.yaml file.",
    ))?;
    if pubspec.name.is_none() {
        return Err((
            "dart-package-invalid",
            "pubspec.yaml does not declare a valid package name.",
        ));
    }
    if pubspec.flutter {
        return Err(("dart-package-is-flutter", FLUTTER_PACKAGE));
    }
    Ok(())
}

fn inspect_sdk(home: &Path) -> Result<(), String> {
    if !paths::absolute(home) {
        return Err(SDK_ABSOLUTE.into());
    }
    let home = canonical_sdk_path(home)?;
    if !home.is_dir() {
        return Err("The selected Dart SDK home is not a directory.".into());
    }
    let executable = canonical_sdk_path(&sdk_executable(&home))?;
    if !executable_file(&executable) {
        return Err("The selected Dart SDK home does not contain a Dart executable.".into());
    }
    Ok(())
}

fn canonical_sdk_path(path: &Path) -> Result<PathBuf, String> {
    paths::canonical_sync(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!(
                "ENOENT: no such file or directory, realpath '{}'",
                path.display()
            )
        } else {
            error.to_string()
        }
    })
}

fn sdk_executable(home: &Path) -> PathBuf {
    let program = if cfg!(windows) { "dart.exe" } else { "dart" };
    let path = home.join("bin").join(program);
    if paths::absolute(home) {
        cantrip_config::resolve(Path::new(""), &path)
    } else {
        path
    }
}

fn target_path(document: &Value, resolved: &Resolved<'_>) -> Value {
    let directory = resolved
        .field("workingDirectory")
        .as_js_string()
        .unwrap()
        .lossy();
    let target = document["target"]["path"].as_js_string().unwrap().lossy();
    json!(discovery::portable_join(&directory, &target))
}

fn dart_arguments(document: &Value, resolved: &Resolved<'_>) -> Vec<String> {
    let mut arguments = vec!["run".into()];
    arguments.extend(string_arguments(resolved.option("vmArguments")));
    arguments.push(
        document["target"]["path"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned(),
    );
    arguments.extend(string_arguments(resolved.field("arguments")));
    arguments
}

fn effective(document: &Value, resolved: &Resolved<'_>) -> String {
    if let Some(command) = resolved.field("commandOverride").as_js_string() {
        return render(
            &command.lossy(),
            &string_arguments(resolved.field("arguments")),
        );
    }
    let program = resolved.option("sdkHome").as_js_string().map_or_else(
        || "dart".into(),
        |home| {
            sdk_executable(&paths::native(home))
                .to_string_lossy()
                .into_owned()
        },
    );
    render(&program, &dart_arguments(document, resolved))
}

fn steps(document: &Value) -> &[Value] {
    document["beforeLaunch"].as_array().unwrap()
}

pub(super) fn discover(root: &Path, scope: &Scope) -> Result<Vec<Value>> {
    let collator = collator()?;
    let mut candidates = Vec::new();
    'packages: for package in discovery::scan(root, scope)? {
        for entrypoint in &package.entrypoints {
            scope.check()?;
            candidates.push(candidate(&package, entrypoint)?);
            if candidates.len() == 128 {
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

fn candidate(package: &discovery::Package, entrypoint: &str) -> Result<(bool, Value)> {
    let conventional =
        entrypoint == "bin/main.dart" || entrypoint == format!("bin/{}.dart", package.name);
    let only = package.entrypoints.len() == 1;
    let medium = !(conventional || only);
    let confidence = if medium { "medium" } else { "high" };
    let reason = if conventional {
        format!(
            "{} has the conventional Dart entrypoint {entrypoint}.",
            package.name
        )
    } else if only {
        format!(
            "{entrypoint} is the only Dart entrypoint discovered in {}.",
            package.name
        )
    } else {
        format!(
            "{entrypoint} declares a Dart main function in {}.",
            package.name
        )
    };
    let filename = entrypoint
        .rsplit('/')
        .next()
        .unwrap()
        .strip_suffix(".dart")
        .unwrap();
    let name = JsString::new(
        format!("Dart {}: {filename}", package.name)
            .encode_utf16()
            .take(200)
            .collect(),
    );
    let document = repository::document(&json!({
        "schema":"cantrip.run-configuration","version":1,"id":uuid::Uuid::new_v4().to_string(),
        "name":name,"provider":"dart","workingDirectory":package.directory,
        "target":json!({"kind":"entrypoint","path":entrypoint}),
    }))
    .map_err(|error| {
        anyhow!(
            "Dart discovery produced an invalid Run definition: {}",
            error.body()
        )
    })?;
    let effective_command = effective(&document, &Resolved::new(&document));
    Ok((
        medium,
        json!({"provider":"dart","confidence":confidence,"reason":reason,"document":document,"effectiveCommand":effective_command}),
    ))
}
