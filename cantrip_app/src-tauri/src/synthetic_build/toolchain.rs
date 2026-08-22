use std::{
    env,
    ffi::OsString,
    fs::{self, File},
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use flate2::read::GzDecoder;
use reqwest::Client;
use semver::Version;
use sha2::{Digest, Sha256};
use tar::Archive;
use zip::ZipArchive;

use super::{first_version, SyntheticBuildError};
use crate::process_environment::{configure_desktop_child, desktop_path};

const NODE_VERSION: &str = "24.19.0";
pub(super) const RUST_VERSION: &str = "1.95.0";
const RUSTUP_VERSION: &str = "1.29.0";
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

struct ToolchainDownload {
    filename: &'static str,
    sha256: &'static str,
    url: &'static str,
}

struct ToolchainPlatform {
    id: &'static str,
    node_archive_root: &'static str,
    node_download: ToolchainDownload,
    rustup_download: ToolchainDownload,
}

#[derive(Clone, Debug)]
pub(super) struct SyntheticBuildToolchain {
    pub(super) cargo_home: PathBuf,
    pub(super) node: PathBuf,
    pub(super) node_version: String,
    pub(super) pnpm_cli: PathBuf,
    pub(super) pnpm_version: String,
    pub(super) rust_version: String,
    pub(super) rustup_home: PathBuf,
}

impl SyntheticBuildToolchain {
    pub(super) fn path(&self) -> Result<OsString, SyntheticBuildError> {
        let mut paths = vec![
            self.node
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf(),
            self.cargo_home.join("bin"),
        ];
        if let Some(system_path) = desktop_path() {
            paths.extend(env::split_paths(&system_path));
        }
        env::join_paths(paths).map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_toolchain_invalid",
                format!("Could not construct the private build-tool path: {error}"),
                false,
            )
        })
    }
}

fn platform() -> Result<ToolchainPlatform, SyntheticBuildError> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(ToolchainPlatform {
            id: "darwin-arm64",
            node_archive_root: "node-v24.19.0-darwin-arm64",
            node_download: ToolchainDownload {
                filename: "node-v24.19.0-darwin-arm64.tar.gz",
                sha256: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
                url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz",
            },
            rustup_download: ToolchainDownload {
                filename: "rustup-init-1.29.0-aarch64-apple-darwin",
                sha256: "aeb4105778ca1bd3c6b0e75768f581c656633cd51368fa61289b6a71696ac7e1",
                url: "https://static.rust-lang.org/rustup/archive/1.29.0/aarch64-apple-darwin/rustup-init",
            },
        })
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok(ToolchainPlatform {
            id: "win32-x64",
            node_archive_root: "node-v24.19.0-win-x64",
            node_download: ToolchainDownload {
                filename: "node-v24.19.0-win-x64.zip",
                sha256: "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
                url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
            },
            rustup_download: ToolchainDownload {
                filename: "rustup-init-1.29.0-x86_64-pc-windows-msvc.exe",
                sha256: "86478e53f769379d7f0ebfa7c9aa97cb76ca92233f79aa2cc0dbee2efaac73c7",
                url: "https://static.rust-lang.org/rustup/archive/1.29.0/x86_64-pc-windows-msvc/rustup-init.exe",
            },
        })
    } else {
        Err(SyntheticBuildError::unavailable())
    }
}

fn sha256(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

fn verify_download(
    contents: Vec<u8>,
    download: &ToolchainDownload,
) -> Result<Vec<u8>, SyntheticBuildError> {
    let actual = sha256(&contents);
    if actual != download.sha256 {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_checksum_mismatch",
            format!(
                "The downloaded private build tool did not match its pinned checksum (expected {}, received {}).",
                download.sha256, actual
            ),
            true,
        ));
    }
    Ok(contents)
}

