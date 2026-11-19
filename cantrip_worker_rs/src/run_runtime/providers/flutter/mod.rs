mod devices;

use super::{
    Environment, Failure, Launch, Resolved,
    dart_source::{self, Package},
    diagnose_shell, environment, executable_diagnostic, issue, quote_argument, render, sdk, shell,
    string_arguments,
};
use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};

pub(crate) use devices::inspect_devices;

const SDK: sdk::Sdk = sdk::Sdk {
    name: "Flutter",
    program: if cfg!(windows) {
        "flutter.bat"
    } else {
        "flutter"
    },
};
const TASK_MESSAGE: &str = "Flutter provider tasks must be one of: clean, gen-l10n, or pub get.";

pub(super) fn materialize(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    let resolved = Resolved::new(document);
    let cwd = shell::located(root, resolved.field("workingDirectory"), true)
        .map_err(|message| Failure::new("provider", "working-directory-invalid", message, true))?;
    let custom = !resolved.field("commandOverride").is_null();
    let mut executable = SDK.program.to_owned();
    if !custom || has_provider_task(document) {
        inspect_package(&cwd).map_err(|message| {
            Failure::new("provider", "flutter-package-invalid", message, true)
        })?;
        if let Some(home) = resolved.option("sdkHome").as_js_string() {
            executable = SDK
                .configured(&paths::native(home))
                .map_err(|message| Failure::new("provider", "flutter-sdk-invalid", message, true))?
                .to_string_lossy()
                .into_owned();
        }
    }
    let main = if custom {
        shell::invocation(
            cwd.clone(),
            effective(document, &resolved),
            "automatic",
            true,
            baseline,
        )?
    } else {
        if let Some(invalid) = file_diagnostics(document, &resolved, root).first() {
            return Err(Failure::new(
                "provider",
                invalid["code"].as_str().unwrap(),
                invalid["message"].as_str().unwrap(),
                true,
            ));
        }
        tool_invocation(
            cwd.clone(),
            &executable,
            flutter_arguments(document, &resolved),
            baseline,
        )?
    };

    let mut before = Vec::new();
    for step in steps(document) {
        if step["kind"] == "providerTask" {
            let arguments = provider_task(step["task"].as_str().unwrap()).ok_or_else(|| {
                Failure::new(
                    "provider",
                    "flutter-provider-task-invalid",
                    TASK_MESSAGE,
                    false,
                )
            })?;
            before.push(tool_invocation(
                cwd.clone(),
                &executable,
                arguments.iter().map(|value| (*value).to_owned()).collect(),
                baseline,
            )?);
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
) -> (String, Vec<Value>) {
    let resolved = Resolved::new(document);
    let custom = !resolved.field("commandOverride").is_null();
    let mut diagnostics = Vec::new();
    match shell::located(root, resolved.field("workingDirectory"), true) {
        Ok(cwd) => {
            if !custom || has_provider_task(document) {
                if let Err(message) = inspect_package(&cwd) {
                    diagnostics.push(issue(
                        "flutter-package-invalid",
                        message,
                        "workingDirectory",
                    ));
                }
                if let Some(home) = resolved.option("sdkHome").as_js_string() {
                    if let Err(message) = SDK.inspect(&paths::native(home)) {
                        diagnostics.push(issue("flutter-sdk-invalid", &message, "options.sdkHome"));
                    }
                } else {
                    diagnostics.extend(executable_diagnostic(
                        SDK.program,
                        "options.sdkHome",
                        root,
                        baseline,
                    ));
                }
            }
            if !custom {
                diagnostics.extend(file_diagnostics(document, &resolved, root));
            }
        }
        Err(message) => diagnostics.push(issue(
            "working-directory-invalid",
            message,
            "workingDirectory",
        )),
    }
    for (index, step) in steps(document).iter().enumerate() {
        let field = format!("beforeLaunch[{index}]");
        if step["kind"] == "providerTask" {
            if provider_task(step["task"].as_str().unwrap()).is_none() {
                diagnostics.push(issue(
                    "flutter-provider-task-invalid",
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
    (effective(document, &resolved), diagnostics)
}

fn file_diagnostics(document: &Value, resolved: &Resolved<'_>, root: &Path) -> Vec<Value> {
    let mut diagnostics = Vec::new();
    let directory = resolved
        .field("workingDirectory")
        .as_js_string()
        .unwrap()
        .lossy();
    let mut inspect = |file: &Value, code, field: &str| {
        let path = dart_source::portable_join(&directory, &file.as_js_string().unwrap().lossy());
        if let Err(message) = shell::located(root, &json!(path), false) {
            diagnostics.push(issue(code, message, field));
        }
    };
    inspect(
        &document["target"]["path"],
        "flutter-entrypoint-invalid",
        "target.path",
    );
    for (index, file) in resolved
        .option("dartDefineFiles")
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        inspect(
            file,
            "flutter-dart-define-file-invalid",
            &format!("options.dartDefineFiles[{index}]"),
        );
    }
    diagnostics
}

fn inspect_package(cwd: &Path) -> Result<(), &'static str> {
    let pubspec = dart_source::read_pubspec(&cwd.join("pubspec.yaml"))
        .ok_or("The start directory does not contain a readable pubspec.yaml file.")?;
    if pubspec.name.is_none() {
        return Err("pubspec.yaml does not declare a valid package name.");
    }
    if !pubspec.flutter {
        return Err("pubspec.yaml does not declare the Flutter SDK dependency.");
    }
    Ok(())
}

fn tool_invocation(
    cwd: PathBuf,
    executable: &str,
    arguments: Vec<String>,
    baseline: &Environment,
) -> Result<shell::Command, Failure> {
    if cfg!(windows)
        && Path::new(executable).extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("bat") || extension.eq_ignore_ascii_case("cmd")
        })
    {
        shell::invocation(
            cwd,
            render(&quote_argument(executable), &arguments),
            "cmd",
            false,
            baseline,
        )
    } else {
        Ok(shell::Command {
            program: executable.to_owned(),
            arguments,
            cwd,
        })
    }
}

fn flutter_arguments(document: &Value, resolved: &Resolved<'_>) -> Vec<String> {
    let mode = resolved.option("mode").as_str().unwrap();
    let target = document["target"]["path"].as_js_string().unwrap().lossy();
    let mut arguments = vec![
        "run".into(),
        format!("--{mode}"),
        format!("--target={target}"),
    ];
    for (option, flag) in [("deviceId", "--device-id"), ("flavor", "--flavor")] {
        if let Some(value) = resolved.option(option).as_js_string() {
            arguments.push(format!("{flag}={}", value.lossy()));
        }
    }
    for define in resolved.option("dartDefines").as_array().unwrap() {
        let name = define["name"].as_js_string().unwrap().lossy();
        let value = define["value"].as_js_string().unwrap().lossy();
        arguments.push(format!("--dart-define={name}={value}"));
    }
    arguments.extend(
        string_arguments(resolved.option("dartDefineFiles"))
            .into_iter()
            .map(|file| format!("--dart-define-from-file={file}")),
    );
    arguments.push(
        if resolved.option("usePub").as_bool().unwrap() {
            "--pub"
        } else {
            "--no-pub"
        }
        .into(),
    );
    arguments.extend(
        string_arguments(resolved.field("arguments"))
            .into_iter()
            .map(|argument| format!("--dart-entrypoint-args={argument}")),
    );
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
        || "flutter".into(),
        |home| {
            SDK.executable(&paths::native(home))
                .to_string_lossy()
                .into_owned()
        },
    );
    render(
        &quote_argument(&program),
        &flutter_arguments(document, resolved),
    )
}

fn provider_task(task: &str) -> Option<&'static [&'static str]> {
    match task {
        "clean" => Some(&["clean"]),
        "gen-l10n" => Some(&["gen-l10n"]),
        "pub get" => Some(&["pub", "get"]),
        _ => None,
    }
}

fn steps(document: &Value) -> &[Value] {
    document["beforeLaunch"].as_array().unwrap()
}

fn has_provider_task(document: &Value) -> bool {
    steps(document)
        .iter()
        .any(|step| step["kind"] == "providerTask")
}

pub(super) fn discover(packages: &[Package], scope: &Scope) -> Result<Vec<Value>> {
    let collator = collator()?;
    let mut candidates = Vec::new();
    'packages: for package in packages.iter().filter(|package| package.flutter) {
        for entrypoint in &package.entrypoints {
            scope.check()?;
            candidates.push(candidate(package, entrypoint)?);
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

fn candidate(package: &Package, entrypoint: &str) -> Result<(bool, Value)> {
    let conventional = entrypoint == "lib/main.dart";
    let only = package.entrypoints.len() == 1;
    let medium = !(conventional || only);
    let confidence = if medium { "medium" } else { "high" };
    let reason = if conventional {
        format!(
            "{} has the conventional Flutter entrypoint {entrypoint}.",
            package.name
        )
    } else if only {
        format!(
            "{entrypoint} is the only likely Flutter entrypoint discovered in {}.",
            package.name
        )
    } else {
        format!(
            "{entrypoint} declares a top-level main function in {}.",
            package.name
        )
    };
    let filename = entrypoint
        .rsplit('/')
        .next()
        .unwrap()
        .strip_suffix(".dart")
        .unwrap();
    let flavor = package
        .default_flavor
        .as_ref()
        .map(|value| format!(" ({value})"))
        .unwrap_or_default();
    let name = JsString::new(
        format!("Flutter {}: {filename}{flavor}", package.name)
            .encode_utf16()
            .take(200)
            .collect(),
    );
    let document = repository::document(&json!({
        "schema":"cantrip.run-configuration","version":1,"id":uuid::Uuid::new_v4().to_string(),
        "name":name,"provider":"flutter","workingDirectory":package.directory,
        "target":json!({"kind":"entrypoint","path":entrypoint}),
        "options":json!({"flavor":package.default_flavor}),
    }))
    .map_err(|error| {
        anyhow!(
            "Flutter discovery produced an invalid Run definition: {}",
            error.body()
        )
    })?;
    let effective_command = effective(&document, &Resolved::new(&document));
    Ok((
        medium,
        json!({"provider":"flutter","confidence":confidence,"reason":reason,"document":document,"effectiveCommand":effective_command}),
    ))
}
