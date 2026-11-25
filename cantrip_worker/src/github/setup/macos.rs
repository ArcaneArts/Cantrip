use super::{Client, Scope, installer};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, copy},
    os::unix::fs::PermissionsExt,
    path::Path,
    time::Duration,
};
use tokio::process::Command;

const VERSION: &str = "2.105.0";
const MAX_ARCHIVE: usize = 24 * 1024 * 1024;
const MAX_BINARY: u64 = 80 * 1024 * 1024;

impl Client {
    pub(super) async fn install_macos(&self, git: bool, cli: bool, scope: &Scope) -> Result<()> {
        let git_result = if git {
            open_git_installer(scope).await
        } else {
            Ok(())
        };
        if cli {
            install_gh(scope)
                .await
                .context("Could not install GitHub CLI on this Mac.")?;
        }
        git_result
    }
}

async fn open_git_installer(scope: &Scope) -> Result<()> {
    let mut command = Command::new("/usr/bin/xcode-select");
    command.arg("--install");
    let result = scope
        .capture_configured(installer(command), 64 * 1024, Duration::from_secs(15), None)
        .await?;
    ensure!(
        result.code == Some(0),
        "Could not open the Git installer. Complete any open Command Line Tools installer, or run `xcode-select --install` on the worker."
    );
    Ok(())
}

async fn install_gh(scope: &Scope) -> Result<()> {
    let directory = crate::filesystem::programs::user_git_tool_directory()
        .context("The worker has no home directory.")?;
    let (arch, expected) = match std::env::consts::ARCH {
        "aarch64" => (
            "arm64",
            "2a5d03103ae444927383b93d9ffd65579a26e2eb900ce1cf11f55258d5319ded",
        ),
        "x86_64" => (
            "amd64",
            "23602cbccbbdc6285a8520745b714cb927ce2ca621779373c2a20cd8e33fda66",
        ),
        _ => anyhow::bail!("This Mac's processor is unsupported."),
    };
    let asset = format!("gh_{VERSION}_macOS_{arch}");
    let bytes = tokio::select! {
        _ = scope.stopped() => anyhow::bail!("GitHub CLI setup stopped."),
        result = download(&asset) => result?,
    };
    scope.check()?;
    tokio::task::spawn_blocking(move || install_archive(&bytes, &asset, expected, &directory))
        .await??;
    Ok(())
}

async fn download(asset: &str) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(120))
        .build()?;
    let mut response = client
        .get(format!(
            "https://github.com/cli/cli/releases/download/v{VERSION}/{asset}.zip"
        ))
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= MAX_ARCHIVE,
            "The GitHub CLI download is too large."
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn archive_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn install_archive(bytes: &[u8], asset: &str, expected: &str, directory: &Path) -> Result<()> {
    ensure!(
        archive_digest(bytes) == expected,
        "The GitHub CLI download failed its checksum check."
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut binary = archive.by_name(&format!("{asset}/bin/gh"))?;
    ensure!(
        binary.is_file() && binary.size() <= MAX_BINARY,
        "The GitHub CLI archive has an invalid executable."
    );
    std::fs::create_dir_all(directory)?;
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    copy(&mut binary, &mut staged)?;
    staged
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o755))?;
    staged.persist_noclobber(directory.join("gh")).context(
        "A GitHub CLI executable already exists in ~/.local/bin. Repair it and check again.",
    )?;
    Ok(())
}

#[test]
fn pinned_archive_installs_only_gh_and_preserves_existing_binary() -> Result<()> {
    use std::io::Write;
    let root = tempfile::tempdir()?;
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive.start_file("asset/bin/gh", zip::write::SimpleFileOptions::default())?;
    archive.write_all(b"test gh")?;
    archive.start_file(
        "asset/share/other",
        zip::write::SimpleFileOptions::default(),
    )?;
    archive.write_all(b"ignored")?;
    let bytes = archive.finish()?.into_inner();
    let expected = archive_digest(&bytes);
    let binary = root.path().join("gh");
    assert!(install_archive(&bytes, "asset", "wrong checksum", root.path()).is_err());
    assert!(!binary.exists());
    install_archive(&bytes, "asset", &expected, root.path())?;
    assert_eq!(std::fs::read(&binary)?, b"test gh");
    assert_eq!(
        std::fs::metadata(&binary)?.permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
    assert!(install_archive(&bytes, "asset", &expected, root.path()).is_err());
    assert_eq!(std::fs::read(&binary)?, b"test gh");
    Ok(())
}