async fn download(
    root: &Path,
    download: &ToolchainDownload,
) -> Result<Vec<u8>, SyntheticBuildError> {
    let cache = root.join("toolchains/downloads").join(download.filename);
    if let Ok(contents) = fs::read(&cache) {
        if let Ok(contents) = verify_download(contents, download) {
            return Ok(contents);
        }
        let _ = fs::remove_file(&cache);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10 * 60))
        .user_agent("Cantrip-Private-Build-Toolchain")
        .build()
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_toolchain_download_failed",
                format!("Could not prepare the private build-tool download: {error}"),
                true,
            )
        })?;
    let response = client
        .get(download.url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_toolchain_download_failed",
                format!("Could not download a private build tool: {error}"),
                true,
            )
        })?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
    {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_download_failed",
            "A private build-tool download exceeded the size limit.",
            false,
        ));
    }
    let contents = response.bytes().await.map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_toolchain_download_failed",
            format!("Could not read a private build-tool download: {error}"),
            true,
        )
    })?;
    if contents.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_download_failed",
            "A private build-tool download exceeded the size limit.",
            false,
        ));
    }
    let contents = verify_download(contents.to_vec(), download)?;
    if let Some(parent) = cache.parent() {
        fs::create_dir_all(parent).map_err(toolchain_io_error)?;
    }
    let temporary = cache.with_extension(format!("download-{}", std::process::id()));
    fs::write(&temporary, &contents).map_err(toolchain_io_error)?;
    fs::rename(&temporary, &cache).map_err(toolchain_io_error)?;
    Ok(contents)
}

fn toolchain_io_error(error: std::io::Error) -> SyntheticBuildError {
    SyntheticBuildError::new(
        "synthetic_toolchain_install_failed",
        format!("Could not prepare the private build toolchain: {error}"),
        true,
    )
}

fn node_paths(root: &Path, platform: &ToolchainPlatform) -> (PathBuf, PathBuf, PathBuf) {
    let directory = root
        .join("toolchains")
        .join(format!("node-v{NODE_VERSION}-{}", platform.id));
    if cfg!(target_os = "windows") {
        (
            directory.join("node.exe"),
            directory.join("node_modules/npm/bin/npm-cli.js"),
            directory,
        )
    } else {
        (
            directory.join("bin/node"),
            directory.join("lib/node_modules/npm/bin/npm-cli.js"),
            directory,
        )
    }
}

fn probe(mut command: Command) -> Option<String> {
    configure_desktop_child(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    (!stdout.is_empty())
        .then_some(stdout)
        .or_else(|| (!stderr.is_empty()).then_some(stderr))
}

fn exact_node_version(node: &Path) -> Option<String> {
    let mut command = Command::new(node);
    command.arg("--version");
    probe(command).filter(|version| {
        first_version(version)
            .is_some_and(|(major, minor, patch)| format!("{major}.{minor}.{patch}") == NODE_VERSION)
    })
}

fn extract_node(
    contents: &[u8],
    staging: &Path,
    platform: &ToolchainPlatform,
) -> Result<(), SyntheticBuildError> {
    if cfg!(target_os = "windows") {
        let mut archive = ZipArchive::new(Cursor::new(contents)).map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_toolchain_install_failed",
                format!("Could not open the private Node archive: {error}"),
                true,
            )
        })?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| {
                SyntheticBuildError::new(
                    "synthetic_toolchain_install_failed",
                    format!("Could not read the private Node archive: {error}"),
                    true,
                )
            })?;
            let relative = entry.enclosed_name().ok_or_else(|| {
                SyntheticBuildError::new(
                    "synthetic_toolchain_install_failed",
                    "The private Node archive contained an unsafe path.",
                    false,
                )
            })?;
            let target = staging.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(toolchain_io_error)?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(toolchain_io_error)?;
                }
                let mut output = File::create(target).map_err(toolchain_io_error)?;
                std::io::copy(&mut entry, &mut output).map_err(toolchain_io_error)?;
            }
        }
    } else {
        let decoder = GzDecoder::new(Cursor::new(contents));
        let mut archive = Archive::new(decoder);
        for entry in archive.entries().map_err(toolchain_io_error)? {
            let mut entry = entry.map_err(toolchain_io_error)?;
            if !entry.unpack_in(staging).map_err(toolchain_io_error)? {
                return Err(SyntheticBuildError::new(
                    "synthetic_toolchain_install_failed",
                    "The private Node archive contained an unsafe path.",
                    false,
                ));
            }
        }
    }
    let extracted = staging.join(platform.node_archive_root);
    if !extracted.is_dir() {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            "The private Node archive did not contain its expected root.",
            false,
        ));
    }
    Ok(())
}

