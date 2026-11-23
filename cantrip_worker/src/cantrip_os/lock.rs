//! The same local, process-owned lock used by pnpm os and the Node worker.
use super::operations::sha256;
use crate::filesystem::Scope;
use anyhow::{Context, Result};
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    time::Duration,
};

pub(super) struct InstanceLock {
    path: PathBuf,
    owner: String,
}

impl InstanceLock {
    pub async fn acquire(name: &str, scope: &Scope) -> Result<Self> {
        let keys = if cfg!(windows) {
            ["TEMP", "TMP", "TMPDIR"]
        } else {
            ["TMPDIR", "TMP", "TEMP"]
        };
        let temporary = keys
            .into_iter()
            .find_map(|key| env::var_os(key).filter(|value| !value.is_empty()))
            .map_or_else(env::temp_dir, PathBuf::from);
        let key = sha256(name.as_bytes());
        let path = temporary.join(format!("cantrip-os-{}.lock", &key[..20]));
        let owner = format!("{} {}", std::process::id(), uuid::Uuid::new_v4());
        let mut candidate = tempfile::NamedTempFile::new_in(temporary)?;
        candidate.write_all(owner.as_bytes())?;
        loop {
            scope.check()?;
            match fs::hard_link(candidate.path(), &path) {
                Ok(()) => return Ok(Self { path, owner }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let Some(current) = read(&path)? else {
                        continue;
                    };
                    let pid = current
                        .split_once(' ')
                        .context("Invalid OS instance lock.")?
                        .0
                        .parse::<u32>()?;
                    anyhow::ensure!(pid > 0, "Invalid OS instance lock PID.");
                    if !process_exists(pid)? {
                        // The PID is used only to observe liveness. Release
                        // only the same ownership record we just observed.
                        remove_owned(&path, &current)?;
                        continue;
                    }
                }
                Err(error) => return Err(error.into()),
            }
            tokio::select! {
                _ = scope.stopped() => anyhow::bail!("OS instance lock wait stopped."),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
        }
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = remove_owned(&self.path, &self.owner);
    }
}

fn read(path: &std::path::Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn remove_owned(path: &std::path::Path, owner: &str) -> io::Result<()> {
    if read(path)?.as_deref() == Some(owner) {
        match fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn process_exists(pid: u32) -> Result<bool> {
    if unsafe { libc::kill(i32::try_from(pid)?, 0) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error.into()),
    }
}

#[cfg(windows)]
fn process_exists(pid: u32) -> Result<bool> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        let error = io::Error::last_os_error();
        return match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_INVALID_PARAMETER) => Ok(false),
            _ if error.kind() == io::ErrorKind::PermissionDenied => Ok(true),
            _ => Err(error.into()),
        };
    }
    let result = unsafe { WaitForSingleObject(process, 0) };
    let error = io::Error::last_os_error();
    unsafe { CloseHandle(process) };
    match result {
        WAIT_OBJECT_0 => Ok(false),
        WAIT_TIMEOUT => Ok(true),
        _ => Err(error.into()),
    }
}
