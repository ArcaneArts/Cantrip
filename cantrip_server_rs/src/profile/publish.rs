//! Publish a complete directory without replacing any existing destination.
use std::{io, path::Path};

pub(super) fn directory(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    let result = {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let source = CString::new(source.as_os_str().as_bytes())?;
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        #[cfg(target_os = "linux")]
        let code = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_vendor = "apple")]
        let code =
            unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "exclusive directory publication is unavailable",
        ));
        #[cfg(any(target_os = "linux", target_vendor = "apple"))]
        if code == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    };
    #[cfg(windows)]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
        let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<_> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } != 0
        {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    };
    result?;
    #[cfg(unix)]
    std::fs::File::open(destination.parent().unwrap_or(Path::new(".")))?.sync_all()?;
    Ok(())
}
