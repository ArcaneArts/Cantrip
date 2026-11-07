//! Bounded, offline desktop upgrade. Serving remains entirely native. A legacy
//! JavaScript engine is used only after the actual native open of a private
//! physical copy fails; the active profile is never opened by either probe.
use super::{ActivationReceipt, activation, failure, files};
use crate::config::{DatabaseMode, Environment, ServerConfig};
use anyhow::{Context, Result, ensure};
use std::{
    io::Read,
    path::Path,
    process::{Command, ExitStatus, Stdio},
};

pub struct Options<'a> {
    pub environment: &'a Environment,
    pub cwd: &'a Path,
    pub executable: &'a Path,
    pub legacy_node: Option<&'a Path>,
    pub legacy_converter: Option<&'a Path>,
}

// Drain rather than log subprocess diagnostics: engine errors can contain SQL,
// private paths, or connection credentials. No unbounded output allocation.
fn drain(mut stream: impl Read) {
    let mut buffer = [0; 8192];
    while stream.read(&mut buffer).is_ok_and(|count| count != 0) {}
}
fn invoke(command: &mut Command, options: &Options<'_>) -> Result<ExitStatus> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .current_dir(options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Child::wait closes its stdin. Retain the owning pipe separately so the
    // child's parent-death watcher observes EOF only if this owner disappears.
    let _owner = child.stdin.take();
    let stdout = child.stdout.take().context("upgrade child stdout")?;
    let stderr = child.stderr.take().context("upgrade child stderr")?;
    let output = std::thread::spawn(move || drain(stdout));
    let errors = std::thread::spawn(move || drain(stderr));
    let result = child.wait();
    let _ = output.join();
    let _ = errors.join();
    Ok(result?)
}
fn native(options: &Options<'_>, root: &Path) -> Command {
    let mut command = Command::new(options.executable);
    command.envs(options.environment);
    command.args(["--migrate-only", "--shutdown-on-stdin-close", "--data-dir"]);
    command.arg(root).args(["--database", "pglite"]);
    command
}

pub fn prepare(options: Options<'_>) -> Result<Option<ActivationReceipt>> {
    let destination = ServerConfig::data_directory(options.environment, options.cwd);
    let result = activation::prepare_and_activate(&destination, || {
        // The exclusive lease has already recovered a pending activation. Read
        // backend configuration from that authoritative directory, not an old
        // snapshot that may have been absent during an interrupted rename.
        let mut environment = options.environment.clone();
        super::apply_database(&mut environment, options.cwd)?;
        let config = ServerConfig::read(&environment, options.cwd)?;
        if config.database_mode != DatabaseMode::Pglite || super::native_runtime(&destination) {
            return Ok(None);
        }
        match std::fs::read_dir(&destination) {
            Ok(_) => {}
            // The real source-directory read found no installation to convert.
            // Ordinary startup performs the new backend's actual initialization.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let parent = destination.parent().context("profile upgrade parent")?;
        let owner = tempfile::Builder::new()
            .prefix(".cantrip-profile-upgrade-")
            .tempdir_in(parent)?;
        let copy = owner.path().join("native-copy");
        files::copy_profile(&destination, &copy, owner.path())?;
        let status = invoke(
            native(&options, &copy).args(["--remember-database", "--upgrade-source-probe"]),
            &options,
        )?;
        if status.success() {
            return Ok(Some((copy, owner)));
        }
        ensure!(
            status.code() == Some(78),
            "Native profile preparation failed; the active profile was retained."
        );
        let node = options.legacy_node.context(
            "The native PGlite open failed. Supply --legacy-node and --legacy-profile-converter for bounded offline conversion; the active profile was retained.",
        )?;
        let converter = options.legacy_converter.context(
            "The native PGlite open failed. Supply --legacy-profile-converter for bounded offline conversion; the active profile was retained.",
        )?;
        eprintln!(
            "{}",
            serde_json::json!({"event":"profile.upgrade.legacy-conversion.started"})
        );
        let bundle = owner.path().join("logical-profile");
        let mut conversion = Command::new(options.executable);
        conversion
            .envs(options.environment)
            .arg("--internal-profile-converter-owner")
            .arg(node)
            .arg(converter)
            .arg(&destination)
            .arg(&bundle)
            .arg(options.executable)
            .env("TMPDIR", owner.path())
            .env("TMP", owner.path())
            .env("TEMP", owner.path());
        ensure!(
            invoke(&mut conversion, &options)?.success(),
            "Legacy profile export failed; the active profile was retained."
        );
        let prepared = owner.path().join("converted-profile");
        ensure!(
            invoke(
                native(&options, &prepared)
                    .arg("--restore-profile")
                    .arg(&bundle),
                &options
            )?
            .success(),
            "Native logical profile restore failed; the active profile was retained."
        );
        // Retain an unselected private PostgreSQL directory too. The logical
        // bundle intentionally excludes physical engines; this copy has never
        // been opened by the PGlite preparation operation.
        match std::fs::rename(copy.join("postgres"), prepared.join("postgres")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Some((prepared, owner)))
    });
    result.map_err(|error| failure(error, "preparing the existing installation"))
}

/// Pipe ownership also applies to offline native children. Duplicate stdin
/// before PGlite can replace process descriptors. A killed preparation owner
/// cannot leave a converter running or publish its private candidate later.
pub fn watch_operation_owner() -> Result<()> {
    let mut input = os_pipe::dup_stdin()?;
    std::thread::spawn(move || {
        let mut buffer = [0; 1024];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => std::process::exit(0),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => std::process::exit(0),
            }
        }
    });
    Ok(())
}

