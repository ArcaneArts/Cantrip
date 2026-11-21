use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use std::{
    io::ErrorKind,
    time::{Duration, Instant},
};
use wayland_client::{EventQueue, backend::WaylandError};

pub(super) fn until<State, Output>(
    queue: &mut EventQueue<State>,
    state: &mut State,
    deadline: Instant,
    cancel: &Cancellation,
    complete: impl Fn(&State) -> Option<Output>,
) -> Result<Output> {
    loop {
        cancel.check()?;
        queue.dispatch_pending(state).map_err(failed)?;
        if let Some(result) = complete(state) {
            return Ok(result);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CuaError::new(
                ErrorCode::CaptureImageTimeout,
                "The Wayland compositor did not respond.",
            ));
        }
        let mut flags = PollFlags::IN;
        match queue.flush() {
            Ok(()) => {}
            Err(ref error) if would_block(error) => flags |= PollFlags::OUT,
            Err(error) => return Err(failed(error)),
        }
        let Some(read) = queue.prepare_read() else {
            continue;
        };
        let mut fds = [PollFd::new(&queue, flags)];
        let timeout = Timespec {
            tv_sec: 0,
            tv_nsec: remaining.min(Duration::from_millis(40)).as_nanos() as _,
        };
        match poll(&mut fds, Some(&timeout)) {
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(failed(error)),
        }
        let ready = fds[0].revents();
        if ready.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
            match read.read() {
                Ok(_) => {}
                Err(ref error) if would_block(error) => {}
                Err(error) => return Err(failed(error)),
            }
        }
    }
}

fn would_block(error: &WaylandError) -> bool {
    matches!(error, WaylandError::Io(error) if error.kind() == ErrorKind::WouldBlock)
}

pub(super) fn failed(_: impl std::fmt::Display) -> CuaError {
    CuaError::new(
        ErrorCode::CaptureFailed,
        "The Wayland desktop connection failed.",
    )
}
