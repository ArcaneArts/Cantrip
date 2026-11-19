use cantrip_wire::JsString;
use std::path::{Path, PathBuf};
/// Absolute inputs do not require a readable process working directory, just
/// as Node path.resolve stops once it encounters an absolute argument.
pub fn resolve(path: &Path) -> std::io::Result<PathBuf> {
    let cwd = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir()?
    };
    Ok(cantrip_config::resolve(&cwd, path))
}
pub fn absolute(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.has_root()
    }
    #[cfg(not(windows))]
    {
        path.is_absolute()
    }
}
pub fn native(value: &JsString) -> PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        std::ffi::OsString::from_wide(value.units()).into()
    }
    #[cfg(not(windows))]
    {
        value.lossy().into_owned().into()
    }
}
pub fn text(path: &Path) -> JsString {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        JsString::new(path.as_os_str().encode_wide().collect())
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().as_ref().into()
    }
}
pub async fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    Ok(strip_namespace(tokio::fs::canonicalize(path).await?))
}
pub(crate) fn canonical_sync(path: &Path) -> std::io::Result<PathBuf> {
    Ok(strip_namespace(std::fs::canonicalize(path)?))
}
fn strip_namespace(result: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = text(&result);
        let unc: Vec<_> = "\\\\?\\UNC\\".encode_utf16().collect();
        let prefix: Vec<_> = "\\\\?\\".encode_utf16().collect();
        if let Some(rest) = text.units().strip_prefix(unc.as_slice()) {
            return native(&JsString::new([&[92, 92][..], rest].concat()));
        }
        if let Some(rest) = text.units().strip_prefix(prefix.as_slice()) {
            return native(&JsString::new(rest.to_vec()));
        }
    }
    result
}
fn comparable(path: &Path) -> JsString {
    let normalized = cantrip_config::resolve(Path::new(""), path);
    #[cfg(windows)]
    {
        text(&normalized).lowercase()
    }
    #[cfg(not(windows))]
    {
        text(&normalized)
    }
}
pub fn equal(left: &Path, right: &Path) -> bool {
    comparable(left) == comparable(right)
}
pub fn within(root: &Path, candidate: &Path) -> bool {
    #[cfg(not(windows))]
    {
        candidate.starts_with(root)
    }
    #[cfg(windows)]
    {
        let root = comparable(root);
        let candidate = comparable(candidate);
        let mut prefix = root.units().to_vec();
        if prefix.last() != Some(&92) {
            prefix.push(92);
        }
        candidate == root || candidate.units().starts_with(&prefix)
    }
}
pub fn relative(root: &Path, candidate: &Path) -> JsString {
    if equal(root, candidate) {
        return ".".into();
    }
    // All callers have canonical descendants; split by component count to retain
    // Windows case-insensitive path.relative behavior and the candidate's case.
    let relative = candidate
        .components()
        .skip(root.components().count())
        .collect::<PathBuf>();
    #[cfg(windows)]
    {
        JsString::new(
            text(&relative)
                .units()
                .iter()
                .map(|&unit| if unit == 92 { 47 } else { unit })
                .collect(),
        )
    }
    #[cfg(not(windows))]
    {
        text(&relative)
    }
}
