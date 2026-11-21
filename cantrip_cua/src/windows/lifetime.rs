use super::{
    failure, lock, stale,
    targets::{Monitor, Window, WindowIdentity},
};
use crate::{
    error::{CuaError, ErrorCode, Result},
    target::MAX_SEQUENCE,
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ptr::null_mut,
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::HWND,
    System::Threading::GetCurrentThreadId,
    UI::{
        Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
        WindowsAndMessaging::{
            CHILDID_SELF, DispatchMessageW, EVENT_OBJECT_DESTROY, GetMessageW, MSG, OBJID_WINDOW,
            PM_NOREMOVE, PeekMessageW, PostThreadMessageW, WINEVENT_OUTOFCONTEXT, WM_QUIT,
        },
    },
};

pub(super) type Shared = Arc<Mutex<Registry>>;

thread_local! {
    static OBSERVED: RefCell<Option<Shared>> = const { RefCell::new(None) };
}

pub(super) struct Registry {
    windows: HashMap<usize, (WindowIdentity, u64, bool)>,
    monitors: HashMap<usize, Monitor>,
    generation: u64,
    active: bool,
}

impl Registry {
    fn new() -> Self {
        let generation = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Self {
            windows: HashMap::new(),
            monitors: HashMap::new(),
            generation: (generation.as_nanos() as u64 & (MAX_SEQUENCE >> 1)).max(1),
            active: false,
        }
    }

    fn next(&mut self) -> Result<u64> {
        self.generation = self
            .generation
            .checked_add(1)
            .filter(|g| *g <= MAX_SEQUENCE)
            .ok_or_else(|| {
                CuaError::new(ErrorCode::Capacity, "Windows target generations exhausted.")
            })?;
        Ok(self.generation)
    }

    pub(super) fn bind_window(&mut self, window: &mut Window) -> Result<()> {
        if !self.active {
            return Err(stale());
        }
        let identity = window.identity;
        let generation = match self.windows.get(&identity.hwnd) {
            Some((previous, generation, _)) if *previous == identity => *generation,
            _ => {
                let generation = self.next()?;
                self.windows
                    .insert(identity.hwnd, (identity, generation, window.protected));
                generation
            }
        };
        window.target.generation = generation;
        window.target.validate()
    }

    pub(super) fn retain_windows(&mut self, present: &HashSet<usize>) {
        self.windows.retain(|hwnd, _| present.contains(hwnd));
    }

    pub(super) fn bind_monitors(&mut self, monitors: &mut [Monitor]) -> Result<()> {
        let present: HashSet<_> = monitors.iter().map(|monitor| monitor.handle).collect();
        self.monitors.retain(|handle, _| present.contains(handle));
        for monitor in monitors {
            monitor.target.generation = match self.monitors.get(&monitor.handle) {
                Some(previous)
                    if previous.device == monitor.device
                        && previous.target.bounds == monitor.target.bounds =>
                {
                    previous.target.generation
                }
                _ => self.next()?,
            };
            monitor.target.validate()?;
            self.monitors.insert(monitor.handle, monitor.clone());
        }
        Ok(())
    }

    pub(super) fn window_handle(&self, id: u32) -> Option<usize> {
        self.windows
            .keys()
            .copied()
            .find(|handle| *handle as u32 == id)
    }

    pub(super) fn protection(&self, id: u32, generation: u64) -> Option<bool> {
        let handle = self.window_handle(id)?;
        let (_, current, protected) = self.windows.get(&handle)?;
        (self.active && *current == generation).then_some(*protected)
    }

    fn has_window(&self, window: &Window) -> bool {
        self.active
            && self
                .windows
                .get(&window.identity.hwnd)
                .is_some_and(|(identity, generation, _)| {
                    *identity == window.identity && *generation == window.target.generation
                })
    }
}

pub(super) fn verify_window(registry: &Shared, window: &Window) -> Result<()> {
    if !lock(registry).has_window(window) {
        return Err(stale());
    }
    window.verify_identity()
}

pub(super) struct Hook {
    pub(super) registered: Shared,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Hook {
    pub(super) fn start() -> Result<Self> {
        let registered = Arc::new(Mutex::new(Registry::new()));
        let observing = registered.clone();
        let (started, ready) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("cantrip-win32-window-events".into())
            .spawn(move || {
                let mut message = MSG::default();
                unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE) };
                OBSERVED.with(|data| *data.borrow_mut() = Some(observing.clone()));
                let hook = unsafe {
                    SetWinEventHook(
                        EVENT_OBJECT_DESTROY,
                        EVENT_OBJECT_DESTROY,
                        null_mut(),
                        Some(window_destroyed),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT,
                    )
                };
                if hook.is_null() {
                    return;
                }
                lock(&observing).active = true;
                if started.send(unsafe { GetCurrentThreadId() }).is_ok() {
                    while unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } > 0 {
                        unsafe { DispatchMessageW(&message) };
                    }
                }
                lock(&observing).active = false;
                unsafe { UnhookWinEvent(hook) };
            })
            .map_err(|_| failure("Windows target observation could not start."))?;
        let thread_id = ready
            .recv()
            .map_err(|_| failure("Windows target observation is unavailable."))?;
        Ok(Self {
            registered,
            thread_id,
            thread: Some(thread),
        })
    }
}

impl Drop for Hook {
    fn drop(&mut self) {
        if unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) } != 0 {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

unsafe extern "system" fn window_destroyed(
    _: HWINEVENTHOOK,
    _: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if !hwnd.is_null() && object == OBJID_WINDOW && child == CHILDID_SELF as i32 {
        OBSERVED.with(|data| {
            if let Some(registry) = data.borrow().as_ref() {
                lock(registry).windows.remove(&(hwnd as usize));
            }
        });
    }
}
