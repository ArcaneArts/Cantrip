//! Finite, unprivileged guest child. It reads one Run definition operation
//! from stdin and uses the same filesystem and validation code as Host Runs.
use crate::{
    filesystem::Scope,
    run_definitions::{self, Definitions},
    run_runtime::Environment,
};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::parse_json_text;
use std::{
    env,
    ffi::CStr,
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    sync::Arc,
};

const MAX_LINE: usize = 2 * 1024 * 1024;

pub fn run() -> Result<()> {
    let mut arguments = env::args_os().skip(1);
    let root = PathBuf::from(
        arguments
            .next()
            .context("A captured Linux Primary is required.")?,
    );
    ensure!(
        root.is_absolute() && arguments.next().is_none(),
        "A captured Linux Primary is required."
    );
    // This is the synchronous entry point, before the runtime starts threads.
    unsafe { libc::umask(0o077) };
    let environment = account_environment()?;
    let _ = cantrip_wire::environment::timezone();
    let _ = cantrip_wire::environment::locale();
    let mut input = Vec::new();
    BufReader::new(io::stdin().lock().take((MAX_LINE + 2) as u64)).read_until(b'\n', &mut input)?;
    let line = input.strip_suffix(b"\n").unwrap_or(&input);
    ensure!(line.len() <= MAX_LINE, "Run request is too large.");
    let command = parse_json_text(std::str::from_utf8(line)?)
        .map_err(|_| anyhow!("Invalid Linux Run definition request."))?;
    let command = crate::http::checked("cantripOsRunDefinitionRequestSchema", &command)?;
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let root = run_definitions::root(&command, &root).await?;
            Definitions::new(Arc::new(environment))
                .execute_at_root(&command, root, Scope::default())
                .await
        })?;
    writeln!(io::stdout().lock(), "{}", result.stringify())?;
    Ok(())
}

fn account_environment() -> Result<Environment> {
    let mut environment: Environment = env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    // The executor runs this child as the guest workspace UID. Read that
    // account on the guest before starting threads and copy its fields.
    let (home, user, shell) = unsafe {
        let account = libc::getpwuid(libc::getuid())
            .as_ref()
            .context("Linux guest account")?;
        (
            CStr::from_ptr(account.pw_dir)
                .to_string_lossy()
                .into_owned(),
            CStr::from_ptr(account.pw_name)
                .to_string_lossy()
                .into_owned(),
            CStr::from_ptr(account.pw_shell)
                .to_string_lossy()
                .into_owned(),
        )
    };
    environment.insert("HOME".into(), home);
    environment.insert("USER".into(), user.clone());
    environment.insert("LOGNAME".into(), user);
    environment.insert(
        "SHELL".into(),
        if shell.is_empty() {
            "/bin/bash".into()
        } else {
            shell
        },
    );
    environment
        .entry("PATH".into())
        .or_insert_with(|| "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into());
    Ok(environment)
}
