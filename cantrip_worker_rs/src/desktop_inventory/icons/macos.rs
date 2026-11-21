use super::{CACHED_BYTES, SIZE, normalize_png, read_regular};
use crate::filesystem::Scope;
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub(super) async fn extract(application: &str, home: Option<&Path>) -> Option<Vec<u8>> {
    let bundle = bundle(application, home).await?;
    let contents = bundle.join("Contents");
    let resources = contents.join("Resources");
    let info = contents.join("Info.plist");
    let mut configured = None;
    for key in ["CFBundleIconFile", "CFBundleIconName"] {
        let output = command(
            "/usr/bin/plutil",
            vec![
                "-extract".into(),
                key.into(),
                "raw".into(),
                "-o".into(),
                "-".into(),
                info.as_os_str().into(),
            ],
        )
        .await;
        if let Some(name) = output.as_deref().and_then(icon_name) {
            configured = Some(name);
            break;
        }
    }
    let source = configured
        .and_then(|name| {
            [
                resources.join(&name),
                resources.join(format!("{name}.icns")),
            ]
            .into_iter()
            .find(|path| path.is_file())
        })
        .or_else(|| {
            fs::read_dir(resources)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .find(|entry| entry.extension() == Some(OsStr::new("icns")) && entry.is_file())
        })?;
    if !fs::metadata(&source)
        .ok()
        .is_some_and(|file| file.is_file() && file.len() <= 32 * 1024 * 1024)
    {
        return None;
    }
    let temporary = tempfile::tempdir().ok()?;
    let output = temporary.path().join("icon.png");
    command(
        "/usr/bin/sips",
        vec![
            "-s".into(),
            "format".into(),
            "png".into(),
            "-Z".into(),
            SIZE.to_string().into(),
            source.into_os_string(),
            "--out".into(),
            output.as_os_str().into(),
        ],
    )
    .await?;
    normalize_png(&read_regular(&output, CACHED_BYTES)?)
}

fn icon_name(data: &[u8]) -> Option<String> {
    let name = std::str::from_utf8(data).ok()?.trim();
    if !single_component(name) {
        return None;
    }
    Some(name.to_owned())
}

fn single_component(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

async fn bundle(application: &str, home: Option<&Path>) -> Option<PathBuf> {
    let name = application.strip_suffix(".app").unwrap_or(application);
    let path = Path::new(application);
    if path.is_absolute() && path.extension() == Some(OsStr::new("app")) && path.is_dir() {
        return Some(path.to_owned());
    }
    if !single_component(name) {
        return None;
    }
    let exact = format!("{name}.app");
    let roots = [
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(path) = roots
        .into_iter()
        .chain(home.map(|home| home.join("Applications")))
        .map(|root| root.join(&exact))
        .find(|path| path.is_dir())
    {
        return Some(path);
    }
    let name = name.replace('\\', "\\\\").replace('"', "\\\"");
    let query = format!(
        "kMDItemContentType == \"com.apple.application-bundle\" && (kMDItemDisplayName == \"{name}\"cd || kMDItemFSName == \"{name}.app\"cd || kMDItemCFBundleIdentifier == \"{name}\"cd)"
    );
    let results = command("/usr/bin/mdfind", vec!["-0".into(), query.into()]).await?;
    std::str::from_utf8(&results)
        .ok()?
        .split('\0')
        .map(PathBuf::from)
        .find(|path| {
            path.is_absolute() && path.extension() == Some(OsStr::new("app")) && path.is_dir()
        })
}

async fn command(program: &str, arguments: Vec<OsString>) -> Option<Vec<u8>> {
    let output = Scope::default()
        .capture_timeout(
            OsStr::new(program),
            &arguments,
            CACHED_BYTES,
            Duration::from_secs(5),
        )
        .await
        .ok()?;
    (output.code == Some(0) && output.overflow.is_none() && !output.timed_out)
        .then_some(output.stdout)
}
