//! Match execFile's output limits and public failures while retaining the
//! native worker's owned child and runtime-stop behavior. No shell is involved.
use crate::error::WireError;
use crate::filesystem::Scope;
use anyhow::{Result, anyhow, bail};
use cantrip_wire::JsString;
use std::ffi::OsStr;

pub(super) async fn run(args: &[&str], maximum: usize, scope: &Scope) -> Result<String> {
    run_values(
        &args
            .iter()
            .map(|value| JsString::from(*value))
            .collect::<Vec<_>>(),
        maximum,
        scope,
    )
    .await
}
pub(super) async fn run_values(args: &[JsString], maximum: usize, scope: &Scope) -> Result<String> {
    run_program("gh", args, maximum, scope).await
}
pub(crate) async fn run_program(
    program: &str,
    args: &[JsString],
    maximum: usize,
    scope: &Scope,
) -> Result<String> {
    Ok(run_output(program, args, maximum, None, scope).await?.0)
}
pub(super) async fn run_output(
    program: &str,
    args: &[JsString],
    maximum: usize,
    timeout: Option<std::time::Duration>,
    scope: &Scope,
) -> Result<(String, String)> {
    let output = capture_program(program, args, maximum, timeout, scope).await?;
    check_output(program, args, &output)?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}
#[derive(Debug)]
pub(crate) struct SpawnError {
    pub code: &'static str,
    program: String,
}
impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "spawn {} {}", self.program, self.code)
    }
}
impl std::error::Error for SpawnError {}
pub(crate) async fn capture_program(
    program: &str,
    args: &[JsString],
    maximum: usize,
    timeout: Option<std::time::Duration>,
    scope: &Scope,
) -> Result<crate::filesystem::command::Captured> {
    for (index, argument) in args.iter().enumerate() {
        if argument.units().contains(&0) {
            let prefix = format!(
                "The argument 'args[{index}]' must be a string without null bytes. Received "
            );
            return Err(WireError(JsString::new(
                prefix
                    .encode_utf16()
                    .chain(inspect(argument).units().iter().copied())
                    .collect(),
            ))
            .into());
        }
    }
    let arguments = args
        .iter()
        .map(|value| crate::filesystem::paths::native(value).into_os_string())
        .collect::<Vec<_>>();
    // Keep the collector's I/O buffers off nested command poll stacks.
    let output = if let Some(timeout) = timeout {
        Box::pin(scope.capture_timeout(OsStr::new(program), &arguments, maximum, timeout)).await
    } else {
        Box::pin(scope.capture(OsStr::new(program), &arguments, maximum)).await
    }
    .map_err(|error| {
        if let Some(io) = error.downcast_ref::<std::io::Error>() {
            #[cfg(unix)]
            if io.raw_os_error() == Some(libc::E2BIG) {
                return anyhow!("spawn E2BIG");
            }
            match io.kind() {
                std::io::ErrorKind::NotFound => {
                    return SpawnError {
                        code: "ENOENT",
                        program: program.to_owned(),
                    }
                    .into();
                }
                std::io::ErrorKind::PermissionDenied => {
                    return SpawnError {
                        code: "EACCES",
                        program: program.to_owned(),
                    }
                    .into();
                }
                _ => {}
            }
        }
        error
    })?;
    Ok(output)
}
pub(crate) fn check_output(
    program: &str,
    args: &[JsString],
    output: &crate::filesystem::command::Captured,
) -> Result<()> {
    if let Some(stream) = output.overflow {
        bail!("{stream} maxBuffer length exceeded");
    }
    if output.code != Some(0) || output.timed_out {
        let mut message = format!("Command failed: {program} ")
            .encode_utf16()
            .collect::<Vec<_>>();
        for (index, argument) in args.iter().enumerate() {
            if index != 0 {
                message.push(32);
            }
            message.extend(argument.units());
        }
        message.push(10);
        message.extend(String::from_utf8_lossy(&output.stderr).encode_utf16());
        return Err(WireError(JsString::new(message)).into());
    }
    Ok(())
}
fn inspect(value: &JsString) -> JsString {
    // Node's ERR_INVALID_ARG_VALUE renders inspect's first 10,000 UTF-16
    // units, then clips the rendered text to 128 units (which may split a
    // surrogate pair). Any inspect trailer is beyond that error-message cap.
    let value = &value.units()[..value.len().min(10_000)];
    let rendered = if value.len() > 76 {
        value
            .split_inclusive(|unit| *unit == 10)
            .map(quote_string)
            .collect::<Vec<_>>()
            .join(" +\n  ")
    } else {
        quote_string(value)
    };
    let mut units = rendered.encode_utf16().collect::<Vec<_>>();
    if units.len() > 128 {
        units.truncate(128);
        units.extend("...".encode_utf16());
    }
    JsString::new(units)
}
fn quote_string(value: &[u16]) -> String {
    let quote = if !value.contains(&39) {
        '\''
    } else if !value.contains(&34) {
        '"'
    } else if !value.contains(&96) && !value.windows(2).any(|pair| pair == [36, 123]) {
        '`'
    } else {
        '\''
    };
    let mut result = quote.to_string();
    for ch in std::char::decode_utf16(value.iter().copied()) {
        let ch = match ch {
            Ok(ch) => ch,
            Err(error) => {
                result.push_str(&format!("\\u{:04x}", error.unpaired_surrogate()));
                continue;
            }
        };
        match ch {
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            '\u{0008}' => result.push_str("\\b"),
            '\u{000c}' => result.push_str("\\f"),
            '\u{000b}' => result.push_str("\\v"),
            ch if ch == quote => {
                result.push('\\');
                result.push(ch);
            }
            ch if ch < ' ' || ('\u{007f}'..='\u{009f}').contains(&ch) => {
                result.push_str(&format!("\\x{:02x}", ch as u32))
            }
            ch => result.push(ch),
        }
    }
    result.push(quote);
    result
}
