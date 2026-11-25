//! Launch the pinned Codex sandbox with a worker-constructed restricted policy.
use super::super::{Environment, shell::Command};
use crate::filesystem::{explorer::restricted, paths};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_protocol::external_mcp::execution::{CommandStart, ExecutionPolicy};
use cantrip_wire::{Value, value::json};
use std::path::Path;
use tempfile::TempDir;

pub(super) struct Prepared {
    pub command: Command,
    pub environment: Environment,
    _profile: TempDir,
}

pub(super) fn prepare(
    data: &Path,
    codex: &Path,
    root: &Path,
    policy: ExecutionPolicy,
    input: &CommandStart,
) -> Result<Prepared> {
    let access = policy
        .sandbox_access()
        .context("External execution is disabled.")?;
    let directory = restricted::working_directory(root, &input.cwd)?;
    let location = url::Url::from_directory_path(&directory)
        .map_err(|_| anyhow!("The checkout working directory is unavailable."))?;
    let profile = tempfile::Builder::new()
        .prefix("sandbox-")
        .tempdir_in(data)?;
    let home = profile
        .path()
        .to_str()
        .context("Worker sandbox profile path")?;
    let target = root.to_str().context("Checkout path encoding")?;
    let mut entries = vec![
        json!({"path":json!({"type":"special","value":json!({"kind":"minimal"})}),"access":"read"}),
        json!({"path":json!({"type":"path","path":target}),"access":access}),
    ];
    let state = data.parent().context("Worker data directory")?;
    let state = paths::canonical_sync(state).context("Worker data directory")?;
    if paths::within(root, &state) {
        ensure!(
            !paths::equal(root, &state),
            "External commands cannot use the worker storage root as their checkout."
        );
        entries.push(json!({"path":json!({"type":"path","path":state}),"access":"deny"}));
    }

    let policy = json!({
        "permissionProfile":json!({
            "type":"managed","file_system":json!({"type":"restricted","entries":entries}),
            "network":"restricted",
        }),
        "codexLinuxSandboxExe":Value::Null,"sandboxCwd":location.as_str(),
        "useMxc":cfg!(windows),
    });
    let mut arguments = vec![
        "sandbox".to_owned(),
        "--sandbox-state-json".to_owned(),
        policy.stringify(),
        "--sandbox-state-disable-network".to_owned(),
        "--".to_owned(),
        input.executable.clone(),
    ];
    arguments.extend(input.args.iter().cloned());
    let mut environment = Environment::new();
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"] {
        if let Ok(value) = std::env::var(name) {
            environment.insert(name.to_owned(), value);
        }
    }
    for name in ["HOME", "USERPROFILE", "CODEX_HOME"] {
        environment.insert(name.to_owned(), home.to_owned());
    }
    environment.insert("TERM".to_owned(), "dumb".to_owned());
    environment.insert("NO_COLOR".to_owned(), "1".to_owned());
    let program = codex
        .to_str()
        .context("The assigned worker has no compatible Codex sandbox launcher.")?;
    Ok(Prepared {
        command: Command {
            program: program.to_owned(),
            arguments,
            cwd: directory,
        },
        environment,
        _profile: profile,
    })
}
