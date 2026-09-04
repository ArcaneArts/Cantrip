//! Build-time mutual exclusion only; never starts the computer-use runtime.
use std::{
    fs::{File, TryLockError},
    io::{self, Write},
    path::Path,
};

pub fn hold(path: &Path) -> Result<(), &'static str> {
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "installation-lock-failure")?;
    lock.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => "installation-lock-busy",
        TryLockError::Error(_) => "installation-lock-failure",
    })?;
    let mut output = io::stdout().lock();
    output
        .write_all(&[1])
        .and_then(|()| output.flush())
        .map_err(|_| "installation-lock-failure")?;
    io::copy(&mut io::stdin().lock(), &mut io::sink()).map_err(|_| "installation-lock-failure")?;
    // Keep the inode in place: deleting it would allow competing locks on a new
    // file. Closing the descriptor releases the OS lock, including on process exit.
    drop(lock);
    Ok(())
}
