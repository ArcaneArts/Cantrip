use super::{archive::relative, source::cancelled, storage};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_browser::{Browser, Launch};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    ffi::OsString,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) fn discard_playwright_tooling(directory: &Path) -> Result<()> {
    // The original signed release contains the JavaScript driver and build smoke.
    if directory.join("node_modules").is_dir() {
        for (file, field) in [
            ("licenses/manifest.json", "packages"),
            ("sbom.cdx.json", "components"),
        ] {
            let path = directory.join(file);
            let mut manifest = parse_json_text(&storage::read_small(&path)?)
                .map_err(|_| anyhow::anyhow!("Managed Chromium inventory is invalid."))?;
            if let Value::Array(entries) = &mut manifest[field] {
                entries.retain(|entry| entry["name"] != "playwright-core");
                fs::write(path, manifest.stringify())?;
            }
        }
    }
    for path in ["node_modules", "launcher", "browsers/.links"] {
        match fs::remove_dir_all(directory.join(path)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub(super) fn inventory(
    directory: &Path,
    version: &str,
    artifact: Option<&Value>,
) -> Result<PathBuf> {
    storage::require_directory(directory)?;
    let inventory = [
        "licenses/manifest.json",
        "source/manifest.json",
        "sbom.cdx.json",
        "build-info.json",
        "certificates/ca-bundle.crt",
        "fontconfig/fonts.conf",
    ];
    for name in inventory {
        regular_below(directory, name)?;
    }
    if let Some(artifact) = artifact {
        for key in ["licenseManifest", "sourceManifest"] {
            regular_below(
                directory,
                artifact[key]
                    .as_str()
                    .context("Artifact inventory path is invalid.")?,
            )?;
        }
    }
    let info = parse_json_text(&storage::read_small(&directory.join("build-info.json"))?)
        .map_err(|_| anyhow::anyhow!("Managed Chromium build inventory is invalid."))?;
    ensure!(
        info["schemaVersion"] == 1
            && info["component"] == "playwright"
            && info["version"] == version
            && info["chromiumRevision"]
                .as_str()
                .is_some_and(|revision| !revision.is_empty()),
        "Managed Chromium build inventory does not match the release."
    );
    let binaries = directory.join("browsers");
    storage::require_directory(&binaries)?;
    let mut remaining = vec![binaries];
    let mut executable = None;
    while let Some(dir) = remaining.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                remaining.push(entry.path());
            } else if kind.is_file() && executable_name(&entry.file_name()) {
                ensure!(
                    executable.is_none(),
                    "Managed runtime contains multiple headless Chromium executables."
                );
                executable = Some(entry.path());
            }
        }
    }
    executable.context("Managed runtime has no headless Chromium executable.")
}

fn executable_name(name: &std::ffi::OsStr) -> bool {
    if cfg!(windows) {
        ["chrome-headless-shell.exe", "headless_shell.exe"]
            .iter()
            .any(|value| name == *value)
    } else {
        ["chrome-headless-shell", "headless_shell"]
            .iter()
            .any(|value| name == *value)
    }
}

pub(super) fn regular_below(root: &Path, name: &str) -> Result<()> {
    let file = root.join(relative(name)?);
    ensure!(
        fs::symlink_metadata(&file)?.is_file()
            && file.canonicalize()?.starts_with(root.canonicalize()?),
        "Managed Chromium inventory entry escaped its runtime or is not a regular file."
    );
    Ok(())
}

pub(super) async fn probe(
    binary: &Path,
    directory: &Path,
    base: &Path,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let scratch = tempfile::Builder::new().prefix("probe-").tempdir_in(base)?;
    let environment = environment(directory, scratch.path())?;
    let profile = scratch.path().join("profile");
    let browser = tokio::select! {
        _ = cancelled(&mut stop) => bail!("Managed Chromium health check stopped."),
        launched = Browser::launch(Launch {
            executable: binary, profile: &profile, viewport: (800, 600), environment: Some(&environment),
        }) => launched?,
    };
    let check = tokio::time::timeout(Duration::from_secs(15), async {
        let context = browser.new_context().await?;
        let page = browser.new_page(Some(&context)).await?;
        page.evaluate("(() => {const heading = document.createElement('h1');heading.textContent = 'Cantrip browser ready';document.body.append(heading)})()").await?;
        let tree = page
            .request("Accessibility.getFullAXTree", json!({}))
            .await?;
        ensure!(
            tree["nodes"]
                .as_array()
                .is_some_and(|nodes| nodes.iter().any(|node| {
                    node["role"]["value"] == "heading"
                        && node["name"]["value"] == "Cantrip browser ready"
                })),
            "Managed Chromium accessibility probe failed."
        );
        browser.close_context(&context).await
    });
    let result = tokio::select! {
        _ = cancelled(&mut stop) => Err(anyhow!("Managed Chromium health check stopped.")),
        result = check => result.context("Managed Chromium accessibility probe timed out.").and_then(|result| result),
    };
    let closed = browser.close().await;
    result?;
    closed?;
    Ok(())
}

pub(super) fn environment(runtime: &Path, state: &Path) -> Result<Vec<(OsString, OsString)>> {
    let mut environment = vec![("PATH".into(), OsString::new())];
    for directory in ["home", "tmp", "cache"] {
        storage::private(&state.join(directory))?;
    }
    for (key, relative) in [
        ("HOME", "home"),
        ("TMPDIR", "tmp"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("XDG_CACHE_HOME", "cache"),
    ] {
        environment.push((key.into(), state.join(relative).into_os_string()));
    }
    environment.push((
        "SSL_CERT_FILE".into(),
        runtime.join("certificates/ca-bundle.crt").into_os_string(),
    ));
    #[cfg(target_os = "linux")]
    for (key, relative) in [
        ("LD_LIBRARY_PATH", "libraries"),
        ("FONTCONFIG_PATH", "fontconfig"),
    ] {
        environment.push((key.into(), runtime.join(relative).into_os_string()));
    }
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        environment.push(("SystemRoot".into(), root));
    }
    Ok(environment)
}
