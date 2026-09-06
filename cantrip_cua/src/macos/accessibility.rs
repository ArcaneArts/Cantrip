//! Public AX API only. All owned CF references remain on the native executor.
//! Match a unique application window by its current screen rectangle. Ambiguous
//! rectangles are rejected; we never choose another window from the same app.
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    input::{Control, Controls, InputReceipt},
    target::{Bounds, Target, TargetKind},
};
use std::{
    collections::{HashMap, VecDeque},
    ffi::c_void,
    ptr,
    time::{Duration, Instant},
};
type Ref = *const c_void;
#[repr(C)]
#[derive(Default)]
struct Pair {
    x: f64,
    y: f64,
}
#[repr(C)]
struct Range {
    location: isize,
    length: isize,
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementCreateSystemWide() -> Ref;
    fn AXUIElementCopyElementAtPosition(element: Ref, x: f32, y: f32, result: *mut Ref) -> i32;
    fn AXUIElementSetAttributeValue(element: Ref, attribute: Ref, value: Ref) -> i32;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, value: *mut Ref) -> i32;
    fn AXUIElementGetAttributeValueCount(element: Ref, attribute: Ref, count: *mut isize) -> i32;
    fn AXUIElementCopyAttributeValues(
        element: Ref,
        attribute: Ref,
        index: isize,
        count: isize,
        value: *mut Ref,
    ) -> i32;
    fn AXUIElementCopyActionNames(element: Ref, value: *mut Ref) -> i32;
    fn AXUIElementPerformAction(element: Ref, action: Ref) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Ref, seconds: f32) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetValue(value: Ref, kind: u32, result: *mut c_void) -> u8;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: Ref;
    fn CFRelease(value: Ref);
    fn CFRetain(value: Ref) -> Ref;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFEqual(left: Ref, right: Ref) -> u8;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithBytes(
        allocator: Ref,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> Ref;
    fn CFStringGetLength(value: Ref) -> isize;
    fn CFStringGetCharacters(value: Ref, range: Range, buffer: *mut u16);
}
struct Owned(Ref);
// SAFETY: AX/CF references have no main-thread affinity. Only the single native
// executor accesses these references; there is no Sync implementation.
unsafe impl Send for Owned {}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
impl Owned {
    fn take(value: Ref) -> Result<Self> {
        if value.is_null() {
            Err(CuaError::new(
                ErrorCode::InputFailed,
                "Native Accessibility returned no value.",
            ))
        } else {
            Ok(Self(value))
        }
    }
    fn string(value: &str) -> Self {
        Self::take(unsafe {
            CFStringCreateWithBytes(
                ptr::null(),
                value.as_ptr(),
                value.len() as isize,
                0x08000100,
                0,
            )
        })
        .expect("CFString allocation")
    }
    fn is(&self, kind: usize) -> bool {
        unsafe { CFGetTypeID(self.0) == kind }
    }
    fn same(&self, other: &Self) -> bool {
        unsafe { CFEqual(self.0, other.0) != 0 }
    }
    fn attr(&self, name: &str) -> Result<Self> {
        let key = Self::string(name);
        let mut value = ptr::null();
        read_result(unsafe { AXUIElementCopyAttributeValue(self.0, key.0, &mut value) })?;
        Self::take(value)
    }
    fn text(&self, limit: usize) -> Option<String> {
        if !self.is(unsafe { CFStringGetTypeID() }) {
            return None;
        }
        let length = unsafe { CFStringGetLength(self.0) }.clamp(0, limit as isize);
        let mut buffer = vec![0; length as usize];
        unsafe {
            CFStringGetCharacters(
                self.0,
                Range {
                    location: 0,
                    length,
                },
                buffer.as_mut_ptr(),
            );
        }
        Some(
            String::from_utf16_lossy(&buffer)
                .chars()
                .filter(|c| !c.is_control())
                .take(limit)
                .collect(),
        )
    }
    fn array(&self, maximum: usize) -> Result<Vec<Self>> {
        if !self.is(unsafe { CFArrayGetTypeID() }) {
            return Err(CuaError::new(
                ErrorCode::InputFailed,
                "Invalid AX collection.",
            ));
        }
        let count = unsafe { CFArrayGetCount(self.0) }.clamp(0, maximum as isize);
        (0..count)
            .map(|i| Self::take(unsafe { CFRetain(CFArrayGetValueAtIndex(self.0, i)) }))
            .collect()
    }
    fn children(&self, name: &str, maximum: usize) -> Result<(Vec<Self>, bool)> {
        let key = Self::string(name);
        let mut count = 0;
        read_result(unsafe { AXUIElementGetAttributeValueCount(self.0, key.0, &mut count) })?;
        if count <= 0 {
            return Ok((vec![], false));
        }
        let mut value = ptr::null();
        read_result(unsafe {
            AXUIElementCopyAttributeValues(
                self.0,
                key.0,
                0,
                count.min(maximum as isize),
                &mut value,
            )
        })?;
        Ok((Self::take(value)?.array(maximum)?, count > maximum as isize))
    }
    fn rect(&self) -> Result<Bounds> {
        let position = self.attr("AXPosition")?;
        let size = self.attr("AXSize")?;
        if !position.is(unsafe { AXValueGetTypeID() }) || !size.is(unsafe { AXValueGetTypeID() }) {
            return Err(stale());
        }
        let mut p = Pair::default();
        let mut s = Pair::default();
        if unsafe {
            AXValueGetValue(position.0, 1, (&mut p as *mut Pair).cast()) == 0
                || AXValueGetValue(size.0, 2, (&mut s as *mut Pair).cast()) == 0
        } {
            return Err(stale());
        }
        let bounds = Bounds {
            x: p.x,
            y: p.y,
            width: s.x,
            height: s.y,
        };
        bounds.validate()?;
        Ok(bounds)
    }
    fn pressable(&self) -> Result<bool> {
        let mut actions = ptr::null();
        read_result(unsafe { AXUIElementCopyActionNames(self.0, &mut actions) })?;
        Ok(Self::take(actions)?
            .array(32)?
            .iter()
            .any(|action| action.text(64).as_deref() == Some("AXPress")))
    }
}
fn stale() -> CuaError {
    CuaError::new(
        ErrorCode::StaleElement,
        "Accessibility reference is stale; inspect controls again.",
    )
}
fn read_result(code: i32) -> Result<()> {
    if code == 0 {
        return Ok(());
    }
    Err(CuaError::new(
        match code {
            -25202 => ErrorCode::StaleElement,
            -25205 | -25206 | -25208 | -25212 => ErrorCode::Unsupported,
            -25211 => ErrorCode::PermissionDenied,
            _ => ErrorCode::InputFailed,
        },
        "Accessibility request failed.",
    ))
}
fn same_rect(a: Bounds, b: Bounds) -> bool {
    [
        (a.x, b.x),
        (a.y, b.y),
        (a.width, b.width),
        (a.height, b.height),
    ]
    .iter()
    .all(|(x, y)| (x - y).abs() < 1.0)
}
struct Entry {
    target: Target,
    window: Owned,
    elements: HashMap<String, Owned>,
}
#[derive(Default)]
pub(super) struct Accessibility {
    sessions: HashMap<String, Entry>,
    sequence: u64,
}
impl Accessibility {
    pub(super) fn clear(&mut self, session: &str) {
        self.sessions.remove(session);
    }
    fn window(target: &Target, cancel: &Cancellation) -> Result<Owned> {
        cancel.check()?;
        if target.kind != TargetKind::Window {
            return Err(CuaError::new(
                ErrorCode::Unsupported,
                "Accessibility requires an attached application window.",
            ));
        }
        let pid = target
            .process_id
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or_else(stale)?;
        let app = Owned::take(unsafe { AXUIElementCreateApplication(pid) })?;
        read_result(unsafe { AXUIElementSetMessagingTimeout(app.0, 0.2) })?;
        let (windows, truncated) = app.children("AXWindows", 128)?;
        if truncated {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "Application window inspection limit reached.",
            ));
        }
        let mut matched = None;
        let deadline = Instant::now() + Duration::from_secs(3);
        for window in windows {
            cancel.check()?;
            if Instant::now() > deadline {
                return Err(CuaError::new(
                    ErrorCode::Capacity,
                    "Accessibility inspection deadline reached.",
                ));
            }
            if !window.is(unsafe { AXUIElementGetTypeID() }) {
                continue;
            }
            read_result(unsafe { AXUIElementSetMessagingTimeout(window.0, 0.2) })?;
            if window
                .rect()
                .is_ok_and(|bounds| same_rect(bounds, target.bounds))
                && target.title.as_ref().is_none_or(|title| {
                    window
                        .attr("AXTitle")
                        .ok()
                        .and_then(|v| v.text(4096))
                        .as_ref()
                        == Some(title)
                })
            {
                if matched.is_some() {
                    return Err(CuaError::new(
                        ErrorCode::Unsupported,
                        "Multiple Accessibility windows match the attached target.",
                    ));
                }
                matched = Some(window);
            }
        }
        matched.ok_or_else(stale)
    }
    pub(super) fn inspect(
        &mut self,
        session: &str,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<Controls> {
        self.inspect_inner(session, target, cancel, None)
    }
    fn inspect_inner(
        &mut self,
        session: &str,
        target: &Target,
        cancel: &Cancellation,
        point: Option<crate::target::Point>,
    ) -> Result<Controls> {
        self.clear(session);
        let window = Self::window(target, cancel)?;
        let node_limit = if point.is_some() { 512 } else { 128 };
        let child_limit = if point.is_some() { 128 } else { 32 };
        let depth_limit = if point.is_some() { 24 } else { 12 };
        let mut pending = VecDeque::from([(Owned::take(unsafe { CFRetain(window.0) })?, 0)]);
        let mut controls = vec![];
        let mut elements = HashMap::new();
        let mut visited = 0;
        let mut truncated = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while let Some((element, depth)) = pending.pop_front() {
            cancel.check()?;
            if visited >= node_limit || controls.len() >= 32 || Instant::now() > deadline {
                truncated = true;
                break;
            }
            visited += 1;
            if !element.is(unsafe { AXUIElementGetTypeID() }) {
                continue;
            }
            read_result(unsafe { AXUIElementSetMessagingTimeout(element.0, 0.2) })?;
            let role = element
                .attr("AXRole")
                .ok()
                .and_then(|v| v.text(64))
                .unwrap_or_else(|| "AXUnknown".into());
            let secure = role == "AXSecureTextField"
                || element
                    .attr("AXSubrole")
                    .ok()
                    .and_then(|v| v.text(64))
                    .as_deref()
                    == Some("AXSecureTextField");
            // Never request AXValue, text content, or descend into secure input.
            if secure {
                continue;
            }
            // Resolve within the selected window, pruning known off-point
            // branches instead of using z-order-dependent desktop hit testing.
            if let Some(point) = point
                && let Ok(bounds) = element.rect()
            {
                let local = crate::target::Point {
                    x: point.x + target.bounds.x - bounds.x,
                    y: point.y + target.bounds.y - bounds.y,
                };
                if !bounds.contains_local(local) {
                    continue;
                }
            }
            if depth < depth_limit {
                let children =
                    element.children("AXChildren", (node_limit - visited).min(child_limit));
                if let Err(error) = &children
                    && point.is_some()
                    && error.code != ErrorCode::Unsupported
                {
                    return Err(error.clone());
                }
                if let Ok((children, more)) = children {
                    truncated |= more;
                    for child in children {
                        if pending.len() < node_limit {
                            pending.push_back((child, depth + 1));
                        } else {
                            truncated = true;
                        }
                    }
                }
            } else {
                truncated = true;
            }
            if !element.pressable().unwrap_or(false) {
                continue;
            }
            // Only references with an authoritative link to this exact window
            // are exposed, so a later press can revalidate ownership.
            if !element
                .attr("AXWindow")
                .is_ok_and(|owner| owner.same(&window))
            {
                continue;
            }
            let bounds = element.rect().ok().map(|b| Bounds {
                x: b.x - target.bounds.x,
                y: b.y - target.bounds.y,
                ..b
            });
            let label = element
                .attr("AXTitle")
                .ok()
                .and_then(|v| v.text(160))
                .filter(|v| !v.is_empty())
                .or_else(|| element.attr("AXDescription").ok().and_then(|v| v.text(160)));
            self.sequence = self.sequence.checked_add(1).ok_or_else(|| {
                CuaError::new(
                    ErrorCode::Capacity,
                    "Accessibility reference sequence exhausted.",
                )
            })?;
            let reference = format!("control-{}", self.sequence);
            controls.push(Control {
                reference: reference.clone(),
                role,
                label,
                bounds,
                actions: vec!["press"],
            });
            elements.insert(reference, element);
        }
        cancel.check()?;
        self.sessions.insert(
            session.into(),
            Entry {
                target: target.clone(),
                window,
                elements,
            },
        );
        Ok(Controls {
            controls,
            truncated,
        })
    }
    pub(super) fn press_at(
        &mut self,
        session: &str,
        target: &Target,
        position: crate::target::Point,
        cancel: &Cancellation,
    ) -> Result<(Target, InputReceipt)> {
        target.bounds.to_global(position)?;
        let inspection = self.inspect_inner(session, target, cancel, Some(position))?;
        let reference = match crate::input::control_at(&inspection, position) {
            Ok(reference) => reference.to_owned(),
            Err(error) => {
                self.clear(session);
                return Err(error);
            }
        };
        let receipt = self.press_inner(session, target, &reference, cancel, Some(position))?;
        Ok((target.clone(), receipt))
    }
    pub(super) fn press(
        &mut self,
        session: &str,
        target: &Target,
        reference: &str,
        cancel: &Cancellation,
    ) -> Result<InputReceipt> {
        self.press_inner(session, target, reference, cancel, None)
    }
    fn press_inner(
        &mut self,
        session: &str,
        target: &Target,
        reference: &str,
        cancel: &Cancellation,
        expected_point: Option<crate::target::Point>,
    ) -> Result<InputReceipt> {
        // Consume the inspection before sending an action. Even an uncertain
        // outcome cannot reuse a reference to retry the same press.
        let entry = self.sessions.remove(session).ok_or_else(stale)?;
        if entry.target.id != target.id || entry.target.generation != target.generation {
            return Err(stale());
        }
        let element = entry.elements.get(reference).ok_or_else(stale)?;
        let current = Self::window(target, cancel)?;
        if !entry.window.same(&current) || !element.attr("AXWindow")?.same(&current) {
            return Err(stale());
        }
        if !element.pressable()? {
            return Err(CuaError::new(
                ErrorCode::Unsupported,
                "This control does not advertise press.",
            ));
        }
        let bounds = element.rect();
        if let Some(point) = expected_point {
            let bounds = bounds.as_ref().map_err(Clone::clone)?;
            let local = crate::target::Point {
                x: point.x + target.bounds.x - bounds.x,
                y: point.y + target.bounds.y - bounds.y,
            };
            if !bounds.contains_local(local) {
                return Err(stale());
            }
        }
        let position = expected_point.or_else(|| {
            bounds.ok().and_then(|bounds| {
                let point = crate::target::Point {
                    x: bounds.x + bounds.width / 2.0 - target.bounds.x,
                    y: bounds.y + bounds.height / 2.0 - target.bounds.y,
                };
                target.bounds.contains_local(point).then_some(point)
            })
        });
        cancel.check()?;
        let action = Owned::string("AXPress");
        let code = unsafe { AXUIElementPerformAction(element.0, action.0) };
        // Any failure not guaranteed to reject the action is ambiguous.
        if code != 0 {
            if matches!(code, -25202 | -25206 | -25208 | -25211) {
                read_result(code)?;
            }
            return Err(CuaError::new(
                ErrorCode::InputUnknown,
                "Accessibility press outcome is unknown; do not retry or fall back. Take a fresh snapshot.",
            ));
        }
        Ok(InputReceipt {
            method: "accessibility",
            activation: false,
            outcome: "dispatched",
            position,
            global_position: position.and_then(|p| target.bounds.to_global(p).ok()),
        })
    }
}