async fn ensure_node(
    root: &Path,
    platform: &ToolchainPlatform,
) -> Result<(PathBuf, PathBuf, PathBuf, String), SyntheticBuildError> {
    let (node, npm_cli, directory) = node_paths(root, platform);
    if npm_cli.is_file() {
        if let Some(version) = exact_node_version(&node) {
            return Ok((node, npm_cli, directory, version));
        }
    }
    let contents = download(root, &platform.node_download).await?;
    let staging = root.join("toolchains").join(format!(
        ".node-{}-staging-{}",
        platform.id,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(toolchain_io_error)?;
    extract_node(&contents, &staging, platform)?;
    let extracted = staging.join(platform.node_archive_root);
    let _ = fs::remove_dir_all(&directory);
    fs::rename(&extracted, &directory).map_err(toolchain_io_error)?;
    let _ = fs::remove_dir_all(&staging);
    let version = exact_node_version(&node).ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            "The installed private Node executable did not report the pinned version.",
            false,
        )
    })?;
    if !npm_cli.is_file() {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            "The installed private Node toolchain did not contain npm.",
            false,
        ));
    }
    Ok((node, npm_cli, directory, version))
}

fn pnpm_version(package_manager: &str) -> Result<String, SyntheticBuildError> {
    let version = package_manager.strip_prefix("pnpm@").ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            "The selected commit does not declare a supported pnpm package manager.",
            false,
        )
    })?;
    let parsed = Version::parse(version).map_err(|_| {
        SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            "The selected commit declares an invalid pnpm version.",
            false,
        )
    })?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            "Synthetic builds require a stable pinned pnpm version.",
            false,
        ));
    }
    Ok(parsed.to_string())
}

fn probe_pnpm(node: &Path, cli: &Path, expected: &str) -> Option<String> {
    let mut command = Command::new(node);
    command.arg(cli).arg("--version");
    probe(command).filter(|version| {
        version
            .lines()
            .next()
            .is_some_and(|line| line.trim() == expected)
    })
}

fn ensure_pnpm(
    root: &Path,
    node: &Path,
    npm_cli: &Path,
    package_manager: &str,
) -> Result<(PathBuf, String), SyntheticBuildError> {
    let version = pnpm_version(package_manager)?;
    let directory = root.join("toolchains").join(format!("pnpm-{version}"));
    let cli = directory.join("node_modules/pnpm/bin/pnpm.cjs");
    if let Some(detected) = probe_pnpm(node, &cli, &version) {
        return Ok((cli, detected));
    }
    let staging = root
        .join("toolchains")
        .join(format!(".pnpm-{version}-staging-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(toolchain_io_error)?;
    let mut command = Command::new(node);
    command
        .arg(npm_cli)
        .args([
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--no-save",
            "--prefix",
        ])
        .arg(&staging)
        .arg(format!("pnpm@{version}"))
        .env("npm_config_cache", root.join("stores/npm"))
        .env("npm_config_update_notifier", "false");
    configure_desktop_child(&mut command);
    let output = command.output().map_err(toolchain_io_error)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            format!(
                "Could not install private pnpm {version}: {}",
                detail.trim()
            ),
            true,
        ));
    }
    let installed = staging.join("node_modules/pnpm/bin/pnpm.cjs");
    if !installed.is_file() {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            "The private pnpm package did not contain its CLI.",
            false,
        ));
    }
    let _ = fs::remove_dir_all(&directory);
    fs::rename(&staging, &directory).map_err(toolchain_io_error)?;
    let detected = probe_pnpm(node, &cli, &version).ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            "The installed private pnpm CLI did not report the pinned version.",
            false,
        )
    })?;
    Ok((cli, detected))
}

fn rust_paths(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let cargo_home = root.join("toolchains/cargo-home");
    let rustup_home = root.join("toolchains/rustup-home");
    let rustc = cargo_home.join("bin").join(if cfg!(target_os = "windows") {
        "rustc.exe"
    } else {
        "rustc"
    });
    (cargo_home, rustup_home, rustc)
}

fn private_rust_version(rustc: &Path, cargo_home: &Path, rustup_home: &Path) -> Option<String> {
    let mut command = Command::new(rustc);
    command
        .arg("--version")
        .env("CARGO_HOME", cargo_home)
        .env("RUSTUP_HOME", rustup_home)
        .env("RUSTUP_TOOLCHAIN", RUST_VERSION);
    probe(command).filter(|version| {
        first_version(version)
            .is_some_and(|(major, minor, patch)| format!("{major}.{minor}.{patch}") == RUST_VERSION)
    })
}

fn write_rustup_init(
    root: &Path,
    platform: &ToolchainPlatform,
    contents: &[u8],
) -> Result<PathBuf, SyntheticBuildError> {
    let bootstrap = root
        .join("toolchains/bootstrap")
        .join(platform.rustup_download.filename);
    if let Some(parent) = bootstrap.parent() {
        fs::create_dir_all(parent).map_err(toolchain_io_error)?;
    }
    fs::write(&bootstrap, contents).map_err(toolchain_io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bootstrap, fs::Permissions::from_mode(0o700))
            .map_err(toolchain_io_error)?;
    }
    Ok(bootstrap)
}

