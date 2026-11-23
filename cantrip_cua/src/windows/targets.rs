use super::{failure, missing, stale};
use crate::{
    error::Result,
    target::{Bounds, Target, TargetKind},
};
use std::{mem::size_of, path::Path, ptr::null_mut, slice};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, RECT},
    Graphics::{
        Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
        Gdi::{
            DISPLAY_DEVICEW, EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, HDC,
            HMONITOR, MONITORINFOEXW,
        },
    },
    Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
    System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    },
    UI::{
        HiDpi::{
            DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            SetThreadDpiAwarenessContext,
        },
        WindowsAndMessaging::{
            EnumWindows, GA_ROOT, GetAncestor, GetForegroundWindow, GetWindowInfo, GetWindowTextW,
            GetWindowThreadProcessId, IsChild, IsIconic, IsWindowVisible, MONITORINFOF_PRIMARY,
            WINDOWINFO,
        },
    },
};

pub(super) const INVENTORY_LIMIT: usize = 2_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct WindowIdentity {
    pub(super) hwnd: usize,
    pub(super) process: u32,
    pub(super) thread: u32,
    pub(super) created: u64,
}

pub(super) struct Window {
    pub(super) identity: WindowIdentity,
    pub(super) target: Target,
    pub(super) frame: RECT,
    pub(super) client: RECT,
    pub(super) protected: bool,
}

#[derive(Clone)]
pub(super) struct Monitor {
    pub(super) handle: usize,
    pub(super) device: String,
    pub(super) target: Target,
    pub(super) primary: bool,
}

pub(super) struct PixelCoordinates(DPI_AWARENESS_CONTEXT);

impl PixelCoordinates {
    pub(super) fn enter() -> Self {
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for PixelCoordinates {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
}

pub(super) fn window_handles() -> Result<Vec<usize>> {
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> i32 {
        let handles = unsafe { &mut *(data as *mut Vec<usize>) };
        if unsafe { IsWindowVisible(hwnd) } != 0 {
            handles.push(hwnd as usize);
        }
        i32::from(handles.len() <= INVENTORY_LIMIT)
    }
    let mut handles = Vec::new();
    let ok = unsafe { EnumWindows(Some(collect), (&mut handles as *mut Vec<usize>) as LPARAM) };
    if ok == 0 && handles.len() <= INVENTORY_LIMIT {
        return Err(failure("Windows could not enumerate application windows."));
    }
    Ok(handles)
}

pub(super) fn monitors() -> Result<Vec<Monitor>> {
    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _: HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> i32 {
        let handles = unsafe { &mut *(data as *mut Vec<usize>) };
        handles.push(monitor as usize);
        1
    }
    let _coordinates = PixelCoordinates::enter();
    let mut handles = Vec::new();
    if unsafe {
        EnumDisplayMonitors(
            null_mut(),
            std::ptr::null(),
            Some(collect),
            (&mut handles as *mut Vec<usize>) as LPARAM,
        )
    } == 0
    {
        return Err(failure("Windows could not enumerate desktop displays."));
    }
    let mut monitors: Vec<_> = handles
        .into_iter()
        .filter_map(|handle| monitor(handle).ok())
        .collect();
    monitors.sort_by_key(|monitor| !monitor.primary);
    monitors.truncate(64);
    Ok(monitors)
}

fn monitor_info(handle: usize) -> Result<MONITORINFOEXW> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if unsafe { GetMonitorInfoW(handle as HMONITOR, &mut info.monitorInfo) } == 0 {
        return Err(missing());
    }
    Ok(info)
}

impl Monitor {
    pub(super) fn verify(&self) -> Result<()> {
        let info = monitor_info(self.handle)?;
        let rect = info.monitorInfo.rcMonitor;
        let bounds = &self.target.bounds;
        if self.device != wide(&info.szDevice)
            || bounds.x != f64::from(rect.left)
            || bounds.y != f64::from(rect.top)
            || bounds.width != f64::from(rect.right - rect.left)
            || bounds.height != f64::from(rect.bottom - rect.top)
        {
            return Err(stale());
        }
        Ok(())
    }
}

fn monitor(handle: usize) -> Result<Monitor> {
    let info = monitor_info(handle)?;
    let mut display = DISPLAY_DEVICEW {
        cb: size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    let device = wide(&info.szDevice);
    let title = if unsafe { EnumDisplayDevicesW(info.szDevice.as_ptr(), 0, &mut display, 0) } != 0 {
        wide(&display.DeviceString)
    } else {
        device.clone()
    };
    let primary = info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0;
    // Inventory pages are ordered by the opaque id. The product uses the first
    // monitor as primary and exposes its original numeric Windows id.
    let prefix = if primary {
        "display-primary"
    } else {
        "display-secondary"
    };
    let mut target = target(
        prefix,
        handle,
        TargetKind::Monitor,
        info.monitorInfo.rcMonitor,
    )?;
    target.title = Some(title);
    Ok(Monitor {
        handle,
        device,
        target,
        primary,
    })
}

impl Window {
    pub(super) fn observe(handle: usize) -> Result<Self> {
        let _coordinates = PixelCoordinates::enter();
        let hwnd = handle as HWND;
        let (identity, process) = Process::observe(hwnd)?;
        let mut info = WINDOWINFO {
            cbSize: size_of::<WINDOWINFO>() as u32,
            ..Default::default()
        };
        let mut cloaked = 0u32;
        if unsafe {
            GetAncestor(hwnd, GA_ROOT) != hwnd
                || IsWindowVisible(hwnd) == 0
                || GetWindowInfo(hwnd, &mut info) == 0
        } || (unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                (&mut cloaked as *mut u32).cast(),
                size_of::<u32>() as u32,
            )
        } >= 0
            && cloaked != 0)
        {
            return Err(missing());
        }
        let mut title = [0; 1025];
        if unsafe { GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) } == 0 {
            return Err(missing());
        }
        let title = wide(&title);
        if title.is_empty() {
            return Err(missing());
        }
        let (application, protected) = process.application()?;
        let mut target = target("window", handle, TargetKind::Window, info.rcClient)?;
        target.title = Some(title);
        target.application = Some(application);
        target.process_id = Some(identity.process);
        target.focused = Some(unsafe { GetForegroundWindow() == hwnd });
        target.minimized = Some(unsafe { IsIconic(hwnd) != 0 });
        Ok(Self {
            identity,
            target,
            frame: info.rcWindow,
            client: info.rcClient,
            protected,
        })
    }

    pub(super) fn verify_identity(&self) -> Result<()> {
        let (identity, _) = Process::observe(self.identity.hwnd as HWND).map_err(|_| stale())?;
        if identity != self.identity {
            return Err(stale());
        }
        Ok(())
    }

    pub(super) fn recipient_thread(&self, hwnd: HWND) -> Option<u32> {
        let root = self.identity.hwnd as HWND;
        if hwnd.is_null() || (hwnd != root && unsafe { IsChild(root, hwnd) } == 0) {
            return None;
        }
        let mut process = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut process) };
        (thread != 0 && process == self.identity.process).then_some(thread)
    }
}

