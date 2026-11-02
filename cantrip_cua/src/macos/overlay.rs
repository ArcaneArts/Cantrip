//! Click-through desktop presentation. Main-thread AppKit only; no input posting.
use crate::target::{Bounds, Point, TargetKind};
use cantrip_interaction::presentation::{CursorPresentation, CursorRenderer, PresentationDelivery};
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::{
    msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSString;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ffi::c_void,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
pub(super) struct Window {
    pub id: u32,
    pub pid: u32,
    pub level: isize,
    pub bounds: Bounds,
}
pub(super) fn windows() -> Vec<Window> {
    read_windows(1 | 16, 0)
}
/// Include the exact window even when it is occluded or offscreen. Input must
/// not inherit the onscreen-only filtering used by the presentation renderer.
pub(super) fn window(id: u32) -> Option<Window> {
    read_windows(1 << 3, id)
        .into_iter()
        .find(|window| window.id == id)
}
fn read_windows(options: u32, relative: u32) -> Vec<Window> {
    unsafe {
        let array = CGWindowListCopyWindowInfo(options, relative);
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
pub(super) struct OverlayWindow {
    object: Retained<AnyObject>,
    pub id: u32,
}
impl std::ops::Deref for OverlayWindow {
    type Target = AnyObject;
    fn deref(&self) -> &AnyObject {
        &self.object
    }
}
impl Drop for OverlayWindow {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.object,orderOut:Option::<&AnyObject>::None];
        }
        unsafe {
            let _: () = msg_send![&*self.object, close];
        }
        forget_window(self.id);
    }
}
// Shared nonactivating window policy for effect and cursor panels.
pub(super) fn create_window() -> Option<OverlayWindow> {
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
        let number: isize = msg_send![&*window, windowNumber];
        if number <= 0 {
            super::diagnostic_phase("overlay-no-window-number");
        }
        let id = u32::try_from(number).ok().filter(|id| *id > 0)?;
        super::diagnostic_phase("overlay-panel-created");
        owned_ids().lock().unwrap().insert(id);
        Some(OverlayWindow { object: window, id })
    }
}
pub(super) fn forget_window(id: u32) {
    owned_ids().lock().unwrap().remove(&id);
}
pub(super) fn appkit_frame(bounds: Bounds) -> CGRect {
    let top = unsafe { CGDisplayBounds(CGMainDisplayID()).size.height };
    CGRect::new(
        CGPoint::new(bounds.x, top - bounds.y - bounds.height),
        CGSize::new(bounds.width, bounds.height),
    )
}
struct Panel {
    window: OverlayWindow,
    image_view: Retained<AnyObject>,
    rendered: String,
}
impl Panel {
    fn new() -> Option<Self> {
        unsafe {
            let window = create_window()?;
            let view_class = AnyClass::get(c"NSImageView")?;
            let allocated: Allocated<AnyObject> = msg_send![view_class, alloc];
            let image_view: Retained<AnyObject> = msg_send![allocated, initWithFrame: CGRect::ZERO];
            let _: () = msg_send![&*image_view, setImageScaling: 1_usize];
            let _: () = msg_send![&*window, setContentView: &*image_view];
            Some(Self {
                window,
                image_view,
                rendered: String::new(),
            })
        }
    }
    fn hide(&self) {
        unsafe {
            let _: () = msg_send![&*self.window, orderOut: Option::<&AnyObject>::None];
        }
    }
    fn update(
        &mut self,
        state: &CursorPresentation<crate::target::Target>,
        native: &Window,
        region: &Bounds,
    ) -> Option<()> {
        // Renderer preserves the same appearance/trail/action feedback as model images.
        let key = format!(
            "{}:{}:{}:{}:{:?}:{:?}:{}",
            native.id,
            state.cursor.revision,
            native.bounds.width,
            native.bounds.height,
            region,
            state.cursor.position,
            state.cursor.glow_strength()
        );
        if key != self.rendered {
            let image = cursor_image(state, &native.bounds, region)?;
            unsafe {
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
            let _: () = msg_send![&*self.window, orderWindow: 1_isize, relativeTo: super::window_effects::cursor_anchor(native.id) as isize];
            let _: () = msg_send![&*self.window, displayIfNeeded];
        }
        Some(())
    }
}
fn cursor_image(
    state: &CursorPresentation<crate::target::Target>,
    bounds: &Bounds,
    region: &Bounds,
) -> Option<Retained<AnyObject>> {
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
    // AppKit owns the bitmap storage. Copy straight-alpha RGBA directly rather
    // than PNG-encoding every tile only for NSImage to decode it on this thread.
    unsafe {
        let class = AnyClass::get(c"NSBitmapImageRep")?;
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        let color_space = NSString::from_str("NSDeviceRGBColorSpace");
        let bitmap: Option<Retained<AnyObject>> = msg_send![allocated,
            initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(),
            pixelsWide: width as isize, pixelsHigh: height as isize,
            bitsPerSample: 8_isize, samplesPerPixel: 4_isize,
            hasAlpha: true, isPlanar: false, colorSpaceName: &*color_space,
            bitmapFormat: 2_usize, bytesPerRow: (width * 4) as isize, bitsPerPixel: 32_isize];
        let bitmap = bitmap?;
        let data: *mut u8 = msg_send![&*bitmap, bitmapData];
        let stride: isize = msg_send![&*bitmap, bytesPerRow];
        let row_bytes = width as usize * 4;
        if data.is_null() || stride < row_bytes as isize {
            return None;
        }
        for row in 0..height as usize {
            std::ptr::copy_nonoverlapping(
                rgba.as_ptr().add(row * row_bytes),
                data.add(row * stride as usize),
                row_bytes,
            );
        }
        let class = AnyClass::get(c"NSImage")?;
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        let image: Option<Retained<AnyObject>> =
            msg_send![allocated, initWithSize: CGSize::new(region.width, region.height)];
        let image = image?;
        let _: () = msg_send![&*image, addRepresentation: &*bitmap];
        Some(image)
    }
}
#[derive(Default)]
struct Presentation {
    sessions: Vec<CursorPresentation<crate::target::Target>>,
    panels: HashMap<String, Vec<Panel>>,
    motion: HashMap<String, CursorMotion>,
    ticking: bool,
    animating: bool,
    tick_generation: u64,
}
const CURSOR_BLEND: Duration = Duration::from_millis(40);
struct CursorMotion {
    from: Point,
    to: Point,
    started: Instant,
}
impl CursorMotion {
    fn sample(&self, now: Instant) -> Point {
        let t = (now.saturating_duration_since(self.started).as_secs_f64()
            / CURSOR_BLEND.as_secs_f64())
        .clamp(0.0, 1.0);
        let t = 1.0 - (1.0 - t).powi(3);
        Point {
            x: self.from.x + (self.to.x - self.from.x) * t,
            y: self.from.y + (self.to.y - self.from.y) * t,
        }
    }
    fn active(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started) < CURSOR_BLEND
    }
}
struct Snapshot {
    sessions: Vec<CursorPresentation<crate::target::Target>>,
    progress: HashMap<String, crate::input_job::InputProgress>,
}
#[derive(Default)]
struct PendingPresentation {
    latest: Option<Snapshot>,
    scheduled: bool,
}
fn pending_presentation() -> &'static Mutex<PendingPresentation> {
    static PENDING: OnceLock<Mutex<PendingPresentation>> = OnceLock::new();
    PENDING.get_or_init(Mutex::default)
}
thread_local! { static PRESENTATION: RefCell<Presentation> = RefCell::default(); }
pub(super) fn present(sessions: Vec<CursorPresentation<crate::target::Target>>) {
    present_input_cursors(sessions, HashMap::new(), PresentationDelivery::Latest);
}
/// Called only by the native executor. Drain earlier main-queue updates and
/// render this travel frame before allowing the executor to post the click.
pub(super) fn present_step(sessions: Vec<CursorPresentation<crate::target::Target>>) {
    present_input_cursors(sessions, HashMap::new(), PresentationDelivery::BeforeInput);
}
/// Concurrent gestures can advance after the executor builds its complete
/// snapshot. Sample their latest state on the presentation queue so an unrelated
/// request cannot rewind a cursor or erase its click glow/trail.
pub(super) fn present_input_cursors(
    sessions: Vec<CursorPresentation<crate::target::Target>>,
    progress: HashMap<String, crate::input_job::InputProgress>,
    delivery: PresentationDelivery,
) {
    // Register owners before their native input notifications can arrive.
    // Rendering then advances their visible positions on the main queue.
    crate::effects::live::synchronize(&sessions);
    let snapshot = Snapshot { sessions, progress };
    match delivery {
        PresentationDelivery::Latest => {
            let mut pending = pending_presentation().lock().unwrap();
            pending.latest = Some(snapshot);
            if pending.scheduled {
                return;
            }
            pending.scheduled = true;
            drop(pending);
            // One queued callback samples the newest complete snapshot. Older
            // positions never accumulate as AppKit redraw work.
            DispatchQueue::main().exec_async(|| {
                let snapshot = {
                    let mut pending = pending_presentation().lock().unwrap();
                    pending.scheduled = false;
                    pending.latest.take()
                };
                if let Some(snapshot) = snapshot {
                    apply_snapshot(snapshot, false);
                }
            });
        }
        PresentationDelivery::BeforeInput => {
            pending_presentation().lock().unwrap().latest = None;
            DispatchQueue::main().exec_sync(move || apply_snapshot(snapshot, true));
        }
    }
}
fn apply_snapshot(mut snapshot: Snapshot, before_input: bool) {
    autoreleasepool(|_| {
        for state in &mut snapshot.sessions {
            if let Some(live) = snapshot.progress.get(&state.participant_id) {
                state.cursor = live.cursor();
            }
        }
        let first = PRESENTATION.with_borrow_mut(|p| {
            let now = Instant::now();
            for state in &snapshot.sessions {
                let previous = p.sessions.iter().find(|previous| {
                    previous.participant_id == state.participant_id
                        && previous
                            .target
                            .as_ref()
                            .zip(state.target.as_ref())
                            .is_some_and(|(a, b)| {
                                a.id == b.id
                                    && a.generation == b.generation
                                    && a.bounds.width == b.bounds.width
                                    && a.bounds.height == b.bounds.height
                            })
                });
                if before_input
                    || snapshot.progress.contains_key(&state.participant_id)
                    || previous.is_none()
                {
                    p.motion.remove(&state.participant_id);
                } else if previous.unwrap().cursor.position != state.cursor.position {
                    let from = p
                        .motion
                        .get(&state.participant_id)
                        .map_or(previous.unwrap().cursor.position, |motion| {
                            motion.sample(now)
                        });
                    p.motion.insert(
                        state.participant_id.clone(),
                        CursorMotion {
                            from,
                            to: state.cursor.position,
                            started: now,
                        },
                    );
                }
            }
            p.motion.retain(|id, _| {
                snapshot
                    .sessions
                    .iter()
                    .any(|state| &state.participant_id == id)
            });
            p.sessions = snapshot.sessions;
            let mut visible = p.sessions.clone();
            for state in &mut visible {
                if let Some(motion) = p.motion.get(&state.participant_id) {
                    state.cursor.position = motion.sample(now);
                }
            }
            crate::effects::live::synchronize(&visible);
            let first = !p.ticking;
            if first || !p.animating {
                p.ticking = true;
                p.animating = true;
                p.tick_generation = p.tick_generation.wrapping_add(1);
                schedule(true, p.tick_generation);
            }
            first
        });
        // Agent travel still has a synchronous presentation barrier before
        // input. Cosmetic remote positions use the shared animation clock.
        if first || before_input {
            refresh();
        }
    });
}
/// Update only the exact active attachment, without replacing other sessions.
pub(super) fn move_cursor(
    session: &str,
    target: &crate::target::Target,
    progress: crate::input_job::InputProgress,
    before_input: bool,
) {
    let session = session.to_owned();
    let target = target.clone();
    let update = move || {
        autoreleasepool(|_| {
            PRESENTATION.with_borrow_mut(|p| {
                if let Some(state) = p.sessions.iter_mut().find(|s| {
                    s.participant_id == session
                        && s.target
                            .as_ref()
                            .is_some_and(|t| t.id == target.id && t.generation == target.generation)
                }) {
                    // Another presentation may have consumed a newer point while
                    // this callback waited. Always sample the current state here.
                    let cursor = progress.cursor();
                    crate::effects::live::movement(&session, &target, cursor.position, false);
                    state.cursor = cursor;
                    p.motion.remove(&session);
                }
            });
            refresh();
        })
    };
    if before_input {
        // Visual travel arrives before the next native down. Actual input
        // notifications retain their asynchronous path.
        DispatchQueue::main().exec_sync(update);
    } else {
        DispatchQueue::main().exec_async(update);
    }
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn schedule(animating: bool, generation: u64) {
    let _ = DispatchQueue::main().after(
        DispatchTime::try_from(Duration::from_millis(if animating { 16 } else { 100 })).unwrap(),
        move || {
            autoreleasepool(|_| {
                if PRESENTATION.with_borrow(|p| p.tick_generation != generation) {
                    return;
                }
                refresh();
                PRESENTATION.with_borrow_mut(|p| {
                    if p.sessions.iter().any(|s| s.target.is_some()) {
                        p.animating = p
                            .motion
                            .values()
                            .any(|motion| motion.active(Instant::now()))
                            || p.sessions
                                .iter()
                                .any(|s| s.cursor.presentation(timestamp()).glow_strength() > 0);
                        schedule(p.animating, generation);
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
    refresh_with_windows(&windows);
}
pub(super) fn refresh_with_windows(windows: &[Window]) {
    PRESENTATION.with_borrow_mut(|p| {
        p.panels.retain(|id, _| {
            p.sessions.iter().any(|s| {
                &s.participant_id == id
                    && s.target
                        .as_ref()
                        .is_some_and(|t| t.kind == TargetKind::Window)
            })
        });
        for stored in &p.sessions {
            let mut displayed = stored.clone();
            displayed.cursor = stored.cursor.presentation(timestamp());
            if let Some(motion) = p.motion.get(&stored.participant_id) {
                displayed.cursor.position = motion.sample(Instant::now());
                if let Some(target) = &displayed.target {
                    crate::effects::live::movement(
                        &stored.participant_id,
                        target,
                        displayed.cursor.position,
                        false,
                    );
                }
            }
            let state = &displayed;
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
                if let Some(panels) = p.panels.get(&state.participant_id) {
                    for panel in panels {
                        panel.hide();
                    }
                }
                continue;
            }
            let native = native.unwrap();
            let panels = p.panels.entry(state.participant_id.clone()).or_default();
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

/// Native presentation adapter. It receives only cursor/target data, never agent authority.
/// Presents a complete snapshot of native cursor participants. Consumers share
/// one coordinator when combining adapters; omission removes that cursor panel.
pub struct MacOsCursorRenderer;
impl CursorRenderer<crate::target::Target> for MacOsCursorRenderer {
    fn present(
        &mut self,
        participants: Vec<CursorPresentation<crate::target::Target>>,
        delivery: PresentationDelivery,
    ) {
        match delivery {
            PresentationDelivery::Latest => present(participants),
            PresentationDelivery::BeforeInput => present_step(participants),
        }
    }
}
