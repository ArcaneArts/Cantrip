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
}
pub(super) async fn capture(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Output> {
    let arguments: Vec<OsString> = std::iter::once(OsString::from("-C"))
        .chain(std::iter::once(cwd.as_os_str().to_owned()))
        .chain(args.iter().map(OsString::from))
        .collect();
    let result = scope
        .capture(OsStr::new("git"), &arguments, MAXIMUM)
        .await
        .map_err(|error| {
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
        overflow: result.overflow.is_some(),
        code: result.code,
        error,
    })
}
pub(super) async fn bytes(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Vec<u8>> {
    let output = capture(cwd, args, scope).await?;
    if output.code != Some(0) || output.overflow {
        bail!("{}", output.error);
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
