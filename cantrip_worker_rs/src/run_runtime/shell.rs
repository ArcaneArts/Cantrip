use super::{
    Environment, Failure,
    providers::{self, Resolved, executable_diagnostic, issue},
};
use crate::filesystem::paths;
use cantrip_wire::Value;
use std::path::{Path, PathBuf};

pub(super) struct Command {
    pub program: String,
    pub arguments: Vec<String>,
    pub cwd: PathBuf,
}

pub(super) struct Launch {
    pub main: Command,
    pub before: Vec<Command>,
    pub environment: Value,
}

pub(super) fn invocation(
    cwd: PathBuf,
    text: String,
    selected: &str,
    login: bool,
    baseline: &Environment,
) -> Result<Command, Failure> {
    let windows = cfg!(windows);
    let shell = match selected {
        "automatic" if windows => "powershell",
        "automatic" => super::layers::env_value(baseline, "SHELL")
            .filter(|value| !value.is_empty())
            .unwrap_or("/bin/sh"),
        other => other,
    };
    let (program, flags) = match (windows, shell) {
        (true, "powershell") => (
            "powershell.exe",
            &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"][..],
        ),
        (true, "cmd") => ("cmd.exe", &["/d", "/s", "/c"][..]),
        (false, "powershell" | "cmd") => {
            let name = if shell == "cmd" {
                "Command Prompt"
            } else {
                "PowerShell"
            };
            return Err(Failure::new(
                "provider",
                "shell-unavailable",
                format!("{name} Run configurations require Windows."),
                true,
            ));
        }
        (true, _) => {
            return Err(Failure::new(
                "provider",
                "shell-unavailable",
                "POSIX shell Run configurations are unavailable on Windows.",
                true,
            ));
        }
        (false, other) => (other, if login { &["-lc"][..] } else { &["-c"][..] }),
    };
    let mut arguments = flags
        .iter()
        .map(|flag| (*flag).to_owned())
        .collect::<Vec<_>>();
    arguments.push(text);
    Ok(Command {
        program: program.to_owned(),
        cwd,
        arguments,
    })
}

pub(super) fn materialize(
    document: &Value,
    target: &Path,
    baseline: &Environment,
) -> Result<Launch, Failure> {
    let resolved = Resolved::new(document);
    let (shell, login) = options(&resolved);
    let cwd = located(target, resolved.field("workingDirectory"), true)
        .map_err(|message| Failure::new("provider", "working-directory-invalid", message, true))?;
    let script = if uses_script(document, &resolved) {
        Some(
            located(target, &document["target"]["path"], false)
                .map_err(|message| Failure::new("provider", "script-invalid", message, true))?,
        )
    } else {
        None
    };
    let text = command_text(document, &resolved, script.as_deref());
    let main = invocation(cwd, text, shell, login, baseline)?;
    let mut before = Vec::new();
    for step in document["beforeLaunch"].as_array().unwrap() {
        if step["kind"] != "command" {
            return Err(Failure::new(
                "provider",
                "provider-task-unsupported",
                "Shell Run configurations do not support provider before-launch tasks.",
                true,
            ));
        }
        let directory = located(target, &step["workingDirectory"], true).map_err(|message| {
            Failure::new("provider", "before-launch-directory-invalid", message, true)
        })?;
        before.push(invocation(
            directory,
            step["command"].as_js_string().unwrap().lossy().into_owned(),
            shell,
            login,
            baseline,
        )?);
    }
    let environment = providers::environment(document);
    Ok(Launch {
        main,
        before,
        environment,
    })
}

fn options<'a>(resolved: &Resolved<'a>) -> (&'a str, bool) {
    (
        resolved.option("shell").as_str().unwrap(),
        resolved.option("login").as_bool().unwrap(),
    )
}

fn uses_script(document: &Value, resolved: &Resolved<'_>) -> bool {
    resolved.field("commandOverride").is_null() && document["target"]["kind"] == "script"
}

