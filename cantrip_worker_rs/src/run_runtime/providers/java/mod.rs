mod scan;

use super::{
    Environment, Failure, Launch, Resolved, diagnose_shell, environment, executable_diagnostic,
    executable_file, issue, layers, quote_argument, render, sdk, shell, string_arguments,
    tool_invocation,
};
use crate::{
    filesystem::{Scope, paths},
    run_definitions::{collator, repository},
};
use anyhow::{Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{JsString, Value, value::json};
use scan::{Build, Module, System};
use std::path::{Path, PathBuf};

const GRADLE_MAIN: &str = "_cantripRunConfigurationJava";
const MAVEN_EXEC: &str = "org.codehaus.mojo:exec-maven-plugin:3.5.1:java";
const JDK_ABSOLUTE: &str =
    "The selected JDK home must be an absolute path for the target platform.";

#[derive(Clone, Copy)]
enum Target<'a> {
    GradleTask {
        project: &'a str,
        task: &'a str,
    },
    GradleMain {
        project: &'a str,
        class: &'a str,
    },
    MavenGoal {
        module: Option<&'a str>,
        goal: &'a str,
    },
    MavenMain {
        module: Option<&'a str>,
        class: &'a str,
    },
}

impl<'a> Target<'a> {
    fn read(document: &'a Value) -> Self {
        let target = &document["target"];
        match target["kind"].as_str().unwrap() {
            "gradleTask" => Self::GradleTask {
                project: target["projectPath"].as_str().unwrap(),
                task: target["task"].as_str().unwrap(),
            },
            "gradleMainClass" => Self::GradleMain {
                project: target["projectPath"].as_str().unwrap(),
                class: target["className"].as_str().unwrap(),
            },
            "mavenGoal" => Self::MavenGoal {
                module: target["module"].as_str(),
                goal: target["goal"].as_str().unwrap(),
            },
            "mavenMainClass" => Self::MavenMain {
                module: target["module"].as_str(),
                class: target["className"].as_str().unwrap(),
            },
            _ => unreachable!("validated Java Run target"),
        }
    }

    fn system(self) -> System {
        match self {
            Self::GradleTask { .. } | Self::GradleMain { .. } => System::Gradle,
            Self::MavenGoal { .. } | Self::MavenMain { .. } => System::Maven,
        }
    }

    fn selector(self) -> Option<&'a str> {
        match self {
            Self::GradleTask { project, .. } | Self::GradleMain { project, .. } => Some(project),
            Self::MavenGoal { module, .. } | Self::MavenMain { module, .. } => module,
        }
    }
}

