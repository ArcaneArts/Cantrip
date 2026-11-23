use super::targets::Window;
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::MAX_HOST_CLIPBOARD_UNITS,
};
use std::{
    mem::size_of,
    ptr::null_mut,
    slice,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HGLOBAL, HWND},
    System::{
        DataExchange::{
            CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber,
            OpenClipboard,
        },
        Memory::{GlobalLock, GlobalSize, GlobalUnlock},
    },
    UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, GetWindowThreadProcessId, IsWindowVisible},
};

const UNICODE_TEXT: u32 = 13; // CF_UNICODETEXT

pub(super) fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

pub(super) fn read_focused(
    window: &Window,
    original: u32,
    cancel: &Cancellation,
) -> Result<Option<String>> {
    // A foreground program can use a hidden same-process clipboard window.
    let deadline = Instant::now() + Duration::from_millis(300);
    loop {
        cancel.check()?;
        if sequence() != original
            && owns_clipboard(window)
            && let Some(clipboard) = Clipboard::open()
        {
            if sequence() != original && owns_clipboard(window) {
                let text = clipboard.text()?;
                cancel.check()?;
                return Ok(text);
            }
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        cancel.wait_cancelled(Duration::from_millis(10));
    }
}

fn owns_clipboard(window: &Window) -> bool {
    let owner = unsafe { GetClipboardOwner() };
    let mut pid = 0;
    if owner.is_null()
        || unsafe { GetWindowThreadProcessId(owner, &mut pid) } == 0
        || pid != window.identity.process
    {
        return false;
    }
    let root = unsafe { GetAncestor(owner, GA_ROOT) };
    root == window.identity.hwnd as HWND
        || (!root.is_null() && unsafe { IsWindowVisible(root) == 0 })
}

struct Clipboard;

impl Clipboard {
    fn open() -> Option<Self> {
        (unsafe { OpenClipboard(null_mut()) } != 0).then_some(Self)
    }

    fn text(&self) -> Result<Option<String>> {
        let data = unsafe { GetClipboardData(UNICODE_TEXT) };
        if data.is_null() {
            return Ok(None);
        }
        let units = unsafe { GlobalSize(data) } / size_of::<u16>();
        let Some(memory) = Locked::open(data) else {
            return Err(CuaError::new(
                ErrorCode::InputFailed,
                "Cannot read the selected Windows clipboard text.",
            ));
        };
        // Stop at the first terminator. The allocator may round its capacity.
        let raw = unsafe {
            slice::from_raw_parts(memory.pointer, units.min(MAX_HOST_CLIPBOARD_UNITS + 1))
        };
        let end = raw.iter().position(|&unit| unit == 0);
        let Some(end) = end else {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "Clipboard text exceeds the supported limit.",
            ));
        };
        Ok(Some(String::from_utf16_lossy(&raw[..end])))
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe { CloseClipboard() };
    }
}

struct Locked {
    memory: HGLOBAL,
    pointer: *const u16,
}

impl Locked {
    fn open(memory: HGLOBAL) -> Option<Self> {
        let pointer = unsafe { GlobalLock(memory) }.cast::<u16>();
        (!pointer.is_null()).then_some(Self { memory, pointer })
    }
}

impl Drop for Locked {
    fn drop(&mut self) {
        unsafe { GlobalUnlock(self.memory) };
    }
}
