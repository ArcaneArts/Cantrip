//! Fixed Debian desktop utilities, bound to the backend's explicit local display.
//! Clipboard bytes travel over pipes, never argv, files, logs or a shell.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

fn failure(mutation: bool) -> CuaError {
    CuaError::new(
        if mutation {
            ErrorCode::InputUnknown
        } else {
            ErrorCode::InputFailed
        },
        if mutation {
            "Desktop operation did not confirm completion; its outcome is unknown. Do not replay."
        } else {
            "Clipboard text is unavailable or exceeds the supported UTF-8 limit."
        },
    )
}

fn run(
    display: &str,
    executable: &str,
    args: &[&str],
    input: Option<&str>,
    read: bool,
    mutation: bool,
    cancel: &Cancellation,
) -> Result<Vec<u8>> {
    cancel.check()?;
    let mut child = Command::new(executable)
        .args(args)
        .env("DISPLAY", display)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if read { Stdio::piped() } else { Stdio::null() })
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            CuaError::new(
                ErrorCode::Unsupported,
                "The installed desktop utility could not be started; no operation was sent.",
            )
        })?;
    let writer = input.map(|text| {
        let bytes = text.as_bytes().to_vec();
        let mut stdin = child.stdin.take().expect("piped clipboard input");
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let reader = child.stdout.take().map(|stdout| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_CLIPBOARD_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        })
    });
    let start = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(failure(mutation))
                };
            }
            Err(_) => break Err(failure(mutation)),
            Ok(None) => {}
        }
        if cancel.check().is_err() || start.elapsed() > Duration::from_secs(5) {
            break Err(failure(mutation));
        }
        thread::sleep(Duration::from_millis(5));
    };
    // Always reap our direct utility. xclip's selection owner is scoped to this
    // desktop/helper lifetime and exits on selection replacement or teardown.
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let written = writer
        .map(|w| w.join().ok().and_then(std::result::Result::ok).is_some())
        .unwrap_or(true);
    let bytes = match reader {
        Some(r) => r
            .join()
            .ok()
            .and_then(std::result::Result::ok)
            .ok_or_else(|| failure(mutation))?,
        None => vec![],
    };
    result?;
    if !written || bytes.len() > MAX_CLIPBOARD_BYTES {
        return Err(failure(mutation));
    }
    cancel.check().map_err(|_| failure(mutation))?;
    Ok(bytes)
}

pub fn read(display: &str, cancel: &Cancellation) -> Result<Option<String>> {
    let bytes = run(
        display,
        "/usr/bin/xclip",
        &["-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
        None,
        true,
        false,
        cancel,
    )?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| failure(false))
}
pub fn write(display: &str, text: &str, cancel: &Cancellation) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err(CuaError::invalid("Clipboard text exceeds 1 MiB."));
    }
    run(
        display,
        "/usr/bin/xclip",
        &["-selection", "clipboard", "-in", "-target", "UTF8_STRING"],
        Some(text),
        false,
        true,
        cancel,
    )
    .map(|_| ())
}
pub fn resize(display: &str, width: u32, height: u32, cancel: &Cancellation) -> Result<()> {
    if width < 32
        || height < 32
        || width > 8192
        || height > 8192
        || width as u64 * height as u64 > 16_777_216
    {
        return Err(CuaError::invalid(
            "Desktop dimensions must fit the supported image limit.",
        ));
    }
    run(
        display,
        "/usr/bin/xrandr",
        &["--size", &format!("{width}x{height}")],
        None,
        false,
        true,
        cancel,
    )
    .map(|_| ())
}
