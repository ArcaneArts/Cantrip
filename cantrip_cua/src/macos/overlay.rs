//! Click-through desktop presentation. Main-thread AppKit only; no input posting.
use crate::{
    service::SessionState,
    target::{Bounds, TargetKind},
};
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::{
    msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSData;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ffi::c_void,
    sync::{Mutex, OnceLock},
    time::Duration,
};

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}
type Ref = *const c_void;
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Ref;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: Ref, rect: *mut CGRect) -> u8;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    static kCGWindowNumber: Ref;
    static kCGWindowOwnerPID: Ref;
    static kCGWindowBounds: Ref;
    static kCGWindowLayer: Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Ref);
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFNumberGetValue(number: Ref, kind: isize, value: *mut c_void) -> u8;
}
fn owned_ids() -> &'static Mutex<HashSet<u32>> {
    static IDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    IDS.get_or_init(Mutex::default)
}
pub(super) fn owns(id: u32) -> bool {
    owned_ids().lock().unwrap().contains(&id)
}
struct Window {
    id: u32,
    pid: u32,
    level: isize,
    bounds: Bounds,
}
fn windows() -> Vec<Window> {
    unsafe {
        let array = CGWindowListCopyWindowInfo(1 | 16, 0);
        if array.is_null() {
            return vec![];
        }
        let mut result = vec![];
        let count = CFArrayGetCount(array);
        if (0..=4096).contains(&count) {
            for i in 0..count {
                let dictionary = CFArrayGetValueAtIndex(array, i);
                let number = |key| -> Option<i64> {
                    let raw = CFDictionaryGetValue(dictionary, key);
                    let mut value = 0_i64;
                    (!raw.is_null()
                        && CFNumberGetValue(raw, 4, (&mut value as *mut i64).cast()) != 0)
                        .then_some(value)
                };
                let Some(id) = number(kCGWindowNumber).and_then(|v| u32::try_from(v).ok()) else {
                    continue;
                };
                let Some(pid) = number(kCGWindowOwnerPID).and_then(|v| u32::try_from(v).ok())
                else {
                    continue;
                };
                let Some(level) = number(kCGWindowLayer).and_then(|v| isize::try_from(v).ok())
                else {
                    continue;
                };
                let raw = CFDictionaryGetValue(dictionary, kCGWindowBounds);
                let mut rect = CGRect::ZERO;
                if raw.is_null() || CGRectMakeWithDictionaryRepresentation(raw, &mut rect) == 0 {
                    continue;
                }
                let bounds = Bounds {
                    x: rect.origin.x,
                    y: rect.origin.y,
                    width: rect.size.width,
                    height: rect.size.height,
                };
                if bounds.validate().is_ok() {
                    result.push(Window {
                        id,
                        pid,
                        level,
                        bounds,
                    });
                }
            }
        }
        CFRelease(array);
        result
    }
}
struct Panel {
    window: Retained<AnyObject>,
    image_view: Retained<AnyObject>,
    id: u32,
    rendered: String,
}
impl Drop for Panel {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.window, orderOut: Option::<&AnyObject>::None];
        }
        owned_ids().lock().unwrap().remove(&self.id);
    }
}
impl Panel {
    fn new() -> Option<Self> {
        unsafe {
            let app_class = AnyClass::get(c"NSApplication")?;
            let app: Retained<AnyObject> = msg_send![app_class, sharedApplication];
            let _: bool = msg_send![&*app, setActivationPolicy: 1_isize]; // Accessory, never activate.
            let panel_class = AnyClass::get(c"NSPanel")?;
            let allocated: Allocated<AnyObject> = msg_send![panel_class, alloc];
            let window: Retained<AnyObject> = msg_send![allocated, initWithContentRect: CGRect::new(CGPoint::ZERO, CGSize::new(1.0,1.0)), styleMask: 128_usize, backing: 2_usize, defer: false];
            let _: () = msg_send![&*window, setReleasedWhenClosed: false];
            let _: () = msg_send![&*window, setOpaque: false];
            let _: () = msg_send![&*window, setHasShadow: false];
            let _: () = msg_send![&*window, setIgnoresMouseEvents: true];
            let _: () = msg_send![&*window, setHidesOnDeactivate: false];
            let _: () = msg_send![&*window, setBecomesKeyOnlyIfNeeded: true];
            let _: () = msg_send![&*window, setFloatingPanel: false];
            let _: () = msg_send![&*window, setCollectionBehavior: (1_usize | 16 | 64 | 256)];
            let _: () = msg_send![&*window, setSharingType: 1_usize];
            let color_class = AnyClass::get(c"NSColor")?;
            let color: Retained<AnyObject> = msg_send![color_class, clearColor];
            let _: () = msg_send![&*window, setBackgroundColor: &*color];
            let view_class = AnyClass::get(c"NSImageView")?;
            let allocated: Allocated<AnyObject> = msg_send![view_class, alloc];
            let image_view: Retained<AnyObject> = msg_send![allocated, initWithFrame: CGRect::ZERO];
            let _: () = msg_send![&*image_view, setImageScaling: 1_usize];
            let _: () = msg_send![&*window, setContentView: &*image_view];
            let number: isize = msg_send![&*window, windowNumber];
            if number <= 0 {
                super::diagnostic_phase("overlay-no-window-number");
            }
            let id = u32::try_from(number).ok().filter(|id| *id > 0)?;
            super::diagnostic_phase("overlay-panel-created");
            owned_ids().lock().unwrap().insert(id);
            Some(Self {
                window,
                image_view,
                id,
                rendered: String::new(),
            })
        }
    }
    fn hide(&self) {
        unsafe {
            let _: () = msg_send![&*self.window, orderOut: Option::<&AnyObject>::None];
        }
    }
    fn update(&mut self, state: &SessionState, native: &Window, region: &Bounds) -> Option<()> {
        // Renderer preserves the same appearance/trail/action feedback as model images.
        let key = format!(
            "{}:{}:{}:{}:{:?}",
            native.id, state.cursor.revision, native.bounds.width, native.bounds.height, region
        );
        if key != self.rendered {
            let bytes = cursor_png(state, &native.bounds, region)?;
            let data = NSData::with_bytes(&bytes);
            unsafe {
                let class = AnyClass::get(c"NSImage")?;
                let allocated: Allocated<AnyObject> = msg_send![class, alloc];
                let image: Option<Retained<AnyObject>> = msg_send![allocated, initWithData: &*data];
                let image = image?;
                let _: () = msg_send![&*image, setSize: CGSize::new(region.width, region.height)];
                let _: () = msg_send![&*self.image_view, setImage: &*image];
            }
            self.rendered = key;
        }
        unsafe {
            let top = CGDisplayBounds(CGMainDisplayID()).size.height;
            let frame = CGRect::new(
                CGPoint::new(
                    native.bounds.x + region.x,
                    top - native.bounds.y - region.y - region.height,
                ),
                CGSize::new(region.width, region.height),
            );
            let _: () = msg_send![&*self.window, setFrame: frame, display: true];
            let _: () =
                msg_send![&*self.image_view, setFrame: CGRect::new(CGPoint::ZERO,frame.size)];
            let _: () = msg_send![&*self.window, setLevel: native.level];
            // Order only this nonactivating panel; never order or raise the target.
            let _: () =
                msg_send![&*self.window, orderWindow: 1_isize, relativeTo: native.id as isize];
            let _: () = msg_send![&*self.window, displayIfNeeded];
        }
        Some(())
    }
}
fn cursor_png(state: &SessionState, bounds: &Bounds, region: &Bounds) -> Option<Vec<u8>> {
    let width = region.width.ceil() as u32;
    let height = region.height.ceil() as u32;
    let pixels = (width as usize).checked_mul(height as usize)?;
    if pixels == 0 || pixels > crate::target::MAX_IMAGE_PIXELS {
        return None;
    }
    let mut rgba = vec![0; pixels * 4];
    state
        .cursor
        .render_region(&mut rgba, width, height, bounds, region)
        .ok()?;
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
        writer.finish().ok()?;
    }
    Some(bytes)
}
#[derive(Default)]
struct Presentation {
    sessions: Vec<SessionState>,
    panels: HashMap<String, Vec<Panel>>,
    ticking: bool,
}
thread_local! { static PRESENTATION: RefCell<Presentation> = RefCell::default(); }
pub(super) fn present(sessions: Vec<SessionState>) {
    // Only plain owned data crosses the executor/main-queue boundary.
    DispatchQueue::main().exec_async(move || {
        autoreleasepool(|_| {
            PRESENTATION.with_borrow_mut(|presentation| {
                presentation.sessions = sessions;
                if !presentation.ticking {
                    presentation.ticking = true;
                    schedule();
                }
            });
            refresh();
        })
    });
}
/// Update only the exact active attachment, without replacing other sessions.
pub(super) fn move_cursor(
    session: &str,
    target: &crate::target::Target,
    point: crate::target::Point,
) {
    let session = session.to_owned();
    let target = target.clone();
    DispatchQueue::main().exec_async(move || {
        autoreleasepool(|_| {
            PRESENTATION.with_borrow_mut(|p| {
                if let Some(state) = p.sessions.iter_mut().find(|s| {
                    s.binding.session_id == session
                        && s.target
                            .as_ref()
                            .is_some_and(|t| t.id == target.id && t.generation == target.generation)
                }) {
                    let now = state.cursor.updated_at_ms.saturating_add(1);
                    let _ = state.cursor.move_to(point, &target.bounds, now);
                    state.cursor.mark_action("background-drag", "unknown", now);
                }
            });
            refresh();
        })
    });
}
fn schedule() {
    let _ = DispatchQueue::main().after(
        DispatchTime::try_from(Duration::from_millis(100)).unwrap(),
        || {
            autoreleasepool(|_| {
                refresh();
                PRESENTATION.with_borrow_mut(|p| {
                    if p.sessions.iter().any(|s| s.target.is_some()) {
                        schedule();
                    } else {
                        p.ticking = false;
                    }
                });
            })
        },
    );
}
fn refresh() {
    let windows = windows();
    PRESENTATION.with_borrow_mut(|p| {
        p.panels.retain(|id, _| {
            p.sessions.iter().any(|s| {
                &s.binding.session_id == id
                    && s.target
                        .as_ref()
                        .is_some_and(|t| t.kind == TargetKind::Window)
            })
        });
        for state in &p.sessions {
            let Some(target) = state
                .target
                .as_ref()
                .filter(|t| t.kind == TargetKind::Window)
            else {
                continue;
            };
            let native = windows.iter().find(|w| {
                target.id == format!("macos-window-{}", w.id) && target.process_id == Some(w.pid)
            });
            if !state.cursor.appearance.visible
                || native.is_none()
                || !native.unwrap().bounds.contains_local(state.cursor.position)
            {
                if let Some(panels) = p.panels.get(&state.binding.session_id) {
                    for panel in panels {
                        panel.hide();
                    }
                }
                continue;
            }
            let native = native.unwrap();
            let panels = p
                .panels
                .entry(state.binding.session_id.clone())
                .or_default();
            let Ok(regions) = state.cursor.desktop_tiles(&native.bounds) else {
                for panel in panels {
                    panel.hide();
                }
                continue;
            };
            panels.truncate(regions.len());
            while panels.len() < regions.len() {
                let Some(panel) = Panel::new() else { break };
                panels.push(panel);
            }
            for (panel, region) in panels.iter_mut().zip(&regions) {
                if panel.update(state, native, region).is_none() {
                    panel.hide();
                }
            }
        }
    });
}