struct Process(HANDLE);

impl Process {
    fn observe(hwnd: HWND) -> Result<(WindowIdentity, Self)> {
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if thread == 0 {
            return Err(missing());
        }
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return Err(missing());
        }
        let process = Self(handle);
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(missing());
        }
        Ok((
            WindowIdentity {
                hwnd: hwnd as usize,
                process: pid,
                thread,
                created: (u64::from(created.dwHighDateTime) << 32)
                    | u64::from(created.dwLowDateTime),
            },
            process,
        ))
    }

    fn application(&self) -> Result<(String, bool)> {
        let mut path = vec![0; 32768];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.0, 0, path.as_mut_ptr(), &mut length) } == 0 {
            return Err(missing());
        }
        let name = String::from_utf16_lossy(&path[..length as usize]);
        let executable = Path::new(&name);
        let basename = executable
            .file_name()
            .and_then(|file| file.to_str())
            .filter(|file| !file.is_empty())
            .ok_or_else(missing)?;
        let protected = executable
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(crate::target::is_cantrip_application_name);
        let application = version_label(&path).unwrap_or_else(|| basename.to_owned());
        Ok((application, protected))
    }
}

fn version_label(path: &[u16]) -> Option<String> {
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), null_mut()) } as usize;
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut resource = vec![0u16; size.div_ceil(size_of::<u16>())];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size as u32, resource.as_mut_ptr().cast()) }
        == 0
    {
        return None;
    }
    let translations = version_value(&resource, r"\VarFileInfo\Translation", 1)?;
    for key in [
        "FileDescription",
        "ProductName",
        "ProductShortName",
        "InternalName",
        "OriginalFilename",
    ] {
        for translation in translations.chunks_exact(4) {
            let language = u16::from_le_bytes([translation[0], translation[1]]);
            let codepage = u16::from_le_bytes([translation[2], translation[3]]);
            let path = format!(r"\StringFileInfo\{language:04x}{codepage:04x}\{key}");
            if let Some(bytes) = version_value(&resource, &path, 2) {
                let units: Vec<_> = bytes
                    .chunks_exact(2)
                    .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
                    .collect();
                let label = wide(&units);
                if !label.is_empty() && label.len() <= 1024 {
                    return Some(label);
                }
            }
        }
    }
    None
}

fn version_value<'a>(resource: &'a [u16], path: &str, unit_bytes: usize) -> Option<&'a [u8]> {
    let query: Vec<_> = path.encode_utf16().chain([0]).collect();
    let mut value = null_mut();
    let mut length = 0;
    if unsafe {
        VerQueryValueW(
            resource.as_ptr().cast(),
            query.as_ptr(),
            &mut value,
            &mut length,
        )
    } == 0
        || value.is_null()
    {
        return None;
    }
    let ptr = resource.as_ptr().cast::<u8>();
    let start = (value as usize).checked_sub(ptr as usize)?;
    let end = start.checked_add(length as usize * unit_bytes)?;
    let bytes = unsafe { slice::from_raw_parts(ptr, size_of_val(resource)) };
    bytes.get(start..end)
}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn target(prefix: &str, handle: usize, kind: TargetKind, rect: RECT) -> Result<Target> {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err(missing());
    }
    Ok(Target {
        id: format!("windows-{prefix}-{}", handle as u32),
        generation: 0,
        kind,
        title: None,
        application: None,
        process_id: None,
        access: None,
        bounds: Bounds {
            x: rect.left.into(),
            y: rect.top.into(),
            width: width.into(),
            height: height.into(),
        },
        pixel_width: width as u32,
        pixel_height: height as u32,
        scale_factor: 1.,
        focused: None,
        minimized: None,
    })
}

fn wide(units: &[u16]) -> String {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end]).trim().to_owned()
}