fn rustup_command(program: &Path, cargo_home: &Path, rustup_home: &Path) -> Command {
    let mut command = Command::new(program);
    configure_desktop_child(&mut command);
    command
        .env("CARGO_HOME", cargo_home)
        .env("RUSTUP_HOME", rustup_home)
        .env("RUSTUP_INIT_SKIP_PATH_CHECK", "yes");
    command
}

async fn ensure_rust(
    root: &Path,
    platform: &ToolchainPlatform,
) -> Result<(PathBuf, PathBuf, String), SyntheticBuildError> {
    let (cargo_home, rustup_home, rustc) = rust_paths(root);
    if let Some(version) = private_rust_version(&rustc, &cargo_home, &rustup_home) {
        return Ok((cargo_home, rustup_home, version));
    }
    let contents = download(root, &platform.rustup_download).await?;
    let bootstrap = write_rustup_init(root, platform, &contents)?;
    fs::create_dir_all(&cargo_home).map_err(toolchain_io_error)?;
    fs::create_dir_all(&rustup_home).map_err(toolchain_io_error)?;
    let mut install = rustup_command(&bootstrap, &cargo_home, &rustup_home);
    install.args([
        "-y",
        "--no-modify-path",
        "--profile",
        "minimal",
        "--default-toolchain",
        RUST_VERSION,
    ]);
    let output = install.output().map_err(toolchain_io_error)?;
    if !output.status.success() {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            format!(
                "Could not install the private Rust toolchain: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            true,
        ));
    }
    let rustup = cargo_home.join("bin").join(if cfg!(target_os = "windows") {
        "rustup.exe"
    } else {
        "rustup"
    });
    let mut components = rustup_command(&rustup, &cargo_home, &rustup_home);
    components.args([
        "toolchain",
        "install",
        RUST_VERSION,
        "--profile",
        "minimal",
        "--component",
        "clippy",
        "--component",
        "rustfmt",
        "--component",
        "rust-src",
    ]);
    let output = components.output().map_err(toolchain_io_error)?;
    if !output.status.success() {
        return Err(SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            format!(
                "Could not complete the private Rust toolchain: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            true,
        ));
    }
    let version = private_rust_version(&rustc, &cargo_home, &rustup_home).ok_or_else(|| {
        SyntheticBuildError::new(
            "synthetic_toolchain_install_failed",
            "The installed private Rust compiler did not report the pinned version.",
            false,
        )
    })?;
    Ok((cargo_home, rustup_home, version))
}

pub(super) async fn ensure(
    root: &Path,
    package_manager: &str,
) -> Result<SyntheticBuildToolchain, SyntheticBuildError> {
    let platform = platform()?;
    let (node, npm_cli, _node_directory, node_version) = ensure_node(root, &platform).await?;
    let (pnpm_cli, pnpm_version) = ensure_pnpm(root, &node, &npm_cli, package_manager)?;
    let (cargo_home, rustup_home, rust_version) = ensure_rust(root, &platform).await?;
    Ok(SyntheticBuildToolchain {
        cargo_home,
        node,
        node_version,
        pnpm_cli,
        pnpm_version,
        rust_version,
        rustup_home,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_pinned_pnpm_versions() {
        assert_eq!(pnpm_version("pnpm@11.15.1").unwrap(), "11.15.1");
        assert!(pnpm_version("npm@11.15.1").is_err());
        assert!(pnpm_version("pnpm@11.15.1-beta.1").is_err());
        assert!(pnpm_version("pnpm@../../escape").is_err());
    }

    #[test]
    fn rejects_downloads_that_do_not_match_the_manifest() {
        let download = ToolchainDownload {
            filename: "test",
            sha256: "cea23dd4b87e8b00d19fb9ccaaef93e97353c7353e2070f3baf05aeb3995dff4",
            url: "https://example.invalid/test",
        };
        assert!(verify_download(b"expected".to_vec(), &download).is_ok());
        assert!(verify_download(b"different".to_vec(), &download).is_err());
    }

    #[test]
    fn platform_manifest_is_pinned() {
        let platform = platform().unwrap();
        assert!(platform.node_download.url.contains(NODE_VERSION));
        assert!(platform.rustup_download.url.contains(RUSTUP_VERSION));
        assert_eq!(platform.node_download.sha256.len(), 64);
        assert_eq!(platform.rustup_download.sha256.len(), 64);
    }
}
