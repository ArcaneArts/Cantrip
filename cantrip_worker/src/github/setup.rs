//! Install only the fixed Git and GitHub CLI prerequisites on the selected worker.
use super::Client;
use crate::filesystem::{Scope, programs};
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
use std::{ffi::OsStr, time::Duration};
use tokio::process::Command;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn status(scope: &Scope) -> Result<Value> {
    let gh = programs::resolve(OsStr::new("gh"));
    let (git, cli) = tokio::join!(git_available(scope), available(&gh, scope));
    scope.check()?;
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "other",
    };
    let signin = sign_in_command(&gh);
    checked(
        "githubToolsStatusSchema",
        &json!({"platform":platform,"gitInstalled":git,"githubCliInstalled":cli,"signInCommand":signin}),
    )
}

fn sign_in_command(_gh: &OsStr) -> &'static str {
    #[cfg(target_os = "macos")]
    if programs::user_git_tool_directory()
        .is_some_and(|directory| directory.join("gh").as_os_str() == _gh)
    {
        return "~/.local/bin/gh auth login --hostname github.com --git-protocol https --web";
    }
    "gh auth login --hostname github.com --git-protocol https --web"
}

async fn git_available(scope: &Scope) -> bool {
    let git = programs::resolve(OsStr::new("git"));
    // Check the actual Git binary behind Apple's launcher without triggering
    // the install dialog on a background status check.
    if cfg!(target_os = "macos")
        && (git == OsStr::new("/usr/bin/git")
            || std::fs::canonicalize(&git)
                .is_ok_and(|path| path == std::path::Path::new("/usr/bin/git")))
    {
        let mut select = Command::new("/usr/bin/xcode-select");
        select.arg("--print-path");
        let Ok(selected) = scope
            .capture_configured(select, 8192, PROBE_TIMEOUT, None)
            .await
        else {
            return false;
        };
        if selected.code != Some(0) {
            return false;
        }
        let Ok(selected) = std::str::from_utf8(&selected.stdout) else {
            return false;
        };
        let git = std::path::Path::new(selected.trim_end()).join("usr/bin/git");
        return available(git.as_os_str(), scope).await;
    }
    available(&git, scope).await
}

async fn available(program: &OsStr, scope: &Scope) -> bool {
    let mut command = Command::new(program);
    command.arg("--version");
    scope
        .capture_configured(command, 64 * 1024, PROBE_TIMEOUT, None)
        .await
        .is_ok_and(|output| {
            output.code == Some(0) && !output.timed_out && output.overflow.is_none()
        })
}

impl Client {
    pub(crate) async fn setup_tools(&self, scope: &Scope) -> Result<Value> {
        let _installing = self.installing.try_lock().map_err(|_| {
            anyhow::anyhow!("Git tools are already being installed on this worker.")
        })?;
        let tools = status(scope).await?;
        let git = tools["gitInstalled"] != true;
        let cli = tools["githubCliInstalled"] != true;
        if !(git || cli) {
            return Ok(tools);
        }

        match tools["platform"].as_str() {
            Some("macos") => {
                #[cfg(target_os = "macos")]
                self.install_macos(git, cli, scope).await?;
            }
            Some("windows") => {
                if git {
                    install_windows("Git.Git", "Git", scope).await?;
                }
                if cli {
                    install_windows("GitHub.cli", "GitHub CLI", scope).await?;
                }
            }
            _ => bail!("Install Git and GitHub CLI on this worker, then check again."),
        }
        let updated = status(scope).await?;
        if updated["platform"] == "macos" && cli {
            ensure!(
                updated["githubCliInstalled"] == true,
                "GitHub CLI was installed but could not start. Check the executable at ~/.local/bin/gh on the worker."
            );
        }
        if updated["platform"] == "windows" {
            ensure!(
                updated["gitInstalled"] == true && updated["githubCliInstalled"] == true,
                "WinGet finished, but the worker could not find both tools. Restart the worker and check again."
            );
        }
        Ok(updated)
    }
}

fn windows_installer(package: &str) -> Command {
    let mut command = Command::new(programs::resolve(OsStr::new("winget")));
    command.args([
        "install",
        "--id",
        package,
        "--exact",
        "--source",
        "winget",
        "--no-upgrade",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
    ]);
    command
}

async fn install_windows(package: &str, label: &str, scope: &Scope) -> Result<()> {
    let output = scope.capture_configured(installer(windows_installer(package)), 256 * 1024, Duration::from_secs(10 * 60), None).await
        .with_context(|| format!("Could not start WinGet to install {label}. Install Microsoft App Installer on the worker and try again."))?;
    ensure!(
        !output.timed_out,
        "WinGet timed out installing {label}. Finish any installer prompts on the worker and check again."
    );
    ensure!(
        output.code == Some(0),
        "WinGet could not install {label}. Open App Installer on the worker or run `winget install --id {package} --exact --source winget` to see the error."
    );
    Ok(())
}

fn installer(mut command: Command) -> Command {
    command.env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN");
    command
}

#[cfg(target_os = "macos")]
mod macos;

#[test]
fn winget_installs_only_the_exact_requested_package_without_upgrading() {
    for package in ["Git.Git", "GitHub.cli"] {
        let command = windows_installer(package);
        let args: Vec<_> = command.as_std().get_args().collect();
        assert_eq!(
            &args[..7],
            &[
                "install",
                "--id",
                package,
                "--exact",
                "--source",
                "winget",
                "--no-upgrade"
            ]
        );
        assert!(args.contains(&OsStr::new("--disable-interactivity")));
    }
}