fn command_text(document: &Value, resolved: &Resolved<'_>, script: Option<&Path>) -> String {
    let (shell, _) = options(resolved);
    let mut text = if let Some(text) = resolved.field("commandOverride").as_js_string() {
        text.lossy().into_owned()
    } else if document["target"]["kind"] == "command" {
        document["target"]["command"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned()
    } else {
        let script = script.map_or_else(
            || document["target"]["path"].as_js_string().unwrap().lossy(),
            Path::to_string_lossy,
        );
        let prefix = match document["target"]["interpreter"].as_js_string() {
            Some(interpreter) => format!("{interpreter} "),
            None if cfg!(windows) && shell != "cmd" => "& ".to_owned(),
            None => String::new(),
        };
        format!("{prefix}{}", quote(&script, shell))
    };
    for argument in resolved.field("arguments").as_array().unwrap() {
        text.push(' ');
        text.push_str(&quote(&argument.as_js_string().unwrap().lossy(), shell));
    }
    text
}

pub(super) fn validate(
    document: &Value,
    root: &Path,
    baseline: &Environment,
) -> (String, Vec<Value>) {
    let resolved = Resolved::new(document);
    let mut diagnostics = Vec::new();
    if let Err(message) = located(root, resolved.field("workingDirectory"), true) {
        diagnostics.push(issue(
            "working-directory-invalid",
            message,
            "workingDirectory",
        ));
    }
    if uses_script(document, &resolved)
        && let Err(message) = located(root, &document["target"]["path"], false)
    {
        diagnostics.push(issue("script-invalid", message, "target.path"));
    }
    for (index, step) in document["beforeLaunch"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        if step["kind"] == "providerTask" {
            diagnostics.push(issue(
                "provider-task-unsupported",
                "Shell Run configurations do not support provider before-launch tasks.",
                &format!("beforeLaunch[{index}]"),
            ));
        } else if let Err(message) = located(root, &step["workingDirectory"], true) {
            diagnostics.push(issue(
                "before-launch-directory-invalid",
                message,
                &format!("beforeLaunch[{index}].workingDirectory"),
            ));
        }
    }
    let text = command_text(document, &resolved, None);
    let (shell, login) = options(&resolved);
    match invocation(root.to_owned(), text.clone(), shell, login, baseline) {
        Ok(command) => diagnostics.extend(executable_diagnostic(
            &command.program,
            "options.shell",
            root,
            baseline,
        )),
        Err(failure) => diagnostics.push(issue(
            "shell-unavailable",
            &failure.message,
            "options.shell",
        )),
    }
    (text, diagnostics)
}

fn quote(text: &str, shell: &str) -> String {
    if cfg!(windows) {
        if shell == "cmd" {
            if !text.is_empty()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_./:@+-".contains(&byte))
            {
                text.to_owned()
            } else {
                format!("\"{}\"", text.replace('"', "\"\""))
            }
        } else {
            format!("'{}'", text.replace('\'', "''"))
        }
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

pub(super) fn located(
    root: &Path,
    field: &Value,
    directory: bool,
) -> Result<PathBuf, &'static str> {
    let candidate = cantrip_config::resolve(root, &paths::native(field.as_js_string().unwrap()));
    let escape = if directory {
        "The working directory resolves outside the target root."
    } else {
        "The script resolves outside the target root."
    };
    if !paths::within(root, &candidate) {
        return Err(escape);
    }
    let metadata = std::fs::symlink_metadata(&candidate).ok();
    let Some(metadata) = metadata else {
        return Err(if directory {
            "The working directory does not exist."
        } else {
            "The script does not exist."
        });
    };
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(if directory {
            "The working directory must be a real directory."
        } else {
            "The script must be a real file."
        });
    }
    let canonical = paths::canonical_sync(&candidate).map_err(|_| escape)?;
    if !paths::within(root, &canonical) {
        return Err(escape);
    }
    Ok(canonical)
}
