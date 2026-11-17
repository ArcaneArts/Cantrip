use crate::filesystem::{Scope, paths};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::JsString;
use std::{
    ffi::{OsStr, OsString},
    path::Path,
};
pub const MAXIMUM: usize = 16 * 1024 * 1024;
pub(super) struct Output {
    pub bytes: Vec<u8>,
    pub overflow: bool,
    pub code: Option<i32>,
    pub error: String,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}
pub(super) async fn capture(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Output> {
    capture_environment(cwd, args, scope, &[]).await
}
pub(super) async fn capture_environment(
    cwd: &Path,
    args: &[&str],
    scope: &Scope,
    environment: &[(OsString, OsString)],
) -> Result<Output> {
    capture_input(cwd, args, scope, environment, None).await
}
async fn capture_input(
    cwd: &Path,
    args: &[&str],
    scope: &Scope,
    environment: &[(OsString, OsString)],
    input: Option<&[u8]>,
) -> Result<Output> {
    capture_options(cwd, args, scope, environment, input, None).await
}
pub(super) async fn bounded(
    cwd: &Path,
    args: &[&str],
    scope: &Scope,
    timeout: std::time::Duration,
) -> Result<Output> {
    capture_options(cwd, args, scope, &[], None, Some(timeout)).await
}
async fn capture_options(
    cwd: &Path,
    args: &[&str],
    scope: &Scope,
    environment: &[(OsString, OsString)],
    input: Option<&[u8]>,
    timeout: Option<std::time::Duration>,
) -> Result<Output> {
    let arguments: Vec<OsString> = std::iter::once(OsString::from("-C"))
        .chain(std::iter::once(cwd.as_os_str().to_owned()))
        .chain(args.iter().map(OsString::from))
        .collect();
    // The collector owns two I/O buffers. Keep that state on the heap instead
    // of duplicating it through each joined status/action future and its poll
    // stack frames on the worker's normal runtime threads.
    let captured = if let Some(timeout) = timeout {
        Box::pin(scope.capture_timeout(OsStr::new("git"), &arguments, MAXIMUM, timeout)).await
    } else if input.is_some() {
        Box::pin(scope.capture_input(OsStr::new("git"), &arguments, MAXIMUM, environment, input))
            .await
    } else if environment.is_empty() {
        Box::pin(scope.capture(OsStr::new("git"), &arguments, MAXIMUM)).await
    } else {
        Box::pin(scope.capture_environment(OsStr::new("git"), &arguments, MAXIMUM, environment))
            .await
    };
    let result = captured.map_err(|error| {
        if let Some(io) = error.downcast_ref::<std::io::Error>() {
            let code = match io.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => return error,
            };
            anyhow!("spawn git {code}")
        } else {
            error
        }
    })?;
    let error = match result.overflow {
        Some(stream) => format!("{stream} maxBuffer length exceeded"),
        None => format!(
            "Command failed: git -C {} {}\n{}",
            paths::text(cwd).lossy(),
            args.join(" "),
            String::from_utf8_lossy(&result.stderr)
        ),
    };
    Ok(Output {
        bytes: result.stdout,
        stderr: result.stderr,
        overflow: result.overflow.is_some(),
        code: result.code,
        error,
        timed_out: result.timed_out,
    })
}
pub(super) async fn raw_environment(
    cwd: &Path,
    args: &[&str],
    scope: &Scope,
    environment: &[(OsString, OsString)],
) -> Result<String> {
    let output = capture_environment(cwd, args, scope, environment).await?;
    if output.code != Some(0) || output.overflow {
        bail!("{}", output.error);
    }
    Ok(String::from_utf8_lossy(&output.bytes).into_owned())
}
pub(super) async fn input(
    cwd: &Path,
    args: &[&str],
    text: &str,
    scope: &Scope,
    environment: &[(OsString, OsString)],
) -> Result<String> {
    let output = capture_input(cwd, args, scope, environment, Some(text.as_bytes())).await?;
    if output.overflow {
        bail!("Git patch output exceeded the safety limit.");
    }
    let stdout = String::from_utf8_lossy(&output.bytes);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.code != Some(0) {
        let stderr = trim(&stderr);
        let stdout = trim(&stdout);
        bail!(
            "{}",
            if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "Git patch failed.".into()
            }
        );
    }
    Ok(trim(&format!("{stdout}{stderr}")))
}
pub(super) async fn bytes(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Vec<u8>> {
    let output = capture(cwd, args, scope).await?;
    if output.code != Some(0) || output.overflow {
        bail!("{}", output.error);
    }
    Ok(output.bytes)
}
/// Source's Buffer collector reports combined output before execFile's message.
pub(super) async fn buffer(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Vec<u8>> {
    let output = capture(cwd, args, scope).await?;
    if output.code != Some(0) || output.overflow {
        let text = trim(&format!(
            "{}{}",
            String::from_utf8_lossy(&output.bytes),
            String::from_utf8_lossy(&output.stderr)
        ));
        bail!("{}", if text.is_empty() { output.error } else { text });
    }
    Ok(output.bytes)
}
pub(super) async fn raw(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    Ok(String::from_utf8_lossy(&bytes(cwd, args, scope).await?).into_owned())
}
pub(super) fn trim(text: &str) -> String {
    JsString::from(text).trim().lossy().into_owned()
}
pub(super) async fn text(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    Ok(trim(&raw(cwd, args, scope).await?))
}
/// Preserve the action helper's stdout+stderr output and error priority; query
/// helpers above retain their original execFile-style failure messages.
pub(super) async fn run(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    run_environment(cwd, args, scope, &[]).await
}
pub(super) async fn run_environment(
    cwd: &Path,
    args: &[&str],
    scope: &Scope,
    environment: &[(OsString, OsString)],
) -> Result<String> {
    let output = capture_environment(cwd, args, scope, environment).await?;
    let stdout = String::from_utf8_lossy(&output.bytes);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.code != Some(0) || output.overflow {
        let stderr = trim(&stderr);
        let stdout = trim(&stdout);
        bail!(
            "{}",
            if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                output.error
            }
        );
    }
    Ok(trim(&format!("{stdout}{stderr}")))
}
