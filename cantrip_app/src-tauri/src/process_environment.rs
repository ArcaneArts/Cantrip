use std::process::Command;

#[cfg(target_os = "macos")]
use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[cfg(target_os = "macos")]
fn macos_path_additions(home: Option<&Path>) -> Vec<PathBuf> {
    let mut additions = Vec::new();
    if let Some(home) = home {
        additions.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join("Library/pnpm"),
            home.join(".local/share/pnpm"),
            home.join(".volta/bin"),
            home.join(".bun/bin"),
            home.join(".deno/bin"),
            home.join(".asdf/shims"),
            home.join(".mise/shims"),
        ]);
    }
    additions.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/opt/local/bin"),
        PathBuf::from("/opt/local/sbin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    additions
}

#[cfg(target_os = "macos")]
fn augment_path(current: Option<&OsStr>, home: Option<&Path>) -> OsString {
    let mut entries = current
        .map(env::split_paths)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut seen = entries.iter().cloned().collect::<HashSet<_>>();
    for addition in macos_path_additions(home) {
        if seen.insert(addition.clone()) {
            entries.push(addition);
        }
    }
    env::join_paths(entries).unwrap_or_else(|_| current.unwrap_or_default().to_os_string())
}

pub fn configure_desktop_child(command: &mut Command) {
    #[cfg(target_os = "macos")]
    {
        let current = env::var_os("PATH");
        let home = env::var_os("HOME").map(PathBuf::from);
        command.env("PATH", augment_path(current.as_deref(), home.as_deref()));
        if env::var_os("SHELL").is_none() {
            command.env("SHELL", "/bin/zsh");
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = command;
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::augment_path;
    use std::{env, ffi::OsStr, path::Path};

    fn entries(value: &OsStr) -> Vec<String> {
        env::split_paths(value)
            .map(|entry| entry.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn preserves_inherited_path_order_and_adds_gui_launch_locations() {
        let path = augment_path(
            Some(OsStr::new("/custom/bin:/usr/bin")),
            Some(Path::new("/Users/cantrip")),
        );
        let entries = entries(&path);
        assert_eq!(&entries[..2], ["/custom/bin", "/usr/bin"]);
        assert!(entries.contains(&"/Users/cantrip/.local/bin".to_string()));
        assert!(entries.contains(&"/Users/cantrip/Library/pnpm".to_string()));
        assert!(entries.contains(&"/opt/homebrew/bin".to_string()));
        assert!(entries.contains(&"/usr/local/bin".to_string()));
    }

    #[test]
    fn does_not_duplicate_inherited_locations() {
        let path = augment_path(
            Some(OsStr::new("/opt/homebrew/bin:/usr/bin")),
            Some(Path::new("/Users/cantrip")),
        );
        let entries = entries(&path);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.as_str() == "/opt/homebrew/bin")
                .count(),
            1
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.as_str() == "/usr/bin")
                .count(),
            1
        );
    }
}
