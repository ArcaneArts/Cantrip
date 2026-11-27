//! The worker's private, versioned installation of Anthropic's Claude Code.
mod accounts;
pub(crate) mod inference;
mod release;
mod storage;
pub use accounts::{Profile, ProfileLease, SignIn};

use self::{
    release::{BINARY, Source},
    storage::{Installed, Pointer, Storage, private},
};
use crate::logging::Logs;
use anyhow::{Context, Result, ensure};
use cantrip_wire::value::json;
use std::{
    ffi::OsStr,
    fs::{self, File},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

const UPDATE_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

pub struct Manager {
    storage: Storage,
}

impl Manager {
    pub fn new(data: &Path) -> Self {
        Self {
            storage: Storage::new(data),
        }
    }

    pub async fn installation(&self) -> Result<Installation> {
        self.storage.prepare()?;
        if let Some(installation) = self.current().await? {
            return Ok(installation);
        }
        self.install(&Source::official()?, false).await?;
        self.current()
            .await?
            .context("Claude Code installation is unavailable.")
    }

    pub async fn run(&self, stop: &mut watch::Receiver<bool>, logs: &Logs) {
        let mut interval = tokio::time::interval(UPDATE_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if *stop.borrow() {
                return;
            }
            tokio::select! {
                _ = interval.tick() => {}
                _ = stop.changed() => return,
            }
            let result = tokio::select! {
                result = self.update_installed() => result,
                _ = stop.changed() => return,
            };
            if let Err(error) = result {
                logs.event(
                    "warn",
                    "Claude Code update did not complete",
                    json!({
                        "event": "claude-code.update.failed",
                        "subsystem": "claude-code",
                        "error": error.to_string()
                    }),
                );
            }
        }
    }

    async fn update_installed(&self) -> Result<()> {
        if self.storage.read()?.is_some() {
            self.install(&Source::official()?, true).await?;
        }
        Ok(())
    }

    async fn current(&self) -> Result<Option<Installation>> {
        let _lock = self.storage.lock("install.lock").await?;
        let Some(pointer) = self.storage.read()? else {
            return Ok(None);
        };
        match self.open(&pointer.active) {
            Ok(installation) => Ok(Some(installation)),
            Err(error) => {
                let previous = pointer.previous.context(error)?;
                let installation = self.open(&previous)?;
                self.storage.write(&Pointer {
                    active: previous,
                    previous: None,
                })?;
                Ok(Some(installation))
            }
        }
    }

    fn open(&self, installed: &Installed) -> Result<Installation> {
        let executable = self.storage.binary(installed)?;
        Ok(Installation {
            executable,
            version: installed.version,
            profiles: self.storage.root.join("profiles"),
            _lease: self.storage.lease(installed)?,
        })
    }

    async fn install(&self, source: &Source, update: bool) -> Result<()> {
        self.storage.prepare()?;
        // Only activation and lease acquisition need to exclude normal launches.
        let _updater = self.storage.lock("update.lock").await?;
        let current = self.current().await?;
        if !update && current.is_some() {
            return Ok(());
        }
        let version = source.latest().await?;
        if current
            .as_ref()
            .is_some_and(|current| current.version >= version)
        {
            let _lock = self.storage.lock("install.lock").await?;
            if let Some(pointer) = self.storage.read()? {
                self.storage.cleanup(&pointer)?;
            }
            return Ok(());
        }
        let release = source.release(version).await?;
        let stage = self.storage.stage()?;
        let binary = stage.path().join(BINARY);
        source.download(&release, &binary).await?;
        self.probe(&binary, version).await?;

        let _lock = self.storage.lock("install.lock").await?;
        let pointer = Pointer {
            active: Installed::from(&release),
            previous: self.storage.read()?.map(|pointer| pointer.active),
        };
        if pointer
            .previous
            .as_ref()
            .is_none_or(|previous| previous.checksum != pointer.active.checksum)
        {
            self.storage.promote(stage.path(), &pointer.active)?;
        }
        self.storage.write(&pointer)?;
        self.storage.cleanup(&pointer)?;
        Ok(())
    }

    async fn probe(&self, executable: &Path, version: release::Version) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(executable, fs::Permissions::from_mode(0o700))?;
        }
        let home = tempfile::tempdir_in(self.storage.root.join("staging"))?;
        let mut command = command(
            &crate::filesystem::paths::canonical_sync(executable)?,
            home.path(),
        )?;
        command.arg("--version").kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output())
            .await
            .context("Claude Code version check timed out.")??;
        let reported = std::str::from_utf8(&output.stdout)?
            .split_whitespace()
            .next();
        ensure!(
            output.status.success() && reported == Some(version.to_string().as_str()),
            "The downloaded Claude Code binary did not start or reported the wrong version."
        );
        Ok(())
    }
}

/// Keep this lease alive until the child process exits or has been reaped.
pub struct Installation {
    executable: PathBuf,
    version: release::Version,
    profiles: PathBuf,
    _lease: File,
}

impl Installation {
    pub fn version(&self) -> String {
        self.version.to_string()
    }

    pub fn command(&self, profile: uuid::Uuid) -> Result<Command> {
        command(&self.executable, &self.profiles.join(profile.to_string()))
    }
}

fn command(executable: &Path, profile: &Path) -> Result<Command> {
    private(profile)?;
    let profile = crate::filesystem::paths::canonical_sync(profile)?;
    for name in ["config", "data", "cache", "state", "tmp"] {
        private(&profile.join(name))?;
    }

    let mut command = Command::new(executable);
    command.env_clear().current_dir(&profile);
    for name in [
        "SystemRoot",
        "WINDIR",
        "LANG",
        "LC_ALL",
        "TERM",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    if let Some(system) = std::env::var_os("SystemRoot") {
        command.env("PATH", PathBuf::from(system).join("System32"));
    }
    #[cfg(unix)]
    command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");

    command
        .env("HOME", &profile)
        .env("USERPROFILE", &profile)
        .env("APPDATA", profile.join("config"))
        .env("LOCALAPPDATA", profile.join("data"))
        .env("CLAUDE_CONFIG_DIR", profile.join("config"))
        .env("XDG_CONFIG_HOME", profile.join("config"))
        .env("XDG_DATA_HOME", profile.join("data"))
        .env("XDG_CACHE_HOME", profile.join("cache"))
        .env("XDG_STATE_HOME", profile.join("state"))
        .env("DISABLE_UPDATES", OsStr::new("1"))
        .env("TMPDIR", profile.join("tmp"))
        .env("TMP", profile.join("tmp"))
        .env("TEMP", profile.join("tmp"));
    Ok(command)
}

#[cfg(test)]
pub(crate) mod tests;
