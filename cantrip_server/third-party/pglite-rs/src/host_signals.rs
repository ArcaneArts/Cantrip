//! Keep process shutdown interrupts owned by the embedding application.
use std::{io, mem::MaybeUninit, ptr};

pub(crate) struct InterruptHandlers {
    actions: [(libc::c_int, libc::sigaction); 2],
    armed: bool,
}

impl InterruptHandlers {
    pub(crate) fn capture() -> io::Result<Self> {
        Ok(Self {
            actions: [snapshot(libc::SIGINT)?, snapshot(libc::SIGTERM)?],
            armed: true,
        })
    }

    pub(crate) fn restore(&mut self) -> io::Result<()> {
        let mut error = None;
        for (signal, action) in &self.actions {
            // SAFETY: action was initialized by a successful sigaction query,
            // and both signal numbers are valid process shutdown interrupts.
            if unsafe { libc::sigaction(*signal, action, ptr::null_mut()) } != 0 && error.is_none()
            {
                error = Some(io::Error::last_os_error());
            }
        }
        if let Some(error) = error {
            Err(error)
        } else {
            self.armed = false;
            Ok(())
        }
    }
}

impl Drop for InterruptHandlers {
    fn drop(&mut self) {
        if self.armed {
            // Explicit restoration reports errors to the opener. Also retain
            // the host dispositions if Rust unwinds during native boot.
            let _ = self.restore();
        }
    }
}

fn snapshot(signal: libc::c_int) -> io::Result<(libc::c_int, libc::sigaction)> {
    let mut action = MaybeUninit::uninit();
    // SAFETY: a null input only queries the current disposition; the output
    // points to enough writable, aligned storage for libc's sigaction value.
    if unsafe { libc::sigaction(signal, ptr::null(), action.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful query above initialized the output value.
    Ok((signal, unsafe { action.assume_init() }))
}