/// A separate native owner survives the preparation process's SIGKILL, receives
/// EOF on its owning pipe, and terminates the actual Node converter. Its native
/// file-only children also observe EOF when Node exits. No watcher runs inside
/// synchronous legacy WASM and no successful conversion waits on that watcher.
pub async fn run_converter_owner() -> Result<i32> {
    let arguments: Vec<_> = std::env::args_os().skip(2).collect();
    ensure!(
        arguments.len() == 5,
        "Invalid internal profile converter invocation"
    );
    let mut input = os_pipe::dup_stdin()?;
    let (closed, lost) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        drain(&mut input);
        let _ = closed.send(());
    });
    let mut command = tokio::process::Command::new(&arguments[0]);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .args(&arguments[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let status = tokio::select! {
        result = child.wait() => result?,
        _ = lost => {
            let _ = child.kill().await;
            child.wait().await?
        }
    };
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn native_copy_materializes_engine_references_before_recovery_can_write() -> Result<()> {
        let owner = tempfile::tempdir()?;
        let engine = owner.path().join("original-engine");
        let source = owner.path().join("original-profile");
        let staging = owner.path().join("staging");
        fs::create_dir(&engine)?;
        fs::create_dir(&source)?;
        fs::create_dir(&staging)?;
        fs::write(engine.join("database"), b"accepted-original-write")?;
        std::os::unix::fs::symlink(&engine, source.join("server-db"))?;
        fs::write(
            source.join("secret-encryption-key.json"),
            b"opaque-key\0\xff",
        )?;
        let copy = staging.join("copy");
        files::copy_profile(&source, &copy, &staging)?;
        assert!(!fs::symlink_metadata(copy.join("server-db"))?.is_symlink());
        fs::write(copy.join("server-db/database"), b"private-recovery-write")?;
        assert_eq!(
            fs::read(engine.join("database"))?,
            b"accepted-original-write"
        );
        assert_eq!(
            fs::read(copy.join("secret-encryption-key.json"))?,
            b"opaque-key\0\xff"
        );
        Ok(())
    }

    #[test]
    fn automatic_preparation_cannot_recreate_a_missing_completed_profile() -> Result<()> {
        let owner = tempfile::tempdir()?;
        let active = owner.path().join("active");
        let prepared = owner.path().join("prepared");
        fs::create_dir(&active)?;
        fs::create_dir(&prepared)?;
        fs::write(active.join("accepted-data"), b"before-upgrade")?;
        fs::write(prepared.join("accepted-data"), b"converted-data")?;
        let receipt = super::super::activate_profile(&prepared, &active)?;
        fs::rename(&active, owner.path().join("retained-current-data"))?;
        let mut attempted = false;
        let result = activation::prepare_and_activate::<()>(&active, || {
            attempted = true;
            Ok(None)
        });
        assert!(result.is_err());
        assert!(!attempted);
        assert!(!active.exists());
        assert_eq!(
            fs::read(receipt.backup_directory.join("accepted-data"))?,
            b"before-upgrade"
        );
        assert_eq!(
            fs::read(owner.path().join("retained-current-data/accepted-data"))?,
            b"converted-data"
        );
        Ok(())
    }
}
