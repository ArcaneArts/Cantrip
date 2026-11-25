//! Resolve freshly installed Git tools even when this worker inherited an older PATH.
use std::{borrow::Cow, ffi::OsStr, path::PathBuf};

pub(crate) fn command(program: &OsStr) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(resolve(program));
    if program == "gh" && cfg!(any(target_os = "macos", windows)) {
        // GitHub CLI starts Git itself for cloning and credential setup.
        let git = resolve(OsStr::new("git"));
        if let Some(directory) = std::path::Path::new(&git)
            .parent()
            .filter(|path| path.is_absolute())
        {
            let current = std::env::var_os("PATH").unwrap_or_default();
            if let Ok(path) = std::env::join_paths(
                std::iter::once(directory.to_owned()).chain(std::env::split_paths(&current)),
            ) {
                command.env("PATH", path);
            }
        }
    }
    command
}

pub(crate) fn resolve(program: &OsStr) -> Cow<'_, OsStr> {
    let Some(name @ ("git" | "gh" | "winget")) = program.to_str() else {
        return Cow::Borrowed(program);
    };
    if !cfg!(any(target_os = "macos", windows)) {
        return Cow::Borrowed(program);
    }
    let executable = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&search_path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(&executable))
        .chain(installed_candidates(name, &executable))
        .find(|path| executable_file(path))
        .map_or(Cow::Borrowed(program), |path| {
            Cow::Owned(path.into_os_string())
        })
}

fn executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    metadata.is_file()
}

#[cfg(target_os = "macos")]
pub(crate) fn user_git_tool_directory() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin"))
}

#[cfg(target_os = "macos")]
fn installed_candidates(_name: &str, executable: &str) -> Vec<PathBuf> {
    [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .chain(user_git_tool_directory())
    .map(|directory| directory.join(executable))
    .collect()
}

#[cfg(windows)]
fn installed_candidates(name: &str, executable: &str) -> Vec<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let programs = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .chain(local.iter().map(|directory| directory.join("Programs")));
    match name {
        "git" => programs
            .map(|directory| directory.join("Git/cmd").join(executable))
            .collect(),
        "gh" => programs
            .map(|directory| directory.join("GitHub CLI").join(executable))
            .chain(
                local
                    .iter()
                    .map(|directory| directory.join("Microsoft/WinGet/Links").join(executable)),
            )
            .collect(),
        _ => local
            .iter()
            .map(|directory| directory.join("Microsoft/WindowsApps").join(executable))
            .collect(),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn installed_candidates(_name: &str, _executable: &str) -> Vec<PathBuf> {
    Vec::new()
}