/// Actual activation plus target hit-testing, not a cached permission/readiness
/// gate. Check the live window again after activation may have moved it.
pub(super) fn activate_for_click(
    target: &Target,
    point: crate::target::Point,
    cancel: &Cancellation,
) -> Result<Bounds> {
    let window = Accessibility::window(target, cancel)?;
    let pid = target
        .process_id
        .and_then(|pid| i32::try_from(pid).ok())
        .ok_or_else(stale)?;
    let app = Owned::take(unsafe { AXUIElementCreateApplication(pid) })?;
    read_result(unsafe { AXUIElementSetMessagingTimeout(app.0, 0.2) })?;
    let frontmost = Owned::string("AXFrontmost");
    cancel.check()?;
    read_result(unsafe { AXUIElementSetAttributeValue(app.0, frontmost.0, kCFBooleanTrue) })?;
    cancel.check()?;
    let raise = Owned::string("AXRaise");
    read_result(unsafe { AXUIElementPerformAction(window.0, raise.0) })?;
    let system = Owned::take(unsafe { AXUIElementCreateSystemWide() })?;
    read_result(unsafe { AXUIElementSetMessagingTimeout(system.0, 0.2) })?;
    let deadline = Instant::now() + Duration::from_millis(600);
    loop {
        cancel.check()?;
        let bounds = window.rect()?;
        let global = bounds.to_global(point)?;
        let mut value = ptr::null();
        read_result(unsafe {
            AXUIElementCopyElementAtPosition(system.0, global.x as f32, global.y as f32, &mut value)
        })?;
        let hit = Owned::take(value)?;
        let owns_point =
            hit.same(&window) || hit.attr("AXWindow").is_ok_and(|owner| owner.same(&window));
        let is_frontmost = app
            .attr("AXFrontmost")
            .is_ok_and(|value| unsafe { CFEqual(value.0, kCFBooleanTrue) != 0 });
        if owns_point && is_frontmost {
            return Ok(bounds);
        }
        if Instant::now() >= deadline {
            return Err(CuaError::new(
                ErrorCode::InputFailed,
                "Activated target does not own the click position; no click was posted.",
            ));
        }
        cancel.wait_cancelled(Duration::from_millis(20));
    }
}