pub(super) fn materialize(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    let resolved = Resolved::new(document);
    let target = Target::read(document);
    let cwd = shell::located(root, resolved.field("workingDirectory"), true)
        .map_err(|message| Failure::new("provider", "working-directory-invalid", message, true))?;
    let custom = resolved.field("commandOverride").as_js_string();
    let executable = if custom.is_none() || provider_tasks(document) {
        let system = target.system();
        let program = if use_wrapper(&resolved) {
            wrapper(root, &resolved, system)
                .map_err(|message| {
                    Failure::new("provider", "build-wrapper-invalid", message, true)
                })?
                .to_string_lossy()
                .into_owned()
        } else {
            system.executable().to_owned()
        };
        Some(program)
    } else {
        None
    };
    let mut scratch = None;
    let main = if let Some(command) = custom {
        shell::invocation(
            cwd.clone(),
            render(
                &command.lossy(),
                &string_arguments(resolved.field("arguments")),
            ),
            "automatic",
            true,
            baseline,
        )?
    } else {
        let mut launcher = None;
        if matches!(target, Target::GradleMain { .. }) {
            let (directory, script) = gradle_launcher()?;
            scratch = Some(directory);
            launcher = Some(script);
        }
        tool_invocation(
            cwd.clone(),
            executable.as_deref().unwrap(),
            build_arguments(target, &resolved, launcher.as_deref()),
            baseline,
        )?
    };
    let mut before = Vec::new();
    for step in steps(document) {
        if step["kind"] == "providerTask" {
            before.push(tool_invocation(
                cwd.clone(),
                executable.as_deref().unwrap(),
                task_arguments(target, &resolved, step["task"].as_str().unwrap()),
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
    let mut launch = Launch::new(main, before, environment(document));
    if let Some(home) = resolved.option("jdkHome").as_js_string() {
        let home = paths::native(home);
        require_absolute_jdk(&home)
            .map_err(|message| Failure::new("provider", "jdk-home-invalid", message, true))?;
        // Preserve a canonical selection when present. The actual tool reports
        // an unusable runtime in its own environment.
        let home = paths::canonical_sync(&home).unwrap_or(home);
        launch
            .additions
            .insert("JAVA_HOME".into(), home.to_string_lossy().into_owned());
    }
    if let Some(vm) = tool_options(target, &resolved) {
        launch.additions.insert("JAVA_TOOL_OPTIONS".into(), vm);
    }
    launch.scratch = scratch;
    Ok(launch)
}

fn gradle_launcher() -> Result<(tempfile::TempDir, PathBuf), Failure> {
    let create = || -> std::io::Result<_> {
        let directory = tempfile::Builder::new()
            .prefix("cantrip-run-java-provider-")
            .tempdir()?;
        let path = directory.path().join("java-main.gradle");
        cantrip_host::files::write_private(&path, include_bytes!("main.gradle"))?;
        Ok((directory, path))
    };
    create().map_err(|_| {
        Failure::new(
            "provider",
            "gradle-launcher-unavailable",
            "The worker Java launcher could not be materialized safely.",
            true,
        )
    })
}

pub(super) fn validate(
    document: &Value,
    root: &Path,
    baseline: &Environment,
    scope: &Scope,
) -> Result<(String, Vec<Value>)> {
    let resolved = Resolved::new(document);
    let target = Target::read(document);
    let custom = !resolved.field("commandOverride").is_null();
    let needs_tool = !custom || provider_tasks(document);
    let mut diagnostics = Vec::new();
    let cwd = shell::located(root, resolved.field("workingDirectory"), true);
    if let Err(message) = cwd {
        diagnostics.push(issue(
            "working-directory-invalid",
            message,
            "workingDirectory",
        ));
    }
    let jdk = resolved.option("jdkHome").as_js_string();
    if let Some(jdk) = jdk
        && let Err(message) = inspect_jdk(&paths::native(jdk))
    {
        diagnostics.push(issue("jdk-home-invalid", &message, "options.jdkHome"));
    }
    if cwd.is_ok() {
        if !custom {
            diagnostics.extend(target_diagnostic(target, &resolved, root, scope)?);
        }
        if needs_tool {
            if jdk.is_none() {
                diagnostics.extend(default_jdk_diagnostic(root, baseline));
            }
            let system = target.system();
            if use_wrapper(&resolved) {
                if let Err(message) = wrapper(root, &resolved, system).and_then(|file| {
                    executable_file(&file)
                        .then_some(())
                        .ok_or("The selected build wrapper is not executable.")
                }) {
                    diagnostics.push(issue(
                        "build-wrapper-invalid",
                        message,
                        "options.useWrapper",
                    ));
                }
            } else {
                diagnostics.extend(executable_diagnostic(
                    system.executable(),
                    "options.useWrapper",
                    root,
                    baseline,
                ));
            }
        }
    }
    for (index, step) in steps(document).iter().enumerate() {
        if step["kind"] == "command" {
            let field = format!("beforeLaunch[{index}]");
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
    Ok((effective(target, &resolved), diagnostics))
}

fn target_diagnostic(
    target: Target<'_>,
    resolved: &Resolved<'_>,
    root: &Path,
    scope: &Scope,
) -> Result<Option<Value>> {
    let working = resolved
        .field("workingDirectory")
        .as_js_string()
        .unwrap()
        .lossy();
    let system = target.system();
    let builds = scan::project(root, scope)?;
    let Some(build) = builds
        .iter()
        .find(|build| build.system == system && build.directory == working)
    else {
        return Ok(Some(issue(
            &format!("{}-build-missing", system.name()),
            &format!(
                "The start directory does not contain a discovered {} build root.",
                system.label()
            ),
            "workingDirectory",
        )));
    };
    let selected = target.selector();
    let Some(module) = build.module(selected) else {
        let (label, field) = match system {
            System::Gradle => ("project", "target.projectPath"),
            System::Maven => ("module", "target.module"),
        };
        return Ok(Some(issue(
            &format!("{}-module-missing", system.name()),
            &format!(
                "The selected {label} {} was not found in the build.",
                selected.unwrap_or("(root)")
            ),
            field,
        )));
    };
    Ok(match target {
        Target::GradleMain { class, .. } | Target::MavenMain { class, .. }
            if !module.mains.iter().any(|entry| entry.class == class) =>
        {
            Some(issue(
                "java-main-class-missing",
                &format!("The Java main class {class} was not found in the selected module."),
                "target.className",
            ))
        }
        Target::MavenGoal { goal, .. }
            if goal.split(':').count() < 4 && !module.tasks.iter().any(|task| task == goal) =>
        {
            Some(issue(
                "maven-goal-missing",
                &format!("The Maven application goal {goal} was not found in the selected module."),
                "target.goal",
            ))
        }
        _ => None,
    })
}

fn wrapper(root: &Path, resolved: &Resolved<'_>, system: System) -> Result<PathBuf, &'static str> {
    let directory = resolved
        .field("workingDirectory")
        .as_js_string()
        .unwrap()
        .lossy();
    shell::located(
        root,
        &json!(scan::join(&directory, system.wrapper())),
        false,
    )
}

fn require_absolute_jdk(home: &Path) -> Result<(), &'static str> {
    paths::absolute(home).then_some(()).ok_or(JDK_ABSOLUTE)
}

fn inspect_jdk(home: &Path) -> Result<(), String> {
    require_absolute_jdk(home)?;
    let home = sdk::canonical(home)?;
    if !home.is_dir() {
        return Err("The selected JDK home is not a directory.".into());
    }
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let java = sdk::canonical(&home.join("bin").join(exe))?;
    if !executable_file(&java) {
        return Err("The selected JDK home does not contain a Java executable.".into());
    }
    Ok(())
}

fn default_jdk_diagnostic(root: &Path, baseline: &Environment) -> Option<Value> {
    if let Some(home) = layers::env_value(baseline, "JAVA_HOME")
        .filter(|value| !cantrip_wire::text::trim(value).is_empty())
    {
        return inspect_jdk(Path::new(home)).err().map(|message| issue(
            "java-home-invalid",
            &format!("JAVA_HOME does not identify a usable Java runtime. {message} Correct the launch environment or select a JDK home."),
            "options.jdkHome",
        ));
    }
    executable_diagnostic("java", "options.jdkHome", root, baseline)
}

fn steps(document: &Value) -> &[Value] {
    document["beforeLaunch"].as_array().unwrap()
}

fn provider_tasks(document: &Value) -> bool {
    steps(document)
        .iter()
        .any(|step| step["kind"] == "providerTask")
}

fn use_wrapper(resolved: &Resolved<'_>) -> bool {
    resolved.option("useWrapper").as_bool().unwrap()
}

fn qualified_task(project: &str, task: &str) -> String {
    if project == ":" || task.starts_with(':') {
        task.to_owned()
    } else {
        format!("{project}:{task}")
    }
}

fn use_module(arguments: &mut Vec<String>, module: Option<&str>) {
    if let Some(module) = module {
        arguments.extend(["-pl".into(), module.into(), "-am".into()]);
    }
}

fn task_arguments(target: Target<'_>, resolved: &Resolved<'_>, task: &str) -> Vec<String> {
    let mut arguments = string_arguments(resolved.option("buildToolArguments"));
    let selector = target.selector();
    match target.system() {
        System::Gradle => arguments.push(qualified_task(selector.unwrap(), task)),
        System::Maven => {
            use_module(&mut arguments, selector);
            arguments.push(task.into());
        }
    }
    arguments
}

fn build_arguments(
    target: Target<'_>,
    resolved: &Resolved<'_>,
    launcher: Option<&Path>,
) -> Vec<String> {
    let mut arguments = string_arguments(resolved.option("buildToolArguments"));
    let program = string_arguments(resolved.field("arguments"));
    let quoted = || {
        program
            .iter()
            .map(|arg| quote_argument(arg))
            .collect::<Vec<_>>()
            .join(" ")
    };
    match target {
        Target::GradleTask { project, task } => {
            arguments.push(qualified_task(project, task));
            if !program.is_empty() && matches!(task, "run" | "bootRun") {
                arguments.push(format!("--args={}", quoted()));
            } else {
                arguments.extend(program);
            }
        }
        Target::GradleMain { project, class } => {
            let script = launcher.map_or_else(
                || "<cantrip-java-init.gradle>".into(),
                |path| path.to_string_lossy(),
            );
            arguments.extend([
                "--init-script".into(),
                script.into_owned(),
                format!("-PcantripMainClass={class}"),
            ]);
            if launcher.is_some() {
                for (property, value) in [
                    ("cantripArguments", resolved.field("arguments")),
                    ("cantripVmArguments", resolved.option("vmArguments")),
                ] {
                    arguments.push(format!(
                        "-P{property}={}",
                        STANDARD.encode(value.stringify())
                    ));
                }
            }
            arguments.push(qualified_task(project, GRADLE_MAIN));
            if launcher.is_none() && !program.is_empty() {
                arguments.push("--".into());
                arguments.extend(program);
            }
        }
        Target::MavenGoal { module, goal } => {
            use_module(&mut arguments, module);
            arguments.push(goal.into());
            if !program.is_empty() {
                if goal == "spring-boot:run" {
                    arguments.push(format!("-Dspring-boot.run.arguments={}", quoted()));
                } else if goal.ends_with("exec:java") {
                    arguments.push(format!("-Dexec.args={}", quoted()));
                } else {
                    arguments.extend(program);
                }
            }
        }
        Target::MavenMain { module, class } => {
            use_module(&mut arguments, module);
            arguments.extend([MAVEN_EXEC.into(), format!("-Dexec.mainClass={class}")]);
            if !program.is_empty() {
                arguments.push(format!("-Dexec.args={}", quoted()));
            }
        }
    }
    arguments
}

fn tool_options(target: Target<'_>, resolved: &Resolved<'_>) -> Option<String> {
    if resolved.field("commandOverride").is_null() && matches!(target, Target::GradleMain { .. }) {
        return None;
    }
    let mut values = string_arguments(resolved.option("vmArguments"));
    if values.is_empty() {
        return None;
    }
    for value in &mut values {
        if value.contains('"') || value.chars().any(cantrip_wire::text::whitespace) {
            *value = format!("\"{}\"", value.replace('"', "\\\""));
        }
    }
    Some(values.join(" "))
}

fn effective(target: Target<'_>, resolved: &Resolved<'_>) -> String {
    let command = if let Some(command) = resolved.field("commandOverride").as_js_string() {
        render(
            &command.lossy(),
            &string_arguments(resolved.field("arguments")),
        )
    } else {
        let system = target.system();
        let tool = if use_wrapper(resolved) {
            if cfg!(windows) {
                system.wrapper().into()
            } else {
                format!("./{}", system.wrapper())
            }
        } else {
            system.executable().into()
        };
        render(&tool, &build_arguments(target, resolved, None))
    };
    let mut prefixes = Vec::new();
    if let Some(home) = resolved.option("jdkHome").as_js_string() {
        prefixes.push(("JAVA_HOME", home.lossy().into_owned()));
    }
    if let Some(vm) = tool_options(target, resolved) {
        prefixes.push(("JAVA_TOOL_OPTIONS", vm));
    }
    let mut rendered = String::new();
    for (name, value) in prefixes {
        if cfg!(windows) {
            rendered.push_str(&format!(
                "set \"{name}={}\" && ",
                value.replace('"', "\"\"")
            ));
        } else {
            rendered.push_str(&format!("{name}={} ", quote_argument(&value)));
        }
    }
    rendered.push_str(&command);
    rendered
}

pub(super) fn discover(root: &Path, scope: &Scope) -> Result<Vec<Value>> {
    let collator = collator()?;
    let mut candidates = Vec::new();
    'builds: for build in scan::project(root, scope)? {
        let use_wrapper = shell::located(
            root,
            &json!(scan::join(&build.directory, build.system.wrapper())),
            false,
        )
        .is_ok_and(|file| executable_file(&file));
        for module in &build.modules {
            let label = module_label(&build, module);
            for main in &module.mains {
                scope.check()?;
                let declared = module.declared.as_deref() == Some(main.class.as_str());
                let medium = !declared && module.mains.len() != 1;
                let tool = build.system.label();
                let simple = main.class.rsplit('.').next().unwrap();
                let reason = if declared {
                    format!(
                        "{tool} declares {} as the application main class in {label}.",
                        main.class
                    )
                } else {
                    format!("{} contains a Java main method in {label}.", main.file)
                };
                let target = match build.system {
                    System::Gradle => {
                        json!({"kind":"gradleMainClass","projectPath":module.selector,"className":main.class})
                    }
                    System::Maven => {
                        json!({"kind":"mavenMainClass","module":module.selector,"className":main.class})
                    }
                };
                candidates.push(candidate(
                    &build,
                    use_wrapper,
                    medium,
                    &format!("{tool} {label}: {simple}"),
                    reason,
                    target,
                )?);
                if candidates.len() == 128 {
                    break 'builds;
                }
            }
            for task in &module.tasks {
                scope.check()?;
                let tool = build.system.label();
                let medium = !matches!(task.as_str(), "run" | "bootRun" | "spring-boot:run");
                let target = match build.system {
                    System::Gradle => {
                        json!({"kind":"gradleTask","projectPath":module.selector,"task":task})
                    }
                    System::Maven => {
                        json!({"kind":"mavenGoal","module":module.selector,"goal":task})
                    }
                };
                candidates.push(candidate(
                    &build,
                    use_wrapper,
                    medium,
                    &format!("{tool} {label}: {task}"),
                    format!("{tool} declares the {task} application target in {label}."),
                    target,
                )?);
                if candidates.len() == 128 {
                    break 'builds;
                }
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

fn module_label<'a>(build: &Build, module: &'a Module) -> &'a str {
    match build.system {
        System::Gradle => module.selector.as_deref().unwrap_or(":"),
        System::Maven => module
            .artifact
            .as_deref()
            .or(module.selector.as_deref())
            .unwrap_or("root"),
    }
}

fn candidate(
    build: &Build,
    use_wrapper: bool,
    medium: bool,
    name: &str,
    reason: String,
    target: Value,
) -> Result<(bool, Value)> {
    let name = JsString::new(name.encode_utf16().take(200).collect());
    let document = repository::document(&json!({
        "schema":"cantrip.run-configuration","version":1,"id":uuid::Uuid::new_v4().to_string(),
        "name":name,"provider":"java","workingDirectory":build.directory,
        "target":target,"options":json!({"useWrapper":use_wrapper}),
    }))
    .map_err(|error| {
        anyhow!(
            "Java discovery produced an invalid Run definition: {}",
            error.body()
        )
    })?;
    let effective_command = effective(Target::read(&document), &Resolved::new(&document));
    let confidence = if medium { "medium" } else { "high" };
    Ok((
        medium,
        json!({
            "provider":"java","confidence":confidence,"reason":reason,"document":document,
            "effectiveCommand":effective_command,
        }),
    ))
}
