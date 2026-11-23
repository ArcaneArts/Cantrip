//! Configuration value/path normalization; no filesystem existence checks.
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Lexical Node path.resolve semantics: no existence or permission probing.
pub fn resolve(cwd: &Path, input: &Path) -> PathBuf {
    #[cfg(windows)]
    let path = {
        if let Some(Component::Prefix(prefix)) = input.components().next() {
            if !input.has_root() {
                let drive = prefix.as_os_str().to_string_lossy();
                let tail: PathBuf = input.components().skip(1).collect();
                let same_drive = cwd
                    .components()
                    .next()
                    .is_some_and(|v| v.as_os_str().to_string_lossy().eq_ignore_ascii_case(&drive));
                if same_drive {
                    cwd.join(tail)
                } else {
                    PathBuf::from(format!("{drive}\\")).join(tail)
                }
            } else {
                input.into()
            }
        } else {
            cwd.join(input)
        }
    };
    #[cfg(not(windows))]
    let path = cwd.join(input);
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}

// JSON.parse/Object.entries visits canonical array-index keys first, then the
// other keys in insertion order. Key-ring ordering survives the language port.
pub fn entries(object: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |key: &str| {
        key.parse::<u32>()
            .ok()
            .filter(|v| *v < u32::MAX && v.to_string() == key)
    };
    let mut entries: Vec<_> = object.iter().collect();
    entries.sort_by_key(|(key, _)| index(key).map_or((1, 0), |i| (0, i)));
    entries
}
