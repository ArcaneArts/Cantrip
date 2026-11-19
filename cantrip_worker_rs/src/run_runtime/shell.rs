use super::{Environment, Failure};
use crate::{filesystem::paths, platform};
use cantrip_wire::{Value, value::json};
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
    if document["provider"] != "shell" {
        return Err(Failure::new(
            "provider",
            "provider-unavailable",
            "This Run configuration provider is unavailable on the native worker.",
            true,
        ));
    }
    let selected = &document["platformOverrides"][platform::platform()];
    let option = |key| {
        selected["options"]
            .get(key)
            .unwrap_or(&document["options"][key])
    };
    let field = |key| selected.get(key).unwrap_or(&document[key]);
    let shell = option("shell")
        .as_str()
        .expect("normalized shell configuration");
    let login = option("login")
        .as_bool()
        .expect("normalized shell configuration");
    let cwd = located(target, field("workingDirectory"), true)
        .map_err(|message| Failure::new("provider", "working-directory-invalid", message, true))?;
    let quoted = |text: &str| quote(text, shell);
    let mut text = if let Some(text) = field("commandOverride").as_js_string() {
        text.lossy().into_owned()
    } else if document["target"]["kind"] == "command" {
        document["target"]["command"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned()
    } else {
        let path = located(target, &document["target"]["path"], false)
            .map_err(|message| Failure::new("provider", "script-invalid", message, true))?;
        let prefix = match document["target"]["interpreter"].as_js_string() {
            Some(interpreter) => format!("{interpreter} "),
            None if cfg!(windows) && shell != "cmd" => "& ".to_owned(),
            None => String::new(),
        };
        format!("{prefix}{}", quoted(&path.to_string_lossy()))
    };
    for argument in field("arguments").as_array().unwrap() {
        text.push(' ');
        text.push_str(&quoted(&argument.as_js_string().unwrap().lossy()));
    }
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
    let environment = &document["environment"];
    let env_field = |key| {
        selected["environment"]
            .get(key)
            .unwrap_or(&environment[key])
    };
    let environment = json!({
        "includeCodexEnvironment":env_field("includeCodexEnvironment"),"files":env_field("files"),
        "variables":env_field("variables"),"secrets":env_field("secrets"),
    });
    Ok(Launch {
        main,
        before,
        environment,
    })
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

fn located(root: &Path, field: &Value, directory: bool) -> Result<PathBuf, &'static str> {
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
