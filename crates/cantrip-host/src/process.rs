//! Parent-pipe EOF notification and signaling an owned, unreaped Unix child.
#[cfg(unix)]
use anyhow::{Context, Result};
use std::io::Read;
#[cfg(unix)]
use tokio::process::Child;
use tokio::sync::oneshot;

pub fn pipe_closed(
    mut input: impl Read + Send + 'static,
    thread_name: &str,
) -> std::io::Result<oneshot::Receiver<()>> {
    let (send, receive) = oneshot::channel();
    // Tokio's blocking stdin reader cannot be cancelled and can keep runtime
    // teardown waiting after its owner exits. This plain reader thread
    // owns only the pipe; it need not be joined before the owner process exits.
    std::thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || {
            let mut buffer = [0; 256];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = send.send(());
        })?;
    Ok(receive)
}

/// The caller must retain the unreaped child and, for group signaling, must
/// have created that child's process group. This does not discover processes
/// from persisted PIDs or replace application supervision and shutdown policy.
#[cfg(unix)]
pub fn signal_owned(
    child: &Child,
    signal: i32,
    group: bool,
    identity_context: &'static str,
) -> Result<()> {
    let pid = i32::try_from(child.id().context(identity_context)?)?;
    // The caller retains the unreaped child handle and created the group.
    // No identity is inferred from a directory's PID file.
    if unsafe { libc::kill(if group { -pid } else { pid }, signal) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    Ok(())
}
