pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}
pub fn architecture() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}
pub fn hostname() -> std::io::Result<String> {
    #[cfg(unix)]
    {
        let mut bytes = vec![0_u8; 1024];
        // SAFETY: the buffer is writable for the supplied length.
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        bytes.truncate(bytes.iter().position(|v| *v == 0).unwrap_or(bytes.len()));
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Networking::WinSock::{
            GetHostNameW, WSACleanup, WSADATA, WSAGetLastError, WSAStartup,
        };
        // Same hostname source as uv_os_gethostname:
        // https://github.com/libuv/libuv/blob/v1.x/src/win/util.c
        let mut data = std::mem::MaybeUninit::<WSADATA>::uninit();
        // SAFETY: WSAStartup initializes the supplied WSADATA output allocation.
        let started = unsafe { WSAStartup(0x202, data.as_mut_ptr()) };
        if started != 0 {
            return Err(std::io::Error::from_raw_os_error(started));
        }
        let mut buffer = vec![0_u16; 1024];
        // SAFETY: writable output buffer; Winsock startup succeeded above.
        let error = unsafe {
            if GetHostNameW(buffer.as_mut_ptr(), buffer.len() as i32) != 0 {
                Some(WSAGetLastError())
            } else {
                None
            }
        };
        // SAFETY: balances only this function's successful startup reference.
        unsafe {
            WSACleanup();
        }
        if let Some(error) = error {
            return Err(std::io::Error::from_raw_os_error(error));
        }
        let length = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
        Ok(String::from_utf16_lossy(&buffer[..length]))
    }
}
